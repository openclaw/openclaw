import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { clearCommittedSessionResetRuntimeState } from "../auto-reply/reply/session-reset-cleanup.js";
import type { VerboseLevel } from "../auto-reply/thinking.js";
import type { CliDeps } from "../cli/deps.types.js";
import { createSessionWorkStartChangedError } from "../config/sessions/lifecycle.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  captureAgentRunLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { defaultRuntime, type RuntimeEnv, withoutRuntimeOutput } from "../runtime.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { getCurrentSessionControllerOwner } from "../sessions/session-controller.lifecycle.js";
import { classifySessionStateActor } from "../sessions/session-state-events.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { sessionDeliveryChannel, type DeliveryContext } from "../utils/delivery-context.read.js";
import {
  executionIdentity,
  prepareAgentCommandExecutionIdentity,
  sanitizePublicAgentCommandIngressOpts,
  type AgentCommandAdmissionIngress,
} from "./agent-command-execution-identity.js";
import { runLocalAgentCommand } from "./agent-command-local.js";
import {
  beginAgentCommandSessionEffect,
  repairAgentCommandSessionTranscript,
} from "./agent-command-session-effect.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { runAcpAgentCommand } from "./command/acp-execution.js";
import { persistAgentSession } from "./command/attempt-execution.shared.js";
import { finishAgentCommandCleanup } from "./command/cleanup.js";
import { createCompactionSessionIdReporter } from "./command/compaction-accounting.js";
import { emitIngressModelUsageDiagnostic } from "./command/ingress-diagnostics.js";
import { prepareCommandForegroundRun } from "./command/maintenance.js";
import { resolveEmbeddedModelSelection } from "./command/model-selection.js";
import { finalizeEmbeddedAgentCommand } from "./command/post-run.js";
import {
  prepareAgentCommandExecution,
  type PreparedAgentCommandRuntimeContext,
} from "./command/prepare.js";
import { runEmbeddedAgentAttempt } from "./command/run-embedded-attempt.js";
import { resolveAgentCommandDeps } from "./command/runtime-loaders.js";
import { prepareCurrentRunDelivery } from "./command/session-helpers.js";
import {
  prepareCommandSessionDiffBaseline,
  prepareEmbeddedSessionState,
} from "./command/session-preparation.js";
import type {
  AgentCommandGatewayIngressOpts,
  AgentCommandIngressOpts,
  AgentCommandOpts,
} from "./command/types.js";
import { createInternalSessionEffectsCleanup } from "./internal-session-effects.js";
import { withAgentPluginRegistry } from "./runtime-plugins.js";
import { beginForegroundSessionMaintenance } from "./session-maintenance/coordinator.js";
import {
  scheduleSessionMaintenance,
  type SessionMaintenanceRequest,
} from "./session-maintenance/run.js";
import { clearRotatedSessionMetadata } from "./session-reset-metadata.js";
import { measureAgentStartup } from "./startup-timing.js";

const log = createSubsystemLogger("agents/agent-command");

async function agentCommandInternal(
  prepared: Awaited<ReturnType<typeof prepareAgentCommandExecution>>,
  admissionIngress: AgentCommandAdmissionIngress,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
  watchSkills = false,
) {
  let maintenanceRequest: SessionMaintenanceRequest | undefined;
  return await withSessionTurn(
    {
      sessionKey: prepared.sessionKey,
      sessionId: prepared.sessionId,
      agentId: prepared.sessionAgentId,
      storePath: prepared.storePath,
      abortSignal: prepared.opts.abortSignal,
      detached: prepared.opts.sessionEffects === "internal",
    },
    async (_operation, abortSignal) => {
      return await agentCommandInternalOwned(
        { ...prepared, opts: { ...prepared.opts, abortSignal } },
        admissionIngress,
        runtime,
        deps,
        watchSkills,
        (request) => {
          maintenanceRequest = request;
        },
      );
    },
  ).finally(() => {
    if (maintenanceRequest) {
      scheduleSessionMaintenance(maintenanceRequest);
    }
  });
}

