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
const UNRESUMABLE_SESSION_NOTICE =
  "I was interrupted by a gateway restart and couldn't safely resume the previous turn. " +
  "Please send that last request again and I'll pick it up cleanly.";
const TOMBSTONED_SESSION_NOTICE =
  "I couldn't recover this session after repeated gateway restarts. " +
  "Use /new or /reset to start a replacement session.";

export async function claimMainRestartRecoveryTombstone(params: {
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
    // Transcript-only sessions need the notice durable before the tombstone hides
    // them from later scans; a failed append must leave the exhausted cycle retryable.
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

async function claimMainRestartRecoveryFailure(params: {
  observation: MainSessionRecoveryObservation;
  storePath: string;
  sessionKey: string;
  reason: string;
}): Promise<SessionEntry | null> {
  const failure = await commitMainSessionRecovery({
    command: { kind: "fail_recovery", now: Date.now(), observation: params.observation },
    requireWriteSuccess: true,
    target: { sessionKey: params.sessionKey, storePath: params.storePath },
  });
  if (failure.transition.kind !== "failed") {
    return null;
  }
  log.warn(`marked interrupted main session failed: ${params.sessionKey} (${params.reason})`);
  return failure.transition.noticeEntry;
}

export async function sendUnresumableSessionNotice(params: {
  deliveryContext: DeliveryContext;
  entry: SessionEntry;
  gatewayRuntime: GatewayRecoveryRuntime;
  reason: string;
  sessionKey: string;
  text?: string;
}): Promise<void> {
  const messageParams: Record<string, unknown> = {
    to: params.deliveryContext.to,
    message: params.text ?? UNRESUMABLE_SESSION_NOTICE,
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
  sessionKey: string;
  storePath: string;
  text?: string;
}): Promise<"failed" | "stale" | "written"> {
  const result = await appendAssistantMessageToSessionTranscript({
    agentId: resolveAgentIdFromSessionKey(params.sessionKey),
    sessionKey: params.sessionKey,
    expectedSessionId: params.entry.sessionId,
    expectedSessionState: {
      abortedLastRun: params.entry.abortedLastRun,
      mainRestartRecoveryCycleId: params.observation.cycleId,
      mainRestartRecoveryRevision: params.observation.revision,
      restartRecoveryDeliveryRequestFingerprint:
        params.entry.restartRecoveryDeliveryRequestFingerprint,
      restartRecoveryDeliveryRunId: params.entry.restartRecoveryDeliveryRunId,
      restartRecoveryDeliverySourceRunId: params.entry.restartRecoveryDeliverySourceRunId,
      status: params.entry.status,
      updatedAt: params.entry.updatedAt,
    },
    storePath: params.storePath,
    text: params.text ?? UNRESUMABLE_SESSION_NOTICE,
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

export async function failMainRestartRecoveryWithNotice(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  gatewayRuntime: GatewayRecoveryRuntime;
  observation: MainSessionRecoveryObservation;
  reason: string;
  sessionKey: string;
  storePath: string;
}): Promise<"failed" | "skipped" | "notice_failed"> {
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    includeSessionDeliveryFallback: true,
    sessionKey: params.sessionKey,
  });
  // Without an external route, persist the notice before terminalizing the recovery claim.
  if (!deliveryContext) {
    const notice = await writeUnresumableSessionNotice(params);
    if (notice === "stale") {
      return "skipped";
    }
    if (notice === "failed") {
      return "notice_failed";
    }
  }
  const failedEntry = await claimMainRestartRecoveryFailure(params);
  if (!failedEntry) {
    return "skipped";
  }
  if (deliveryContext) {
    await sendUnresumableSessionNotice({
      deliveryContext,
      entry: failedEntry,
      gatewayRuntime: params.gatewayRuntime,
      reason: params.reason,
      sessionKey: params.sessionKey,
    });
  }
  return "failed";
}
