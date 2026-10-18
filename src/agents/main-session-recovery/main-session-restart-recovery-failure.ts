import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stripInternalMetadataForDisplay } from "../../auto-reply/reply/display-text-sanitize.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "../../config/sessions/session-accessor.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { buildRestartRecoveryExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import { buildMainSessionRecoverySettlementPatch } from "./main-session-recovery-clear.js";
import type { MainSessionRecoveryObservation } from "./main-session-recovery-state.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import { resolveRestartRecoveryDeliveryContext } from "./main-session-restart-recovery-delivery.js";
import {
  mainSessionRecoveryLog,
  resolveRestartRecoveryTerminalClientRunId,
} from "./main-session-restart-recovery-shared.js";

/** Retire only the interrupted input; a fresh authenticated turn can use the same session. */
export async function prepareRequesterRestartRecovery(params: {
  agentId: string;
  entry: SessionEntry;
  observation: MainSessionRecoveryObservation;
  sessionKey: string;
  storePath: string;
  assertCurrent: () => void;
  gatewayRuntime: GatewayRecoveryRuntime;
  sourceRunId: string;
  requesterSessionKey: string;
}): Promise<
  | { outcome: "ready"; source: SessionSourceAssertion }
  | { outcome: "settled" | "changed" | "failed" }
> {
  const { entry } = params;
  const { prepareRequesterSettleWakeRecoverySource } =
    await import("../subagents/registry/subagent-registry.js");
  params.assertCurrent();
  const recovered = await prepareRequesterSettleWakeRecoverySource({
    runId: params.sourceRunId,
    requesterSessionKey: params.requesterSessionKey,
    requesterAgentId: params.agentId,
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    storePath: params.storePath,
    gatewayRuntime: params.gatewayRuntime,
    requesterOperatorSourceMissing: !entry.restartRecoveryOperatorSource || undefined,
  });
  params.assertCurrent();
  if (recovered?.status === "ready") {
    return { outcome: "ready", source: recovered.source };
  }
  const reason = recovered?.reason ?? "the original completion cohort is no longer available";
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
    expectedSessionState: {
      ...buildRestartRecoveryExpectedState(entry, params.observation),
      pendingFinalDelivery: entry.pendingFinalDelivery ?? null,
    },
    assertCurrent: params.assertCurrent,
    idempotencyKey: `main-session-restart-recovery:${entry.restartRecoveryDeliverySourceRunId}:interrupted`,
    text:
      `This interrupted turn could not resume after the Gateway restarted: ${reason}. ` +
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
      lastRunId: resolveRestartRecoveryTerminalClientRunId(entry),
      lastRunError: reason,
      endedAt,
      runtimeMs: Math.max(0, endedAt - (entry.startedAt ?? endedAt)),
      updatedAt: endedAt,
    },
  });
  if (result.ok) {
    return { outcome: "settled" };
  }
  if ("code" in result && result.code === "session-rebound") {
    return { outcome: "changed" };
  }
  mainSessionRecoveryLog.warn(
    `failed to settle interrupted requester recovery ${params.sessionKey}: ${result.reason}`,
  );
  return { outcome: "failed" };
}

function buildTombstonedSessionNotice(reason: string): string {
  return (
    `I couldn't continue this session after a gateway restart: ${reason}. ` +
    "Your transcript is safe. In WebChat, use Resume to continue in this session; " +
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
}): Promise<boolean> {
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
  return result.ok;
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
    const { entry, observation } = params;
    const recoveryState = entry.mainRestartRecovery;
    if (
      !recoveryState ||
      recoveryState.cycleId !== observation.cycleId ||
      recoveryState.revision !== observation.revision
    ) {
      return "skipped";
    }
    const now = Date.now();
    const written = await writeRestartRecoveryTombstoneNotice({
      ...params,
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
    return written ? "tombstoned" : "notice_failed";
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
