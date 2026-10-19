import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveRestartRecoveryChannelAuthority } from "../../config/sessions/restart-recovery-state.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isTrustedMessageActionTurnIngress } from "../../gateway/message-action-turn-capability.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { findDeliveryIntentOwners } from "../../infra/outbound/delivery-queue-storage.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import {
  deliveryContextKey,
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";

export async function pendingFinalRecoveryAction(
  pending: NonNullable<SessionEntry["pendingFinalDelivery"]>,
  stateDir?: string,
): Promise<"complete" | "defer" | "fail" | "notice" | "retry"> {
  const deliveries = pending.deliveries;
  if (!deliveries?.length) {
    return "fail";
  }
  if (deliveries.every(({ state }) => state === "delivered" || state === "suppressed")) {
    return "complete";
  }
  const owners = await findDeliveryIntentOwners(
    deliveries.map(({ id }) => id),
    stateDir,
  );
  if (owners.some((owner) => owner?.status === "pending" || owner?.settlementPending)) {
    return "defer";
  }
  if (
    pending.kind === "replayable" &&
    deliveries.every(({ state }) => state === "prepared") &&
    owners.every((owner) => owner === null)
  ) {
    return "retry";
  }
  // Residual ambiguity (unknown custody, settled owners, unreplayable mixes):
  // complete the session and record durable notice debt instead of failing it.
  // A fire-and-forget failure notice is lost during the very outage that made
  // the outcome ambiguous; the debt survives until the next same-route turn.
  // Records without notice identity cannot carry debt, so they keep the
  // visible fail path instead of completing silently.
  return pending.context && pending.intentId ? "notice" : "fail";
}

export function hasRestartRecoveryMessageActionAuthority(entry: SessionEntry): boolean {
  const authority = resolveRestartRecoveryChannelAuthority(entry);
  // Keep the pre-dispatch gate identical to recovered capability minting.
  return (
    authority !== undefined && isTrustedMessageActionTurnIngress(authority.deliveryContext.channel)
  );
}

/** Internal continuations never inherit channel authority; every other message-tool recovery must. */
export function requiresRestartRecoveryMessageActionAuthority(entry: SessionEntry): boolean {
  return (
    entry.restartRecoverySourceReplyDeliveryMode === "message_tool_only" &&
    entry.restartRecoverySourceIngress !== "internal"
  );
}

export function resolveRestartRecoveryDeliveryContext(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
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
    normalizeDeliveryContext(params.entry.pendingFinalDelivery?.context) ??
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
      entry: params.entry,
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
  agentId: string;
  sessionId: string;
  recoveryRunId: string;
  lifecycleGeneration: string;
  deliveryContext: DeliveryContext & { channel: string; to: string };
  cfg?: OpenClawConfig;
  shouldContinue?: () => boolean;
};

/** Retain the owning recovery through its final transport effect. */
export async function prepareRestartRecoveryDeliveryCurrent(
  input: RestartRecoveryDeliveryScope,
): Promise<{ isCurrent: (cfg?: OpenClawConfig) => boolean; release: () => void }> {
  const params = { ...input, deliveryContext: { ...input.deliveryContext } };
  const source = captureSessionEntryMetadataRead(params, () => {});
  let active = true;
  const releases: Array<() => void> = [];
  const dispose = () => {
    active = false;
    for (const release of releases.splice(0).toReversed()) {
      release();
    }
  };
  const matchesRecovery = (current: SessionEntry | undefined, cfg?: OpenClawConfig) =>
    current?.sessionId === params.sessionId &&
    current.abortedLastRun !== true &&
    current.restartRecoveryDeliveryRunId === params.recoveryRunId &&
    current.restartRecoverySourceReplyDeliveryMode !== "message_tool_only" &&
    deliveryContextKey(
      resolveRestartRecoveryDeliveryContext({ cfg, entry: current, sessionKey: params.sessionKey }),
    ) === deliveryContextKey(params.deliveryContext);
  let readCurrent: () => SessionEntry | undefined;
  if (source) {
    readCurrent = () => source.readCurrent();
  } else {
    try {
      readCurrent = await withSessionEntryReadOnlyInWorker(
        { ...params, projection: "list" },
        () => {},
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          const entry = read.value;
          const captured = owner.source;
          if (!captured) {
            return () => undefined;
          }
          const retained = retainPreparedSessionEntryPredicate({
            databaseIdentity: `file:${captured.databaseIdentity}`,
            sessionKey: resolveSqliteSessionKey(params.sessionKey, captured.agentId),
            entry,
            matches: (previous, current) =>
              matchesRecovery(current) &&
              previous?.lifecycleRevision === current?.lifecycleRevision &&
              previous?.sendPolicy === current?.sendPolicy &&
              previous?.chatType === current?.chatType,
          });
          releases.push(retained.release);
          releases.push(
            registerOpenClawAgentDatabaseAsyncResource({
              agentId: captured.agentId,
              path: captured.path,
              revoke: dispose,
              close: async () => dispose(),
            }),
          );
          return () => {
            assertExistingDatabaseIdentity(
              captured.path,
              `file:${captured.databaseIdentity}`,
              captured.databaseBirthtime,
            );
            return retained.isCurrent() ? entry : undefined;
          };
        },
      );
    } catch (error) {
      dispose();
      throw error;
    }
  }
  return {
    isCurrent: (cfg = params.cfg) =>
      active &&
      params.shouldContinue?.() !== false &&
      getAgentEventLifecycleGeneration() === params.lifecycleGeneration &&
      matchesRecovery(readCurrent(), cfg),
    release: dispose,
  };
}

export async function announceRestartRecoveryResumption(
  params: RestartRecoveryDeliveryScope & {
    gatewayRuntime: GatewayRecoveryRuntime;
    isCurrent?: (cfg?: OpenClawConfig) => boolean;
  },
): Promise<void> {
  let prepared: Awaited<ReturnType<typeof prepareRestartRecoveryDeliveryCurrent>> | undefined;
  try {
    prepared = params.isCurrent ? undefined : await prepareRestartRecoveryDeliveryCurrent(params);
    const isCurrent = params.isCurrent ?? prepared!.isCurrent;
    if (!isCurrent()) {
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
  } finally {
    prepared?.release();
  }
}
