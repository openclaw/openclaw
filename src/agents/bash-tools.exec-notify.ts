/** Owns captured destinations and cancellation for background exec completion notifications. */
import {
  captureSessionEventTargetForHost as captureSessionEventTarget,
  enqueueSessionEventForHost as enqueueSessionEvent,
} from "../auto-reply/reply/session-event-handoff.js";
import { intersectSessionEventToolsAllow } from "../auto-reply/reply/session-event-target.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  hasRestartRecoverySourceClaim,
  hasRestartRecoveryTerminalRun,
} from "../config/sessions/restart-recovery-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import {
  hasAgentRunContextExecutionOwner,
  listAgentRunsForSession,
} from "../infra/agent-run-registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveEventSessionKeyForPolicy } from "../infra/event-session-routing.js";
import { readExecRequestOwners, withExecRequestOwners } from "../infra/exec-request-context.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEventWithReceipt } from "../infra/system-events.js";
import { logWarn } from "../logger.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isCronRunSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { recoverAfterAgentDatabasePreparation } from "../state/agent-database-preparation-recovery.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import {
  processSessionInstanceId,
  recordNotifyOnExitRemoval,
  tail,
  type ProcessSession,
} from "./bash-process-registry.js";
import {
  appendExecTimeoutRetryGuidance,
  compactNotifyOutput,
  renderExecExitLabel,
} from "./bash-tools.exec-output.js";
import { readToolAllowlistIntersection } from "./tool-policy-shared.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const DEFAULT_NOTIFY_TAIL_CHARS = 400;
const recovering = new Set<string>();

function notificationsEnabled(cfg: OpenClawConfig, agentId: string) {
  return (
    (resolveAgentConfig(cfg, agentId)?.tools?.exec?.notifyOnExit ??
      cfg.tools?.exec?.notifyOnExit) !== false
  );
}

function installExecNotificationPersistence(session: ProcessSession) {
  const target = session.notifySessionTarget!;
  if (isCronRunSessionKey(target.sessionKey!)) {
    return;
  }
  const executionId = processSessionInstanceId(session);
  const scope = {
    agentId: target.agentId!,
    sessionKey: target.sessionKey!,
    storePath: target.storePath,
  };
  const clear = async () => {
    if (!session.exitNotificationPersistence) {
      return;
    }
    await session.exitNotificationPersistence;
    const { patchSessionEntryCore } =
      await import("../config/sessions/session-accessor.sqlite-entry.js");
    await patchSessionEntryCore(
      scope,
      (entry) => {
        if (
          entry.sessionId !== target.sessionId ||
          !entry.pendingExecNotifications?.[executionId]
        ) {
          return null;
        }
        const pending = { ...entry.pendingExecNotifications };
        delete pending[executionId];
        return { pendingExecNotifications: Object.keys(pending).length ? pending : undefined };
      },
      { preserveActivity: true },
    );
  };
  session.clearExitNotification = () =>
    clear().catch((error: unknown) => {
      logWarn(`exec: could not clear completion obligation (${formatErrorMessage(error)})`);
    });
  session.persistExitNotification = async () => {
    const { patchSessionEntryCore } =
      await import("../config/sessions/session-accessor.sqlite-entry.js");
    await patchSessionEntryCore(
      scope,
      (entry) => {
        if (
          entry.incognito ||
          entry.archivedAt ||
          entry.sessionId !== target.sessionId ||
          entry.lifecycleRevision !== target.lifecycleRevision
        ) {
          return null;
        }
        const { toolsAllow, settings, deliver, deliveryContext, chatType } = target;
        return {
          pendingExecNotifications: {
            ...entry.pendingExecNotifications,
            [executionId]: {
              processSessionId: session.id,
              sessionId: target.sessionId,
              lifecycleRevision: target.lifecycleRevision,
              incarnation: target.generation,
              startedAt: session.startedAt,
              // Arguments, shell text, environment and output may contain secrets.
              label: "background exec",
              policy: {
                toolsAllow:
                  toolsAllow === undefined
                    ? undefined
                    : (readToolAllowlistIntersection(toolsAllow) ?? [toolsAllow]),
                settings,
                deliver,
                deliveryContext,
                chatType,
              },
            },
          },
        };
      },
      { preserveActivity: true },
    );
  };
}

/** Replay only the notification obligation, through the ordinary exit owner. */
export function recoverExecExitNotifications(cfg: OpenClawConfig, signal: AbortSignal) {
  return recoverAfterAgentDatabasePreparation(signal, (agentIds) =>
    recoverExecExitNotificationsForAgents(cfg, signal, agentIds),
  );
}

