import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions.js";
import { retainPreparedSessionSharingFacts } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  projectSessionSharingEntry,
  type SessionSharingEntry,
} from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { prepareSessionGenerationFacts } from "../../config/sessions/session-delivery-generation.js";
import { withSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import {
  deliveryContextKey,
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";

export function resolveRestartRecoveryDeliveryContext(params: {
  cfg?: OpenClawConfig;
  entry: Pick<
    SessionEntry,
    | "sessionId"
    | "updatedAt"
    | "restartRecoveryDeliveryContext"
    | "restartRecoveryDeliveryRunId"
    | "delivery"
    | "sendPolicy"
    | "chatType"
  > & {
    pendingFinalDelivery?: Pick<NonNullable<SessionEntry["pendingFinalDelivery"]>, "context">;
    pendingFinalDeliveryContext?: DeliveryContext;
  };
  includeSessionDeliveryFallback?: boolean;
  sessionKey: string;
}): (DeliveryContext & { channel: string; to: string }) | undefined {
  const activeRunDeliveryContext = normalizeDeliveryContext(
    params.entry.restartRecoveryDeliveryContext,
  );
  // A claim with no context is intentionally transcript-only. Only legacy
  // rows without a claim may fall back to the session delivery route.
  const hasActiveRunDeliveryClaim =
    normalizeOptionalString(params.entry.restartRecoveryDeliveryRunId) !== undefined;
  const deliveryContext =
    normalizeDeliveryContext(
      params.entry.pendingFinalDelivery?.context ?? params.entry.pendingFinalDeliveryContext,
    ) ??
    activeRunDeliveryContext ??
    (params.includeSessionDeliveryFallback && !hasActiveRunDeliveryClaim
      ? deliveryContextFromSession(params.entry)
      : undefined);
  const channel = normalizeOptionalString(deliveryContext?.channel);
  const to = normalizeOptionalString(deliveryContext?.to);
  if (!channel || !to || !isDeliverableMessageChannel(channel)) {
    return undefined;
  }
  if (
    params.cfg &&
    resolveSendPolicy({
      cfg: params.cfg,
      entry: { ...params.entry, pendingFinalDelivery: undefined },
      sessionKey: params.sessionKey,
      channel,
      chatType: params.entry.chatType,
    }) === "deny"
  ) {
    return undefined;
  }
  return { ...deliveryContext, channel, to };
}

type RestartRecoveryDeliveryScope = MainSessionRecoveryStoreTarget & {
  sessionId: string;
  recoveryRunId: string;
  lifecycleGeneration: string;
  deliveryContext: DeliveryContext & { channel: string; to: string };
  cfg?: OpenClawConfig;
  shouldContinue?: () => boolean;
  readCurrent: () => SessionSharingEntry | undefined;
};

/** Delivery keeps published row facts and physical generation beyond the admission reader frame. */
export async function prepareRestartRecoveryDeliveryFacts(
  params: MainSessionRecoveryStoreTarget & {
    agentId: string;
    sessionId: string;
    lifecycleRevision?: string;
  },
) {
  let releasePrepared: (() => void) | undefined;
  try {
    return await withSessionEntriesFromStoreInWorker(
      { ...params, sessionKeys: [params.sessionKey], projection: "sharing" },
      async (read) => {
        const entry = read.result.entries.find(
          ({ sessionKey }) => sessionKey === params.sessionKey,
        )?.entry;
        const sharing = read.result.sharing;
        if (!entry || !sharing) {
          throw new Error("Restart recovery delivery facts are unavailable");
        }
        const facts = retainPreparedSessionSharingFacts({
          databaseIdentity: sharing.databaseIdentity,
          sessionKey: params.sessionKey,
          entry: projectSessionSharingEntry(entry),
          membership: new Set(),
        });
        try {
          const generation = await prepareSessionGenerationFacts({
            ...params,
            lifecycleRevision: params.lifecycleRevision ?? null,
          });
          try {
            read.assertCurrent();
            generation.assertCurrent();
            releasePrepared = () => {
              try {
                facts.release();
              } finally {
                generation.release();
              }
            };
            return {
              readCurrent: () => {
                try {
                  generation.assertCurrent();
                  return facts.readCurrent()?.entry;
                } catch {
                  return undefined;
                }
              },
              release: releasePrepared,
            };
          } catch (error) {
            generation.release();
            throw error;
          }
        } catch (error) {
          facts.release();
          throw error;
        }
      },
    );
  } catch (error) {
    try {
      releasePrepared?.();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Restart recovery delivery preparation and cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

/** Recheck the owning recovery, not a remembered route, at each delivery boundary. */
export function isRestartRecoveryDeliveryCurrent(params: RestartRecoveryDeliveryScope): boolean {
  if (
    params.shouldContinue?.() === false ||
    getAgentEventLifecycleGeneration() !== params.lifecycleGeneration
  ) {
    return false;
  }
  const current = params.readCurrent();
  return (
    current?.sessionId === params.sessionId &&
    current.abortedLastRun !== true &&
    current.restartRecoveryDeliveryRunId === params.recoveryRunId &&
    // A retained route is not permission for an automatic resumption notice.
    current.restartRecoverySourceReplyDeliveryMode !== "message_tool_only" &&
    deliveryContextKey(
      resolveRestartRecoveryDeliveryContext({
        cfg: params.cfg,
        entry: current,
        sessionKey: params.sessionKey,
      }),
    ) === deliveryContextKey(params.deliveryContext)
  );
}

export async function announceRestartRecoveryResumption(
  params: RestartRecoveryDeliveryScope & { gatewayRuntime: GatewayRecoveryRuntime },
): Promise<void> {
  const isCurrent = (cfg: OpenClawConfig) => isRestartRecoveryDeliveryCurrent({ ...params, cfg });
  try {
    if (!isRestartRecoveryDeliveryCurrent(params)) {
      return;
    }
    await params.gatewayRuntime.sendRecoveryNotice({
      ...params.deliveryContext,
      text: "I'm continuing your interrupted request now (the gateway has just restarted).  Don't be concerned with the lack of typing; I am working behind the scenes and I'll send a message when I'm done!",
      idempotencyKey: `main-session-restart-recovery:${params.recoveryRunId}:resumed-notice`,
      liveOnly: true,
      isCurrent,
    });
  } catch (error) {
    // A notice failure must not replay an already admitted recovery turn.
    mainSessionRecoveryLog.warn(
      `failed to announce restart recovery ${params.sessionKey}: ${String(error)}`,
    );
  }
}