async function agentCommandInternalOwned(
  prepared: Awaited<ReturnType<typeof prepareAgentCommandExecution>>,
  admissionIngress: AgentCommandAdmissionIngress,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
  watchSkills = false,
  retainMaintenanceRequest?: (request: SessionMaintenanceRequest) => void,
) {
  const resolvedDeps = await resolveAgentCommandDeps(deps);
  const isRawModelRun = prepared.opts.modelRun === true || prepared.opts.promptMode === "none";
  const suppressVisibleSessionEffects = prepared.opts.sessionEffects === "internal";
  const preserveUserFacingSessionModelState =
    prepared.opts.preserveUserFacingSessionModelState === true;
  const lifecycleAbortController = new AbortController();
  const preparedOpts = prepared.opts;
  const parentAbortSignal = preparedOpts.abortSignal;
  if (parentAbortSignal?.aborted) {
    lifecycleAbortController.abort(parentAbortSignal.reason);
  }
  // Node 24's AbortSignal.any can replace an unread reason when another source aborts.
  using _ =
    parentAbortSignal && !parentAbortSignal.aborted
      ? addAbortListener(parentAbortSignal, () => {
          lifecycleAbortController.abort(parentAbortSignal.reason);
        })
      : undefined;
  const compactionSessionIdReporter = createCompactionSessionIdReporter(
    prepared.sessionId,
    preparedOpts.onSessionIdChanged,
  );
  const turnOwner = getCurrentSessionControllerOwner();
  const recordCompactionSessionId = (sessionId: string) => {
    turnOwner?.updateSessionId(sessionId);
    compactionSessionIdReporter.onCompactionCommitted(sessionId);
  };
  let opts: AgentCommandOpts = {
    ...preparedOpts,
    onSessionIdChanged: (sessionId) => {
      turnOwner?.updateSessionId(sessionId);
      compactionSessionIdReporter.onSessionIdChanged(sessionId);
    },
    abortSignal: lifecycleAbortController.signal,
  };
  const preparedContext = { ...prepared };
  const {
    cfg,
    agentCfg,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    isNewSession,
    automaticReset,
    sessionAgentId,
    workspaceDir,
    cwd,
    runId,
    isSubagentLane,
    acpResolution,
    manifestMetadataSnapshot,
  } = preparedContext;
  const isIncognito =
    prepared.sessionEntry?.incognito === true || isIncognitoSessionKey(sessionKey);
  // Provider and persistence errors can include temporary conversation content.
  const diagnosticError = (error: unknown) =>
    formatErrorMessage(isIncognito ? "Incognito agent error." : error);
  let lifecycleGeneration = opts.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(runId);
  let sessionEntry = prepared.sessionEntry,
    runOwnedSessionId = sessionId;
  // Subagent-lane turns are the parent's own task dispatch into the child (they
  // carry no inter_session provenance today); classifying them as human would tell
  // the parent a human interjected on every spawn, for embedded and ACP children alike.
  const sessionStateActor = classifySessionStateActor({
    inputProvenance: opts.inputProvenance,
    internalEvents: opts.internalEvents,
    sessionEffects: opts.sessionEffects,
  });
  let sessionReboundDuringRun = false;
  let currentRunDeliveryContext: DeliveryContext | undefined;
  const preparedSessionId = sessionEntry?.sessionId;
  const { track: trackInternalModelRunTarget, cleanup: cleanupInternalModelRunTargets } =
    createInternalSessionEffectsCleanup({
      enabled: prepared.opts.modelRun === true && suppressVisibleSessionEffects,
      agentId: sessionAgentId,
      runId,
      storePath,
      onError: (error) => {
        log.warn(`failed to remove model-run SQLite session: ${diagnosticError(error)}`);
      },
    });

  let sessionWorkAdmission: Awaited<ReturnType<typeof beginAgentCommandSessionEffect>> | undefined;
  let releaseForeground: (() => void) | undefined;
  let maintenanceRequest: SessionMaintenanceRequest | undefined;
  let preparedRunAdmission: ReturnType<typeof prepareAgentCommandExecutionIdentity> | undefined;
  let commandError: unknown;
  try {
    const operatorSession =
      opts.operatorAuthority && sessionKey
        ? (await import("../gateway/operator-session-run.js")).prepareGatewayOperatorSessionRun({
            authority: opts.operatorAuthority,
            cfg,
            agentId: sessionAgentId,
            sessionKey,
            currentSource: () => opts,
          })
        : undefined;
    if (
      sessionStateActor.actorType === "human" &&
      !isSubagentLane &&
      !opts.internalEvents?.length &&
      opts.bootstrapContextRunKind !== "cron"
    ) {
      releaseForeground = await beginForegroundSessionMaintenance(sessionKey ?? sessionId);
    }
    assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
    sessionWorkAdmission = await beginAgentCommandSessionEffect({
      prepared,
      opts,
      sessionEntry,
      preparedSessionId,
      operatorSession,
      onInterrupt: (reason) => lifecycleAbortController.abort(reason),
      onValidated: (entry) => {
        sessionEntry = entry;
      },
    });
    return await sessionWorkAdmission.run(async () => {
      sessionEntry = await repairAgentCommandSessionTranscript({
        prepared,
        sessionEntry,
        suppressVisibleSessionEffects,
        diagnosticError,
        warn: (message) => log.warn(message),
      });
      if (opts.deliver === true) {
        const sendPolicy = resolveSendPolicy({
          cfg,
          entry: sessionEntry,
          sessionKey,
          channel: sessionDeliveryChannel(sessionEntry),
          chatType: sessionEntry?.chatType,
        });
        if (sendPolicy === "deny") {
          throw new Error("send blocked by session policy");
        }
      }

      if (!isRawModelRun && acpResolution?.kind === "stale") {
        throw acpResolution.error;
      }

      let currentRunDeliveryPrepared = false;
      const prepareDeliveryForRun = async (candidateSessionEntry?: typeof sessionEntry) => {
        if (currentRunDeliveryPrepared || opts.deliver !== true) {
          return;
        }
        currentRunDeliveryPrepared = true;
        let preparedDelivery: Awaited<ReturnType<typeof prepareCurrentRunDelivery>>;
        try {
          preparedDelivery = await prepareCurrentRunDelivery({
            cfg,
            opts,
            agentId: sessionAgentId,
            currentSessionKey: sessionKey,
            sessionEntry: candidateSessionEntry,
          });
        } catch (error) {
          if (opts.bestEffortDeliver !== true) {
            throw error;
          }
          log.warn(
            `delivery preflight failed; continuing model run with requested delivery intent because bestEffortDeliver is enabled: ${diagnosticError(error)}`,
          );
        }
        assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        if (preparedDelivery) {
          currentRunDeliveryContext = preparedDelivery.context;
          opts = {
            ...opts,
            replyChannel: preparedDelivery.context.channel,
            replyTo: preparedDelivery.context.to,
            replyAccountId: preparedDelivery.context.accountId,
            threadId: preparedDelivery.context.threadId,
            deliveryTargetMode: preparedDelivery.targetMode,
          };
        }
      };

      if (sessionStore && sessionKey && !suppressVisibleSessionEffects) {
        const now = Date.now();
        const currentStoreEntry = sessionStore[sessionKey];
        const allowCreate = currentStoreEntry === undefined && sessionEntry === undefined;
        // A local operator's own root records the direct chat type that
        // operator-created Gateway roots receive, so memory audience resolves.
        const initialEntry = currentStoreEntry ??
          sessionEntry ?? {
            sessionId,
            updatedAt: now,
            sessionStartedAt: now,
            ...(opts.operatorDirectRoot ? { chatType: "direct" as const } : {}),
          };
        const isSessionRollover =
          isNewSession && (initialEntry.sessionId !== sessionId || automaticReset !== undefined);
        const entry = isSessionRollover ? clearRotatedSessionMetadata(initialEntry) : initialEntry;
        if (automaticReset) {
          entry.lifecycleRevision = randomUUID();
          entry.agentHarnessId = undefined;
        }
        await prepareDeliveryForRun(entry);
        const nextEntry = {
          ...entry,
          sessionId,
          updatedAt: now,
          status: undefined,
          abortedLastRun: false,
          endedAt: undefined,
          lastRunError: undefined,
          sessionStartedAt: isSessionRollover ? now : entry.sessionStartedAt,
          lastInteractionAt: isSessionRollover ? now : entry.lastInteractionAt,
        };
        assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        const persisted = await persistAgentSession({
          agentId: sessionAgentId,
          sessionStore,
          sessionKey,
          storePath,
          initialEntry,
          entry: nextEntry,
          ...(automaticReset
            ? {
                resetBoundary: {
                  context: "preserve-tail" as const,
                  reason: automaticReset.reason,
                  cwd: cwd ?? workspaceDir,
                },
              }
            : {}),
          creation: operatorSession?.creation,
          assertCommitAllowed: operatorSession?.assertCurrent,
          shouldPersist: (current) => {
            operatorSession?.assertAuthorized(current);
            return (
              (!automaticReset ||
                current?.lifecycleRevision === automaticReset.expectedLifecycleRevision) &&
              (current === undefined
                ? allowCreate
                : current.sessionId === (isSessionRollover ? initialEntry.sessionId : sessionId) &&
                  current.lifecycleRevision === initialEntry.lifecycleRevision)
            );
          },
        });
        // The commit already happened. Cleanup must retain ownership even if
        // cancellation invalidates the task during the awaited session write.
        sessionEntry = persisted;
        if (automaticReset && persisted) {
          clearCommittedSessionResetRuntimeState({
            previousSessionEntry: initialEntry,
            agentId: sessionAgentId,
            sessionKey,
            storePath,
            signal: opts.abortSignal,
            onError: (error) =>
              log.warn(`Failed to clear reset runtime state: ${diagnosticError(error)}`),
          });
        }
        if (operatorSession && (!persisted || persisted.sessionId !== sessionId)) {
          throw createSessionWorkStartChangedError(sessionKey);
        }
        operatorSession?.assertAuthorized(persisted);
      }
      if (sessionEntry && sessionKey && !suppressVisibleSessionEffects) {
        sessionEntry = await prepareCommandSessionDiffBaseline({
          agentId: sessionAgentId,
          cwd: cwd ?? workspaceDir,
          entry: sessionEntry,
          isNewSession,
          sessionKey,
          storePath,
          sessionStore,
        });
      }
      await prepareDeliveryForRun(sessionEntry);

      if (!isRawModelRun && acpResolution?.kind === "ready" && sessionKey) {
        assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        preparedRunAdmission = prepareAgentCommandExecutionIdentity({
          opts,
          prepared,
          ingress: admissionIngress,
          lifecycleGeneration,
        });
        return await runAcpAgentCommand({
          ...preparedContext,
          deps: resolvedDeps,
          runtime,
          opts,
          sessionEntry,
          suppressVisibleSessionEffects,
          provenance: isSubagentLane ? "agent" : sessionStateActor.actorType,
          sessionKey,
          lifecycleGeneration,
          acpResolution,
          trackInternalModelRunTarget,
          preparedRunAdmission,
        });
      }

      const embeddedSessionState = await measureAgentStartup(
        "session-state",
        () =>
          prepareEmbeddedSessionState({
            ...preparedContext,
            opts,
            sessionEntry,
            lifecycleGeneration,
            executionWorkspaceDir: cwd ?? workspaceDir,
            watchSkills,
            isSubagentLaneTurn: isSubagentLane,
            suppressVisibleSessionEffects,
            verboseDefault: (resolveAgentConfig(cfg, sessionAgentId)?.verboseDefault ??
              agentCfg?.verboseDefault) as VerboseLevel | undefined,
            sessionStateActor,
            ...(manifestMetadataSnapshot
              ? { pluginMetadataSnapshot: manifestMetadataSnapshot }
              : {}),
          }),
        { config: cfg },
      );
      ({ sessionEntry, opts } = embeddedSessionState);
      const { requestedThinkLevel, runContext } = embeddedSessionState;

      const modelSelection = await measureAgentStartup(
        "model-selection",
        () =>
          resolveEmbeddedModelSelection({
            ...preparedContext,
            opts,
            sessionEntry,
            requestedThinkLevel,
            suppressVisibleSessionEffects,
            runContext,
          }),
        { config: cfg },
      );
      sessionEntry = modelSelection.sessionEntry;
      const { prepared: attemptPrepared, admission } = await prepareCommandForegroundRun({
        prepared,
        opts,
        sessionEntry,
        embeddedSessionState,
        modelSelection,
        lifecycleGeneration,
        ingress: admissionIngress,
        suppressVisibleSessionEffects,
        onCommittedSessionId: (committedSessionId) => {
          runOwnedSessionId = committedSessionId;
          recordCompactionSessionId(committedSessionId);
        },
      });
      preparedRunAdmission = admission;
      sessionEntry = attemptPrepared.sessionEntry;
      if (attemptPrepared.sessionId !== runOwnedSessionId) {
        runOwnedSessionId = attemptPrepared.sessionId;
        recordCompactionSessionId(runOwnedSessionId);
      }
      const embeddedAttempt = await runEmbeddedAgentAttempt({
        prepared: attemptPrepared,
        opts,
        sessionEntry,
        lifecycleGeneration,
        onLifecycleGenerationChanged: (nextLifecycleGeneration) => {
          lifecycleGeneration = nextLifecycleGeneration;
        },
        onCompactionAccounting: (fact) => {
          if (fact.kind === "durable") {
            runOwnedSessionId = fact.target.sessionId;
            if (fact.previousSessionId !== undefined) {
              recordCompactionSessionId(fact.target.sessionId);
            }
          }
        },
        suppressVisibleSessionEffects,
        preserveUserFacingSessionModelState,
        modelSelection,
        embeddedSessionState,
        trackInternalModelRunTarget,
        preparedRunAdmission,
      });
      if (embeddedAttempt.fallbackExhausted) {
        opts.onModelFallbackExhausted?.();
      }
      sessionEntry = embeddedAttempt.sessionEntry;
      lifecycleGeneration = embeddedAttempt.lifecycleGeneration;
      const finalized = await finalizeEmbeddedAgentCommand({
        admittedDeliverySource: preparedRunAdmission.finalDeliverySource,
        prepared: attemptPrepared,
        opts,
        deps: resolvedDeps,
        runtime,
        sessionEntry,
        attempt: embeddedAttempt,
        embeddedSessionState,
        suppressVisibleSessionEffects,
        preserveUserFacingSessionModelState,
        currentRunDeliveryContext,
        sessionOwnership: { runOwnedSessionId, sessionReboundDuringRun },
        onSessionOwnershipChanged: (ownership, committedCompactionSessionId) => {
          runOwnedSessionId = ownership.runOwnedSessionId;
          sessionReboundDuringRun = ownership.sessionReboundDuringRun;
          if (committedCompactionSessionId) {
            recordCompactionSessionId(committedCompactionSessionId);
          }
        },
      });
      sessionEntry = finalized.sessionEntry;
      runOwnedSessionId = finalized.runOwnedSessionId;
      sessionReboundDuringRun = finalized.sessionReboundDuringRun;
      maintenanceRequest = finalized.maintenance;
      return finalized.deliveryResult;
    });
  } catch (error) {
    commandError = error;
    throw error;
  } finally {
    if (maintenanceRequest) {
      retainMaintenanceRequest?.(maintenanceRequest);
    }
    await finishAgentCommandCleanup({
      prepared,
      terminalError: commandError,
      lifecycleGeneration,
      beforeTerminalDelivery: opts.beforeTerminalDelivery,
      reportCommitted: compactionSessionIdReporter.reportCommitted,
      preparedRunAdmission,
      sessionWorkAdmission,
      cleanupInternalModelRunTargets,
      releaseForeground,
    });
  }
}

