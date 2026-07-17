import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import type { MainSessionRecoveryObservation } from "./main-session-recovery-state.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import { buildUnresumableSessionNoticeIdempotencyKey } from "./main-session-restart-claim.js";
import { resolveRestartRecoveryDeliveryContext } from "./main-session-restart-dispatch.js";

const log = createSubsystemLogger("main-session-restart-recovery");
const TOMBSTONED_SESSION_NOTICE =
  "I couldn't recover this session after repeated gateway restarts. " +
  "Use /new or /reset to start a replacement session.";

async function claimMainRestartRecoveryTombstone(params: {
  observation: MainSessionRecoveryObservation;
  reason: string;
  storePath: string;
  sessionKey: string;
}): Promise<SessionEntry | null> {
  const claim = await commitMainSessionRecovery({
    command: {
      kind: "tombstone",
      now: Date.now(),
      observation: params.observation,
      reason: params.reason,
    },
    requireWriteSuccess: true,
    target: { sessionKey: params.sessionKey, storePath: params.storePath },
  });
  if (claim.transition.kind !== "tombstoned" || !claim.entry) {
    return null;
  }
  log.warn(`tombstoned main-session restart recovery: ${params.sessionKey} (${params.reason})`);
  return claim.entry;
}

export async function tombstoneMainRestartRecoveryWithNotice(params: {
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
    const notice = await writeUnresumableSessionNotice({
      ...params,
      text: TOMBSTONED_SESSION_NOTICE,
    });
    if (notice === "stale") {
      return "skipped";
    }
    if (notice === "failed") {
      return "notice_failed";
    }
    return "tombstoned";
  }
  const tombstonedEntry = await claimMainRestartRecoveryTombstone(params);
  if (!tombstonedEntry) {
    return "skipped";
  }
  if (deliveryContext) {
    await sendUnresumableSessionNotice({
      deliveryContext,
      entry: tombstonedEntry,
      gatewayRuntime: params.gatewayRuntime,
      reason: params.reason,
      sessionKey: params.sessionKey,
      text: TOMBSTONED_SESSION_NOTICE,
    });
  }
  return "tombstoned";
}

async function sendUnresumableSessionNotice(params: {
  deliveryContext: DeliveryContext;
  entry: SessionEntry;
  gatewayRuntime: GatewayRecoveryRuntime;
  reason: string;
  sessionKey: string;
  text: string;
}): Promise<void> {
  const messageParams: Record<string, unknown> = {
    to: params.deliveryContext.to,
    message: params.text,
    bestEffort: true,
    ...(params.deliveryContext.threadId != null
      ? { threadId: params.deliveryContext.threadId }
      : {}),
  };
  const actionParams: Record<string, unknown> = {
    channel: params.deliveryContext.channel,
    action: "send",
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    idempotencyKey: buildUnresumableSessionNoticeIdempotencyKey(params.entry),
    params: messageParams,
  };
  const accountId = normalizeOptionalString(params.deliveryContext.accountId);
  if (accountId) {
    actionParams.accountId = accountId;
  }
  try {
    await params.gatewayRuntime.sendRecoveryNotice(actionParams, 10_000);
    log.info(
      `sent interrupted main session recovery notice: ${params.sessionKey} (${params.reason})`,
    );
  } catch (error) {
    log.warn(
      `failed to send interrupted main session recovery notice ${params.sessionKey}: ${String(error)}`,
    );
  }
}

async function writeUnresumableSessionNotice(params: {
  entry: SessionEntry;
  observation: MainSessionRecoveryObservation;
  reason: string;
  sessionKey: string;
  storePath: string;
  text: string;
}): Promise<"failed" | "stale" | "written"> {
  const recoveryState = params.entry.mainRestartRecovery;
  if (
    !recoveryState ||
    recoveryState.cycleId !== params.observation.cycleId ||
    recoveryState.revision !== params.observation.revision
  ) {
    return "stale";
  }
  const now = Date.now();
  const result = await appendAssistantMessageToSessionTranscript({
    agentId: resolveAgentIdFromSessionKey(params.sessionKey),
    sessionKey: params.sessionKey,
    expectedSessionId: params.entry.sessionId,
    expectedSessionState: {
      abortedLastRun: params.entry.abortedLastRun,
      mainRestartRecoveryCycleId: params.observation.cycleId,
      mainRestartRecoveryRevision: params.observation.revision,
      restartRecoveryBeforeAgentReplyState: params.entry.restartRecoveryBeforeAgentReplyState,
      restartRecoveryDeliveryReceiptState: params.entry.restartRecoveryDeliveryReceiptState,
      restartRecoveryDeliveryToolCallId: params.entry.restartRecoveryDeliveryToolCallId,
      restartRecoveryDeliveryRequestFingerprint:
        params.entry.restartRecoveryDeliveryRequestFingerprint,
      restartRecoveryDeliveryRunId: params.entry.restartRecoveryDeliveryRunId,
      restartRecoveryDeliverySourceRunId: params.entry.restartRecoveryDeliverySourceRunId,
      restartRecoveryRequesterAccountId: params.entry.restartRecoveryRequesterAccountId,
      restartRecoveryRequesterSenderId: params.entry.restartRecoveryRequesterSenderId,
      restartRecoverySameChannelThreadRequired:
        params.entry.restartRecoverySameChannelThreadRequired,
      restartRecoverySourceIngress: params.entry.restartRecoverySourceIngress,
      restartRecoverySourceReplyDeliveryMode: params.entry.restartRecoverySourceReplyDeliveryMode,
      restartRecoveryTerminalRunIds: params.entry.restartRecoveryTerminalRunIds,
      status: params.entry.status,
      updatedAt: params.entry.updatedAt,
    },
    sessionLifecyclePatch: {
      abortedLastRun: false,
      endedAt: now,
      mainRestartRecovery: {
        ...recoveryState,
        revision: recoveryState.revision + 1,
        tombstone: { reason: params.reason },
      },
      runtimeMs: Math.max(0, now - (params.entry.startedAt ?? now)),
      status: "failed",
      updatedAt: now,
    },
    storePath: params.storePath,
    text: params.text,
    idempotencyKey: buildUnresumableSessionNoticeIdempotencyKey(params.entry),
  }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!result.ok) {
    log.warn(
      `failed to write interrupted main session notice ${params.sessionKey}: ${result.reason}`,
    );
  }
  return result.ok
    ? "written"
    : "code" in result && result.code === "session-rebound"
      ? "stale"
      : "failed";
}
