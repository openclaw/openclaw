import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stripInternalMetadataForDisplay } from "../../auto-reply/reply/display-text-sanitize.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { hasRestartRecoveryTerminalRun } from "../../config/sessions/restart-recovery-state.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { buildRestartRecoveryExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import { buildMainSessionRecoverySettlementPatch } from "./main-session-recovery-clear.js";
import type { MainSessionRecoveryObservation } from "./main-session-recovery-state.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import type { readMainSessionRecoveryCheckpoint } from "./main-session-restart-recovery-checkpoint.js";
import { resolveRestartRecoveryDeliveryContext } from "./main-session-restart-recovery-delivery.js";
import {
  mainSessionRecoveryLog,
  resolveRestartRecoveryTerminalClientRunId,
} from "./main-session-restart-recovery-shared.js";

/** Whether recovery must re-prove delegated sender authority before resuming. */
export function requiresDelegatedRecoverySource(
  entry: SessionEntry,
  source: Awaited<ReturnType<typeof readMainSessionRecoveryCheckpoint>>["source"],
): boolean {
  // Steering is context, not a new admission. A non-browser operator can have
  // internal ingress too; its durable source goes through the Gateway's exact
  // claim and current-policy restoration before any recovery turn executes.
  if (
    entry.restartRecoveryDeliverySourceRunId &&
    (entry.restartRecoveryOperatorSource ||
      entry.restartRecoverySourceIngress === "control-ui" ||
      entry.restartRecoverySourceIngress === "channel")
  ) {
    return false;
  }
  return (
    source === "inter_session" ||
    (entry.restartRecoverySourceIngress === "internal" &&
      (source === undefined || source === "internal_system" || source === "harness_completion"))
  );
}

/** Publish one local interruption notice and retire the exact input without replay or delivery. */
async function settleInterruptedRestartRecovery(
  params: Omit<
    Parameters<typeof tombstoneMainRestartRecoveryWithNotice>[0],
    "cfg" | "gatewayRuntime"
  >,
): Promise<"settled" | "skipped" | "notice_failed"> {
  const { entry } = params;
  const endedAt = Date.now();
  const capturedReply =
    entry.pendingFinalDelivery?.kind === "replayable"
      ? stripInternalMetadataForDisplay(entry.pendingFinalDelivery.text).trim()
      : undefined;
  const result = await appendAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    expectedSessionId: entry.sessionId,
    expectedLifecycleRevision: entry.lifecycleRevision ?? null,
    expectedSessionState: buildRestartRecoveryExpectedState(entry, params.observation),
    idempotencyKey: `main-session-restart-recovery:${entry.restartRecoveryDeliverySourceRunId ?? entry.restartRecoveryDeliveryRunId ?? entry.sessionId}:interrupted`,
    text:
      `This interrupted turn could not resume after the Gateway restarted: ${params.reason}. ` +
      "Your session and transcript are preserved. Send a new authenticated message to continue." +
      (capturedReply ? `\n\nSaved reply (delivery unconfirmed):\n${capturedReply}` : ""),
    sessionLifecyclePatch: {
      ...buildMainSessionRecoverySettlementPatch({
        entry,
        recordTerminalSource: true,
        terminalRunId: entry.restartRecoveryDeliveryRunId,
      }),
      status: "interrupted",
      pendingFinalDelivery: undefined,
      lifecycleRunId: undefined,
      lastRunId:
        resolveRestartRecoveryTerminalClientRunId(entry) ??
        entry.restartRecoveryDeliveryRunId ??
        entry.restartRecoveryDeliverySourceRunId,
      lastRunError: params.reason,
      endedAt,
      runtimeMs: Math.max(0, endedAt - (entry.startedAt ?? endedAt)),
      updatedAt: endedAt,
    },
  });
  if (result.ok) {
    return "settled";
  }
  if ("code" in result && result.code === "session-rebound") {
    return "skipped";
  }
  mainSessionRecoveryLog.warn(
    `failed to settle interrupted recovery ${params.sessionKey}: ${result.reason}`,
  );
  return "notice_failed";
}

/** Sender loss retires one input only when no other execution or delivery custody remains. */
export async function finishDelegatedRestartRecovery(
  params: Parameters<typeof tombstoneMainRestartRecoveryWithNotice>[0],
): Promise<"notice_failed" | "skipped" | "tombstoned" | "settled"> {
  const { entry } = params;
  if (
    entry.pendingFinalDelivery ||
    entry.restartRecoveryHarnessCompletion ||
    (entry.restartRecoveryRuns ?? []).some(
      (run) =>
        run.runId !== entry.restartRecoveryDeliveryRunId &&
        run.runId !== entry.restartRecoveryDeliverySourceRunId &&
        !hasRestartRecoveryTerminalRun(entry, run.runId),
    )
  ) {
    return await tombstoneMainRestartRecoveryWithNotice(params);
  }
  return await settleInterruptedRestartRecovery(params);
}

function buildTombstonedSessionNotice(reason: string): string {
  return (
    `I couldn't continue this session after a gateway restart: ${reason}. ` +
    "Your transcript is safe. In WebChat, use Resume in new session to continue it; " +
    "in other channels, use /new or /reset to start a replacement session."
  );
}

