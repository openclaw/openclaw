// Gateway node-event subscription that evaluates armed location intents.
//
// The gateway validates `location.update` payloads before delivery, so the
// consumer receives typed local coordinates only. One fix fans out over the
// configured agents and each fired one-shot intent enqueues exactly one
// routed system event; a failed fire is logged and retried on the next fix
// because the committed fire state advances only on success.
import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { sendNodeIntentAlert } from "openclaw/plugin-sdk/node-push-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import type { LocationFireResult } from "./standing-intents-model.js";

/** Validated `location.update` payload delivered by the gateway router. */
type LocationUpdatePayload = {
  lat: number;
  lon: number;
  accuracyMeters: number;
  source: string;
};

type PendingFix = { lat: number; lon: number; accuracyMeters: number; source: string };

/** Per-node evaluation state: draining node ids and their ordered fix queues. */
type InFlightState = { active: Set<string>; pending: Map<string, PendingFix[]> };

const inFlight = resolveGlobalSingleton<InFlightState>(
  Symbol.for("openclaw.memoryCore.locationIntentFires"),
  () => ({ active: new Set<string>(), pending: new Map<string, PendingFix[]>() }),
);

/** Resolves once every in-flight and queued consumer fire pass has settled (tests use this). */
export async function settleLocationIntentFiresForTest(): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const draining = inFlight.active.size > 0;
    const queued = [...inFlight.pending.values()].some((queue) => queue.length > 0);
    if (!draining && !queued) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `location intent fires still in flight for: ${[...inFlight.active].join(", ")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Registers the plugin-owned `location.update` consumer. Fire passes are
 * sequential per node: while one fix is being evaluated, later fixes for that
 * node are coalesced into an ordered per-node queue (identical consecutive
 * fixes collapse to one entry) and drained in order when the in-flight pass
 * completes. A distinct fix is never discarded — an exit crossing that
 * arrives while the inside baseline is still evaluating is evaluated next,
 * not lost. Each armed row still transitions atomically at most once.
 */
export function registerLocationIntentConsumer(api: OpenClawPluginApi): void {
  api.registerNodeEventConsumer({
    events: ["location.update"],
    handle: ({ nodeId, payload }) => {
      // The gateway router already validated this payload against
      // NodeLocationUpdatePayloadSchema; narrow locally for typing only.
      const fix = payload as LocationUpdatePayload;
      const queue = inFlight.pending.get(nodeId) ?? [];
      const last = queue.at(-1);
      if (
        last &&
        last.lat === fix.lat &&
        last.lon === fix.lon &&
        last.accuracyMeters === fix.accuracyMeters &&
        last.source === fix.source
      ) {
        // Identical consecutive fix: already queued, nothing to add.
        if (inFlight.active.has(nodeId)) {
          return;
        }
      } else {
        queue.push({
          lat: fix.lat,
          lon: fix.lon,
          accuracyMeters: fix.accuracyMeters,
          source: fix.source,
        });
      }
      inFlight.pending.set(nodeId, queue);
      if (inFlight.active.has(nodeId)) {
        return; // The draining pass picks the queue up on completion.
      }
      void drainNode(api, nodeId);
    },
  });
}

/** Drains a node's queued fixes one at a time; each fix is fully evaluated before the next. */
async function drainNode(api: OpenClawPluginApi, nodeId: string): Promise<void> {
  inFlight.active.add(nodeId);
  try {
    for (;;) {
      const queue = inFlight.pending.get(nodeId);
      const next = queue?.shift();
      if (!next) {
        if (queue) {
          inFlight.pending.delete(nodeId);
        }
        return;
      }
      if (queue.length === 0) {
        inFlight.pending.delete(nodeId);
      }
      await evaluateFix(api, nodeId, next);
    }
  } finally {
    inFlight.active.delete(nodeId);
    // A fix may have arrived between the last shift and this finally; restart.
    if ((inFlight.pending.get(nodeId)?.length ?? 0) > 0 && !inFlight.active.has(nodeId)) {
      void drainNode(api, nodeId);
    }
  }
}

async function evaluateFix(
  api: OpenClawPluginApi,
  nodeId: string,
  payload: { lat: number; lon: number; accuracyMeters: number },
): Promise<void> {
  try {
    const config = api.runtime.config?.current?.() ?? api.config;
    const agentIds = listAgentIds(config as never);
    const module = await import("./standing-intents.js");
    for (const agentId of agentIds) {
      let outcome: LocationFireResult;
      try {
        outcome = await module.fireLocationIntentsForNode({
          agentId,
          nodeId,
          lat: payload.lat,
          lon: payload.lon,
          accuracyMeters: payload.accuracyMeters,
        });
      } catch (error) {
        api.logger.warn(
          `memory-core: location intent evaluation failed for agent ${agentId}: ${String(error)}`,
        );
        continue;
      }
      for (const intent of outcome.fired) {
        const target = intent.deliveryTarget;
        if (!target) {
          continue;
        }
        // The queued record is an in-session reminder for the next turn. It
        // must NOT embed the fix coordinates: the routed queue drains into
        // ordinary reply preparation, so any coordinates here would send
        // precise device location to the configured model — beyond the
        // purpose the user consented to when arming the fence. The alert and
        // the queue record both carry the intent description only.
        const firedText = `Standing intent fired: ${intent.description}`;
        const enqueued = enqueueRoutedSystemEvent(firedText, { agentId, sessionKey: target });
        // A failed wake stays visible; the one-shot row remains done, so the
        // miss is not silently retried into a duplicate delivery later.
        if (!enqueued) {
          api.logger.warn(
            `memory-core: location intent ${intent.id} fired for agent ${agentId} but the ${target} queue refused delivery`,
          );
        }
        // Event-driven notification: push the alert directly to the node's
        // APNs registration so delivery does not depend on the target
        // session's next turn (heartbeat or user activity).
        try {
          const result = await sendNodeIntentAlert({
            nodeId,
            title: "Standing intent fired",
            body: intent.description,
          });
          if (result.attempted && !result.ok) {
            api.logger.warn(
              `memory-core: location intent ${intent.id} APNs push failed (status ${String(result.status)}): ${String(result.reason ?? "unknown")}`,
            );
          } else if (!result.attempted && result.error) {
            api.logger.info?.(
              `memory-core: location intent ${intent.id} APNs push skipped: ${result.error}`,
            );
          }
        } catch (error) {
          api.logger.warn(
            `memory-core: location intent ${intent.id} APNs push error: ${String(error)}`,
          );
        }
      }
    }
  } catch (error) {
    api.logger.warn(`memory-core: location intent consumer failed: ${String(error)}`);
  }
}