async function agentCommandWithAdmissionIngress(
  opts: AgentCommandOpts,
  admissionIngress: AgentCommandAdmissionIngress,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  return await runLocalAgentCommand({
    opts,
    runtime,
    deps,
    operatorAuthority: admissionIngress.kind === "local-cli",
    run: async (prepared, resolvedDeps) =>
      await agentCommandInternal(prepared, admissionIngress, runtime, resolvedDeps),
  });
}

export async function agentCommand(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  const { localIngress } = executionIdentity;
  return await agentCommandWithAdmissionIngress(opts, localIngress, runtime, deps);
}

export async function agentCommandFromSystem(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  const ingress = executionIdentity.systemIngress("gateway.boot");
  return await agentCommandWithAdmissionIngress(opts, ingress, runtime, deps);
}

async function agentCommandFromIngressInternal(
  opts: AgentCommandGatewayIngressOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
  runtimeContext?: PreparedAgentCommandRuntimeContext,
) {
  if (typeof opts.allowModelOverride !== "boolean") {
    throw new Error("allowModelOverride must be explicitly set for ingress agent runs.");
  }
  const ingressRuntime = withoutRuntimeOutput(runtime);
  const lifecycleGeneration =
    opts.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(opts.runId ?? "");
  const generation = runtimeContext?.pluginGeneration;
  const executeIngress = () =>
    withAgentRunLifecycleGeneration(lifecycleGeneration, async () => {
      let preparedAgentDir: string | undefined;
      const prepared = await prepareAgentCommandExecution(
        { ...opts, lifecycleGeneration, senderIsOwner: opts.senderIsOwner === true },
        ingressRuntime,
        runtimeContext,
      );
      preparedAgentDir = prepared.agentDir;
      const run = async () =>
        await agentCommandInternal(
          prepared,
          { kind: "api", boundary: "agent-command.from-ingress", state: "unknown" },
          ingressRuntime,
          deps,
          true,
        );
      const result = generation
        ? await run()
        : await withAgentPluginRegistry({
            config: prepared.cfg,
            workspaceDir: prepared.workspaceDir,
            run,
          });

      if (result && preparedAgentDir) {
        emitIngressModelUsageDiagnostic(result, opts, preparedAgentDir);
      }
      return result;
    });
  return generation && runtimeContext
    ? await withPluginRuntimeGenerationScope(
        {
          metadataSnapshot: generation.pluginMetadataSnapshot,
          pluginRegistry: generation.pluginRegistry,
        },
        executeIngress,
      )
    : await executeIngress();
}

/** Runs an agent turn from an inbound channel/gateway ingress context. */
export async function agentCommandFromIngress(
  opts: AgentCommandIngressOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  // Public callers cannot supply host-issued authority or execution identity.
  return await agentCommandFromIngressInternal(
    sanitizePublicAgentCommandIngressOpts(opts),
    runtime,
    deps,
  );
}

/** Runs an ingress turn in the prepared Gateway runtime. */
export async function agentCommandFromGatewayIngress(
  opts: AgentCommandGatewayIngressOpts,
  runtime: RuntimeEnv,
  deps: CliDeps | undefined,
  runtimeContext?: PreparedAgentCommandRuntimeContext,
) {
  return await agentCommandFromIngressInternal(opts, runtime, deps, runtimeContext);
}