async function recoverExecExitNotificationsForAgents(
  cfg: OpenClawConfig,
  signal: AbortSignal,
  agentIds?: ReadonlySet<string>,
) {
  const [
    { discoverRestartRecoveryStoreTargets },
    { iteratePendingExecNotificationEntriesInWorker },
    { patchSessionEntryCore },
  ] = await Promise.all([
    import("./main-session-recovery/main-session-restart-recovery-shared.js"),
    import("../config/sessions/session-entry-read-maintenance.js"),
    import("../config/sessions/session-accessor.sqlite-entry.js"),
  ]);
  const targets = await discoverRestartRecoveryStoreTargets({
    cfg,
    agentIds,
    shouldContinue: () => !signal.aborted,
  });
  for (const scope of targets) {
    signal.throwIfAborted();
    for await (const { sessionKey, entry } of iteratePendingExecNotificationEntriesInWorker(
      scope,
    )) {
      // Shared stores have one physical owner; routing and policy follow the row's agent.
      const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? scope.agentId;
      for (const [id, fact] of Object.entries(entry.pendingExecNotifications ?? {})) {
        if (fact.incarnation === getAgentEventLifecycleGeneration()) {
          continue;
        }
        const key = `${getAgentEventLifecycleGeneration()}:${entry.sessionId}:${id}`;
        if (recovering.has(key)) {
          continue;
        }
        const clear = () =>
          patchSessionEntryCore(
            { ...scope, agentId, sessionKey },
            (current) => {
              if (current.pendingExecNotifications?.[id]?.incarnation !== fact.incarnation) {
                return null;
              }
              const pending = { ...current.pendingExecNotifications };
              delete pending[id];
              return {
                pendingExecNotifications: Object.keys(pending).length ? pending : undefined,
              };
            },
            { preserveActivity: true },
          );
        signal.throwIfAborted();
        if (
          entry.incognito ||
          entry.archivedAt ||
          entry.sessionId !== fact.sessionId ||
          entry.lifecycleRevision !== fact.lifecycleRevision ||
          !notificationsEnabled(cfg, agentId) ||
          hasRestartRecoverySourceClaim(entry, `exec:${id}`) ||
          hasRestartRecoveryTerminalRun(entry, `exec:${id}`)
        ) {
          await clear();
          continue;
        }
        recovering.add(key);
        try {
          const target = await captureSessionEventTarget(agentId, sessionKey, {
            producerPolicy: {
              settings: fact.policy.settings,
              toolsAllow: intersectSessionEventToolsAllow(...(fact.policy.toolsAllow ?? [])),
            },
          });
          if (
            target.sessionId !== fact.sessionId ||
            target.lifecycleRevision !== fact.lifecycleRevision
          ) {
            await clear();
            recovering.delete(key);
            continue;
          }
          target.deliveryContext = fact.policy.deliveryContext;
          target.deliver = fact.policy.deliver;
          target.chatType = fact.policy.chatType;
          const receipt = enqueueExecExitNotification(
            `Exec lost (${fact.processSessionId.slice(0, 8)}, ${fact.label}): the process was lost when the Gateway restarted; its outcome is unknown. Check the process's side effects/state before re-running it.`,
            target,
            id,
            {
              // The pending-input store binds a source turn to one request and run. A
              // completion or earlier notice interrupted before adoption keeps its key.
              sourceTurnId: `exec:${id}:restart:${getAgentEventLifecycleGeneration()}`,
              abortSignal: signal,
              assertCurrent: () => {
                signal.throwIfAborted();
                if (!notificationsEnabled(getRuntimeConfigSnapshot() ?? cfg, agentId)) {
                  throw new Error("Exec completion notifications are disabled");
                }
              },
              onAdopted: async () => {
                await clear();
              },
            },
          );
          // Startup waits for handoff, never for the model's completion.
          void receipt.settled
            .then(async (outcome) => {
              if (outcome.status === "failed" && outcome.retryable === false) {
                await clear();
              }
            })
            .catch((error: unknown) => {
              logWarn(`exec: restart notice failed (${formatErrorMessage(error)})`);
            })
            .finally(() => recovering.delete(key));
        } catch (error) {
          recovering.delete(key);
          if (signal.aborted) {
            return;
          }
          if (!notificationsEnabled(getRuntimeConfigSnapshot() ?? cfg, agentId)) {
            await clear();
          } else {
            logWarn(`exec: restart notice was not admitted (${formatErrorMessage(error)})`);
          }
        }
      }
    }
  }
}

function enqueueExecExitNotification(
  text: string,
  target: NonNullable<ProcessSession["notifySessionTarget"]>,
  id: string,
  options: Omit<
    Parameters<typeof enqueueSessionEvent>[1],
    "agentId" | "sessionKey" | "source"
  > = {},
) {
  return enqueueSessionEvent(text, {
    ...options,
    agentId: target.agentId!,
    sessionKey: target.sessionKey!,
    source: "exec",
    contextKey: options.contextKey ?? `exec:${id}`,
    sourceTurnId: options.sourceTurnId ?? `exec:${id}`,
    expectedTarget: target,
  });
}