function buildRestartRecoveryTombstoneNoticeKey(entry: SessionEntry): string {
  const interruptedRunId =
    normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) ??
    normalizeOptionalString(entry.restartRecoveryDeliveryRunId) ??
    entry.sessionId;
  return `main-session-restart-recovery:${interruptedRunId}:failed-notice`;
}

async function sendRestartRecoveryTombstoneNotice(params: {
  deliveryContext: DeliveryContext & { channel: string; to: string };
  entry: SessionEntry;
  gatewayRuntime: GatewayRecoveryRuntime;
  reason: string;
  sessionKey: string;
}): Promise<void> {
  try {
    await params.gatewayRuntime.sendRecoveryNotice({
      channel: params.deliveryContext.channel,
      to: params.deliveryContext.to,
      accountId: params.deliveryContext.accountId,
      threadId: params.deliveryContext.threadId,
      text: buildTombstonedSessionNotice(params.reason),
      idempotencyKey: buildRestartRecoveryTombstoneNoticeKey(params.entry),
    });
    mainSessionRecoveryLog.info(
      `sent restart recovery tombstone notice: ${params.sessionKey} (${params.reason})`,
    );
  } catch (error) {
    mainSessionRecoveryLog.warn(
      `failed to send restart recovery tombstone notice ${params.sessionKey}: ${String(error)}`,
    );
  }
}

async function writeRestartRecoveryTombstoneNotice(params: {
  agentId: string;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
  expectedSessionState: SessionTranscriptTurnExpectedState;
  sessionLifecyclePatch: SessionTranscriptTurnLifecyclePatch;
  reason: string;
}): Promise<"failed" | "stale" | "written"> {
  const result = await appendAssistantMessageToSessionTranscript({
    ...params,
    expectedSessionId: params.entry.sessionId,
    text: buildTombstonedSessionNotice(params.reason),
    idempotencyKey: buildRestartRecoveryTombstoneNoticeKey(params.entry),
  }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!result.ok) {
    mainSessionRecoveryLog.warn(
      `failed to write restart recovery tombstone notice ${params.sessionKey}: ${result.reason}`,
    );
  }
  return result.ok
    ? "written"
    : "code" in result && result.code === "session-rebound"
      ? "stale"
      : "failed";
}

export async function tombstoneMainRestartRecoveryWithNotice(params: {
  agentId: string;
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  gatewayRuntime: GatewayRecoveryRuntime;
  observation: MainSessionRecoveryObservation;
  reason: string;
  sessionKey: string;
  storePath: string;
}): Promise<"notice_failed" | "skipped" | "tombstoned"> {
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    includeSessionDeliveryFallback: true,
    sessionKey: params.sessionKey,
  });
  if (!deliveryContext) {
    // The transcript notice and tombstone share one SQLite transaction so a
    // foreground takeover cannot leave behind a false terminal notice.
    let entry = params.entry;
    let observation = params.observation;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const recoveryState = entry.mainRestartRecovery;
      if (
        !recoveryState ||
        recoveryState.cycleId !== observation.cycleId ||
        recoveryState.revision !== observation.revision
      ) {
        return "skipped";
      }
      const now = Date.now();
      const notice = await writeRestartRecoveryTombstoneNotice({
        ...params,
        entry,
        expectedSessionState: buildRestartRecoveryExpectedState(entry, observation),
        sessionLifecyclePatch: {
          abortedLastRun: false,
          endedAt: now,
          lifecycleRunId: undefined,
          lastRunId: resolveRestartRecoveryTerminalClientRunId(entry),
          mainRestartRecovery: {
            ...recoveryState,
            revision: recoveryState.revision + 1,
            tombstone: { reason: params.reason },
          },
          runtimeMs: Math.max(0, now - (entry.startedAt ?? now)),
          status: "failed",
          updatedAt: now,
        },
      });
      if (notice === "written") {
        return "tombstoned";
      }
      if (notice === "failed") {
        return "notice_failed";
      }
      const current = await readSessionEntryReadOnlyInWorker({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        readConsistency: "latest",
      });
      const state = current?.mainRestartRecovery;
      if (
        !current ||
        current.sessionId !== params.entry.sessionId ||
        state?.cycleId !== params.observation.cycleId ||
        state.tombstone ||
        current.abortedLastRun !== true
      ) {
        return "skipped";
      }
      entry = current;
      observation = {
        sessionId: current.sessionId,
        cycleId: state.cycleId,
        revision: state.revision,
      };
    }
    return "notice_failed";
  }
  const claim = await commitMainSessionRecovery({
    command: {
      kind: "tombstone",
      now: Date.now(),
      observation: params.observation,
      reason: params.reason,
    },
    requireWriteSuccess: true,
    target: params,
  });
  if (claim.transition.kind !== "tombstoned" || !claim.entry) {
    return "skipped";
  }
  mainSessionRecoveryLog.warn(
    `tombstoned main-session restart recovery: ${params.sessionKey} (${params.reason})`,
  );
  await sendRestartRecoveryTombstoneNotice({
    ...params,
    deliveryContext,
    entry: claim.entry,
  });
  return "tombstoned";
}