/** Capture the original session before spawning work that may outlive its turn. */
export function prepareExecExitNotification(
  session: ProcessSession,
  subagentSession: boolean,
): Promise<void> | undefined {
  if (
    !session.notifyOnExit ||
    !session.sessionKey ||
    subagentSession ||
    isSubagentSessionKey(session.sessionKey)
  ) {
    return undefined;
  }
  // Ordinary event admission can address the cron run directly, unlike heartbeat drains.
  const targetKey = isCronRunSessionKey(session.sessionKey)
    ? session.sessionKey
    : resolveEventSessionKeyForPolicy(session.sessionKey, session.eventRouting ?? {});
  const owner = session.agentId ?? parseAgentSessionKey(targetKey)?.agentId;
  if (!owner) {
    return undefined;
  }
  return captureSessionEventTarget(owner, targetKey, {
    operatorAuthority: getGatewayToolCallerIdentity()?.operatorAuthority,
    // The completion continues the requester's own command, not a new sender's request.
    retainRequesterOwner: true,
  }).then(
    (target) => {
      if (isCronRunSessionKey(targetKey)) {
        const runs = listAgentRunsForSession({
          sessionKey: targetKey,
          sessionId: target.sessionId,
        });
        // The originating run must survive queue acceptance, not the queued follow-up.
        session.assertExitNotificationAcceptanceCurrent = () => {
          if (!runs.some((run) => hasAgentRunContextExecutionOwner(run.runId))) {
            throw new Error("Originating cron run ended; inspect the result with process log");
          }
        };
      }
      session.notifySessionTarget = target;
      installExecNotificationPersistence(session);
    },
    (error: unknown) => {
      session.notifyOnExit = false;
      logWarn(
        `exec: automatic completion has no destination (${formatErrorMessage(error)}); use process poll.`,
      );
    },
  );
}

export async function maybeNotifyOnExit(
  session: ProcessSession,
  status: "completed" | "failed",
  subagentSession: boolean,
) {
  if (session.exitNotified) {
    return;
  }
  await session.exitNotificationPersistence;
  if (
    !session.backgrounded ||
    !session.notifyOnExit ||
    session.requestCancelled ||
    readExecRequestOwners(session)?.some((owner) => owner.signal.aborted) ||
    session.terminalPollObserved
  ) {
    await session.clearExitNotification?.();
    return;
  }
  const sessionKey = session.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  session.exitNotified = true;
  // Requested stops must not wake another turn to relay leftover output.
  if (session.exitReason === "manual-cancel" && session.finalizationFailed !== true) {
    await session.clearExitNotification?.();
    return;
  }
  const exitLabel = renderExecExitLabel(session);
  const output = compactNotifyOutput(
    tail(session.tail || session.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
  );
  if (
    status === "completed" &&
    session.exitCode === 0 &&
    !output &&
    session.notifyOnExitEmptySuccess !== true
  ) {
    await session.clearExitNotification?.();
    return;
  }
  const summary = output
    ? `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel}) :: ${output}`
    : `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel})`;
  const eventText = appendExecTimeoutRetryGuidance(summary, session.exitReason);
  const eventSessionKey =
    session.notifySessionTarget?.sessionKey ??
    resolveEventSessionKeyForPolicy(sessionKey, session.eventRouting);
  const eventOptions = withExecRequestOwners(
    {
      sessionKey: eventSessionKey,
      contextKey: `exec:${session.id}`,
      deliveryContext: session.notifyDeliveryContext,
    },
    readExecRequestOwners(session),
  );
  if (!subagentSession && !isSubagentSessionKey(sessionKey)) {
    const agentId = session.agentId ?? parseAgentSessionKey(eventSessionKey)?.agentId;
    if (!agentId || !session.notifySessionTarget) {
      logWarn(
        `exec: completion ${session.id} has no admitted session destination; inspect its process result.`,
      );
      return;
    }
    try {
      const receipt = enqueueExecExitNotification(
        eventText,
        session.notifySessionTarget,
        processSessionInstanceId(session),
        {
          ...eventOptions,
          sourceRunId: session.originRunId,
          assertAcceptanceCurrent: session.assertExitNotificationAcceptanceCurrent,
          onAdopted: session.clearExitNotification,
        },
      );
      recordNotifyOnExitRemoval(session, receipt.cancel);
      void receipt.settled.then(async (outcome) => {
        if (outcome.status === "failed") {
          if (outcome.retryable === false) {
            await session.clearExitNotification?.();
          }
          logWarn(
            `exec: completion delivery failed (${outcome.error}); inspect the process result.`,
          );
        }
      });
    } catch (error) {
      logWarn(
        `exec: completion was not admitted (${formatErrorMessage(error)}); inspect the process result.`,
      );
    }
    return;
  }
  // Subagent results remain available to process poll and the announce owner.
  const remove = enqueueSystemEventWithReceipt(
    eventText,
    session.agentId ? withSystemEventOwner(eventOptions, session.agentId) : eventOptions,
    { allowDuplicate: true },
  );
  if (remove) {
    recordNotifyOnExitRemoval(session, remove);
  }
}
