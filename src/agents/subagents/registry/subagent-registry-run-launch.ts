import { resolvePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  normalizeAgentIdStrict,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../../routing/session-key.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import {
  prepareTerminatedCollectorLaunch,
  prepareSwarmCollectorCompletion,
  clearPublishedSwarmCollectorOutput,
  updateSwarmCollectorCompletion,
} from "../swarm/swarm-collector.js";
import { bindSwarmRunReservation } from "../swarm/swarm-scheduler.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import {
  SubagentRegistryWriteError,
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
  waitForPendingSubagentKillClaim,
} from "./subagent-registry-persistence.js";
import { registerRequiredQueuedSubagent } from "./subagent-registry-queued-registration.js";
import {
  createSubagentRegistrationRecord,
  type RegisterSubagentRunParams,
} from "./subagent-registry-run-launch-record.js";
import { SubagentRecoveryManager } from "./subagent-registry-run-recovery.js";
import type {
  RegisterSubagentRunOptions,
  SubagentRegistrationScope,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import {
  bindSubagentRunRuntimeKey,
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
  latestSubagentRun,
  nextSubagentRunGeneration,
} from "./subagent-run-generation.js";

function resolveSwarmWaitOwnerSessionKeys(
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>,
  requesterSessionKey: string,
): string[] {
  const ownerSessionKeys: string[] = [];
  const visited = new Set<string>();
  let currentSessionKey = requesterSessionKey.trim();
  while (currentSessionKey && !visited.has(currentSessionKey)) {
    visited.add(currentSessionKey);
    ownerSessionKeys.push(currentSessionKey);
    const latestOwner = latestSubagentRun(getRunsForChildSession(currentSessionKey));
    currentSessionKey =
      latestOwner?.controllerSessionKey?.trim() || latestOwner?.requesterSessionKey.trim() || "";
  }
  return ownerSessionKeys;
}

export class SubagentLaunchManager extends SubagentRecoveryManager {
  private findRunByIdentity(runId: string): SubagentRunRecord | undefined {
    return (
      this.options.runs.get(runId) ??
      [...this.options.runs.values()].find((candidate) => candidate.swarmRunId === runId)
    );
  }

  readonly registerSubagentRun = async (
    registerParams: RegisterSubagentRunParams,
    options: RegisterSubagentRunOptions = {},
  ): Promise<void> => {
    const runId = registerParams.runId.trim();
    const childSessionKey = registerParams.childSessionKey.trim();
    const requesterSessionKey = registerParams.requesterSessionKey.trim();
    if (!runId || !childSessionKey || !requesterSessionKey) {
      return;
    }
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const cfg = this.options.getRuntimeConfig();
    const requesterAgentId = resolveSubagentRequesterAgentId(cfg, registerParams);
    const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
    const keyAgentId = parseAgentSessionKey(childSessionKey)?.agentId;
    const explicitChildAgentId =
      registerParams.childAgentId === undefined
        ? undefined
        : normalizeAgentIdStrict(registerParams.childAgentId);
    if (explicitChildAgentId && !explicitChildAgentId.ok) {
      throw new Error("Subagent registration has an invalid child agent id.");
    }
    if (keyAgentId && explicitChildAgentId && keyAgentId !== explicitChildAgentId.value) {
      throw new Error("Subagent registration child agent disagrees with its session key.");
    }
    const context = captureOpenClawStateWorkerContext();
    const selected = this.options.runs.get(runId);
    const registrationOwnership = subagentRuns.captureRegistrationOwnership(childSessionKey);
    let authority: Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>;
    let registered: SubagentRunRecord | undefined;
    let custodyTransferred = false;
    let queuedScope: SubagentRegistrationScope | undefined;
    let initialOutcome: "pending" | "refused" | "uncertain" = "pending";
    let initialFailure: unknown;
    const canCleanupRefusedIntent = () => {
      if (
        initialOutcome !== "refused" ||
        this.options.runs.has(runId) ||
        [...this.options.getRunsForChildSession(childSessionKey)].length > 0 ||
        !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
      ) {
        return false;
      }
      try {
        assertSubagentRegistryWriteSourceCurrent(context);
        return true;
      } catch {
        return false;
      }
    };
    if (registerParams.queued) {
      options.retainOwnership?.(
        Object.freeze({
          waitForClaim: () => queuedScope?.waitForClaim(),
          waitForRetirementPublication: () => queuedScope?.waitForRetirementPublication(),
          canLaunch: () => queuedScope?.canLaunch() ?? false,
          canAcceptLaunch: () => queuedScope?.canAcceptLaunch() ?? false,
          canCleanupSession: () => queuedScope?.canCleanupSession() ?? canCleanupRefusedIntent(),
          canRetireReservation: () =>
            queuedScope?.canRetireReservation() ?? canCleanupRefusedIntent(),
          settleFailedLaunch: async (error: string) => {
            if (queuedScope) {
              return queuedScope.settleFailedLaunch(error);
            }
            if (initialOutcome === "uncertain") {
              throw initialFailure;
            }
            if (initialOutcome === "pending") {
              throw new SubagentRegistryMutationRejectedError(
                "Queued registration has not settled",
              );
            }
          },
        }),
      );
    }
    try {
      authority = registerParams.collect
        ? undefined
        : await captureOperatorToolGatewayContinuationContext();
      const runIds = new Set([
        runId,
        ...Array.from(this.options.getRunsForChildSession(childSessionKey), (row) => row.runId),
      ]);
      const assertCurrent = () => {
        options.assertCurrent?.();
        authority?.assertCurrent();
        authority?.signal.throwIfAborted();
        registrationOwnership.assertCurrent();
        if (!isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
          throw new SubagentRegistryMutationRejectedError(
            "Subagent registration lifecycle changed",
          );
        }
      };
      const result = await mutateSubagentRuns(
        [...runIds],
        (rows) => {
          assertCurrent();
          const previous = rows.get(runId);
          if (previous && options.acceptedRunReplay === true) {
            if (
              previous.childSessionKey !== childSessionKey ||
              previous.requesterSessionKey !== requesterSessionKey ||
              previous.requesterAgentId !== requesterAgentId ||
              previous.requesterTurnRunId !==
                (registerParams.requesterTurnRunId?.trim() || undefined) ||
              previous.expectsCompletionMessage !== registerParams.expectsCompletionMessage ||
              Boolean(previous.collect) !== Boolean(registerParams.collect)
            ) {
              throw new SubagentRegistryMutationRejectedError(
                "Accepted run already has another completion owner; inspect it before retrying.",
              );
            }
            subagentRuns.runWithCompletionAuthority(previous, () => options.assertCurrent?.());
            return { value: undefined };
          }
          if (selected ? !isSameSubagentRunOwner(previous, selected) : previous !== undefined) {
            throw new SubagentRegistryMutationRejectedError(
              "Subagent registration owner changed during preparation",
            );
          }
          const siblings = [...this.options.getRunsForChildSession(childSessionKey)];
          if (siblings.some((row) => !runIds.has(row.runId))) {
            throw new SubagentRegistryMutationRejectedError("Subagent registration cohort changed");
          }
          const entry = createSubagentRegistrationRecord(registerParams, {
            now: Date.now(),
            generation: nextSubagentRunGeneration(siblings, childSessionKey),
            lifecycleGeneration,
            requesterAgentId,
            requesterOrigin: normalizeDeliveryContext(registerParams.requesterOrigin),
            swarmWaitOwnerSessionKeys:
              registerParams.collect && registerParams.swarmRequesterSessionKey
                ? resolveSwarmWaitOwnerSessionKeys(
                    this.options.getRunsForChildSession,
                    registerParams.swarmRequesterSessionKey,
                  )
                : undefined,
          });
          entry.requesterStorePath =
            previous?.requesterStorePath ??
            resolvePhysicalSessionStorePath(
              { sessionKey: requesterSessionKey, agentId: requesterAgentId },
              cfg,
            );
          entry.controllerStorePath =
            previous?.controllerStorePath ??
            resolvePhysicalSessionStorePath(
              {
                sessionKey: controllerSessionKey,
                agentId: resolveAgentIdFromSessionKey(controllerSessionKey, requesterAgentId),
              },
              cfg,
            );
          entry.childAgentId = previous
            ? previous.childAgentId
            : keyAgentId
              ? undefined
              : explicitChildAgentId?.value;
          if (registerParams.queued) {
            entry.queuedLaunch = undefined;
          }
          const postimages = this.planSupersededKillReconciliations(rows, entry);
          postimages.set(runId, entry);
          return { value: entry, postimages };
        },
        {
          runs: this.options.runs,
          context,
          assertCurrent,
          onPublished: (postimages, planned) => {
            const entry = planned && postimages.get(planned.runId);
            if (!entry) {
              return;
            }
            registered = entry;
            try {
              if (authority?.operatorAuthority) {
                subagentRuns.bindCompletionAuthority(entry, authority);
                custodyTransferred = true;
              }
            } finally {
              bindGatewayContextResolver(entry, registerParams.gatewayContextResolver);
              subagentRuns.commitOwnership(entry);
              bindSwarmRunReservation(
                entry.schedulerSlotId ?? runId,
                getSubagentRunRuntimeKey(entry),
                () => {
                  const current = getCurrentSubagentRunOwner(this.options.runs, entry);
                  if (current) {
                    emitSessionLifecycleEvent({
                      sessionKey: current.childSessionKey,
                      reason: "run-capacity",
                      scope: "runtime",
                    });
                  }
                },
              );
            }
          },
        },
      );
      if (!result) {
        return;
      }
      const activate = () => {
        this.options.ensureListener();
        this.options.startSweeper();
      };
      if (registerParams.queued) {
        await registerRequiredQueuedSubagent({
          context,
          entry: registered ?? result,
          queuedLaunch: registerParams.queuedLaunch,
          manager: this.options,
          activate,
          ...options,
          retainOwnership: (scope) => {
            queuedScope = scope;
          },
        });
      } else {
        activate();
        void this.waitForSubagentCompletion(
          runId,
          this.options.resolveSubagentWaitTimeoutMs(cfg, registerParams.runTimeoutSeconds ?? 0),
          result,
        );
      }
    } catch (error) {
      if (!queuedScope) {
        initialOutcome =
          hasSqliteWorkerOutcomeUnknown(error) || registered ? "uncertain" : "refused";
        initialFailure = error;
      }
      if (
        registered &&
        error instanceof SubagentRegistryWriteError &&
        error.outcome === "not-committed"
      ) {
        subagentRuns.releaseCompletionAuthority(registered);
      }
      throw error;
    } finally {
      if (!custodyTransferred) {
        authority?.release();
      }
      registrationOwnership.release();
    }
  };

  readonly startQueuedSubagentRun = async (
    runId: string,
    gatewayRunId?: string,
    lifecycleGeneration?: string,
    gatewayContextResolver?: GatewayContextResolver,
  ): Promise<boolean> => {
    const selected = this.findRunByIdentity(runId.trim());
    if (!selected) {
      return false;
    }
    const nextRunId = gatewayRunId?.trim() || selected.runId;
    const acceptedLifecycleGeneration = lifecycleGeneration ?? getAgentEventLifecycleGeneration();
    if (!isAgentEventLifecycleGenerationCurrent(acceptedLifecycleGeneration)) {
      return false;
    }
    const assertLaunchCurrent = () => {
      if (!isAgentEventLifecycleGenerationCurrent(acceptedLifecycleGeneration)) {
        throw new SubagentRegistryMutationRejectedError(
          "Queued subagent launch lifecycle changed before commit",
        );
      }
    };
    const context = captureOpenClawStateWorkerContext();
    const started = await mutateSubagentRuns(
      [selected.runId, nextRunId],
      (rows) => {
        const current = rows.get(selected.runId);
        if (
          !current ||
          !isSameSubagentRunOwner(current, selected) ||
          !isAgentEventLifecycleGenerationCurrent(acceptedLifecycleGeneration)
        ) {
          return { value: undefined };
        }
        const lifecycleStarted =
          current.execution.status === "running" &&
          typeof current.execution.startedAt === "number" &&
          current.swarmLaunchPending === true;
        const terminalBeforeAcceptance =
          current.collectorCompletion !== undefined && current.queuedLaunch !== undefined;
        if (
          current.killIntent ||
          current.killReconciliation ||
          waitForPendingSubagentKillClaim(current, context.admission) ||
          (current.swarmLaunchPending === true &&
            typeof current.execution.endedAt === "number" &&
            current.collectorCompletion === undefined) ||
          (!terminalBeforeAcceptance && current.execution.status !== "queued" && !lifecycleStarted)
        ) {
          return { value: undefined };
        }
        if (nextRunId !== current.runId && rows.get(nextRunId)) {
          throw new SubagentRegistryMutationRejectedError(
            `collector gateway run id already exists: ${nextRunId}`,
          );
        }
        const entry = structuredClone(current);
        entry.swarmRunId ??= current.runId;
        entry.schedulerSlotId ??= entry.swarmRunId;
        entry.runId = nextRunId;
        if (!terminalBeforeAcceptance) {
          const startedAt =
            current.execution.status === "running" ? current.execution.startedAt : undefined;
          entry.execution = {
            ...entry.execution,
            status: "running",
            acceptedAt: Date.now(),
            lifecycleGeneration: acceptedLifecycleGeneration,
            restartRecovery: undefined,
            suppressSessionEffects: undefined,
            startedAt,
          };
          entry.sessionStartedAt =
            typeof startedAt === "number" ? (entry.sessionStartedAt ?? startedAt) : undefined;
        }
        entry.swarmLaunchPending = false;
        entry.queuedLaunch = undefined;
        bindSubagentRunRuntimeKey(entry, getSubagentRunRuntimeKey(current));
        const postimages = new Map<string, SubagentRunRecord | null>([[nextRunId, entry]]);
        if (selected.runId !== nextRunId) {
          postimages.set(selected.runId, null);
        }
        return {
          value: { source: current, entry, terminalBeforeAcceptance },
          postimages,
          ...(current.runId !== nextRunId ? { rekeys: new Map([[current.runId, nextRunId]]) } : {}),
        };
      },
      {
        runs: this.options.runs,
        context,
        assertCurrent: assertLaunchCurrent,
        onPublished: (postimages, result) => {
          const entry = postimages.get(nextRunId);
          if (entry && result) {
            if (result.source.runId !== entry.runId) {
              subagentRuns.publishQueuedSubagentRunRekey(result.source, entry);
            }
            bindGatewayContextResolver(entry, gatewayContextResolver);
          }
        },
      },
    );
    if (!started) {
      return false;
    }
    if (!started.terminalBeforeAcceptance) {
      void this.waitForSubagentCompletion(
        nextRunId,
        this.options.resolveSubagentWaitTimeoutMs(
          this.options.getRuntimeConfig(),
          started.entry.runTimeoutSeconds,
        ),
        started.entry,
      );
    }
    return true;
  };

  readonly failQueuedSubagentRun = async (runId: string, error: string): Promise<boolean> => {
    const selected = this.findRunByIdentity(runId.trim());
    if (!selected) {
      return false;
    }
    const context = captureOpenClawStateWorkerContext();
    const prepared = await prepareSwarmCollectorCompletion(
      selected,
      this.options.getRuntimeConfig(),
      () => assertSubagentRegistryWriteSourceCurrent(context),
    );
    return mutateSubagentRuns(
      [selected.runId],
      (rows) => {
        const current = rows.get(selected.runId);
        if (
          !current ||
          !isSameSubagentRunOwner(current, selected) ||
          current.execution.status !== "queued" ||
          current.killIntent ||
          current.killReconciliation
        ) {
          return { value: false };
        }
        const entry = structuredClone(current);
        const endedAt = Date.now();
        entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
        entry.execution = {
          ...entry.execution,
          status: "terminal",
          endedAt,
          outcome: { status: "error", error, endedAt },
        };
        entry.queuedLaunch = undefined;
        entry.collectorLaunchCleanupPending = true;
        entry.completion = { required: false, resultText: error, capturedAt: endedAt };
        updateSwarmCollectorCompletion(entry, this.options.getRuntimeConfig(), prepared);
        return { value: true, postimages: new Map([[entry.runId, entry]]) };
      },
      {
        runs: this.options.runs,
        context,
        onPublished: (postimages) => {
          const published = postimages.get(selected.runId);
          if (published) {
            clearPublishedSwarmCollectorOutput(published);
          }
        },
      },
    );
  };

  readonly settleFailedQueuedSubagentLaunch = async (
    runId: string,
    error: string,
  ): Promise<boolean> => {
    const selected = this.findRunByIdentity(runId);
    if (!selected?.collect) {
      return false;
    }
    if (typeof selected.execution.endedAt !== "number") {
      return this.failQueuedSubagentRun(runId, error);
    }
    const context = captureOpenClawStateWorkerContext();
    const prepared = await prepareSwarmCollectorCompletion(
      selected,
      this.options.getRuntimeConfig(),
      () => assertSubagentRegistryWriteSourceCurrent(context),
    );
    return mutateSubagentRuns(
      [selected.runId],
      (rows) => {
        const current = rows.get(selected.runId);
        if (
          !current ||
          !isSameSubagentRunOwner(current, selected) ||
          !current.collect ||
          current.killIntent ||
          typeof current.execution.endedAt !== "number"
        ) {
          return { value: false };
        }
        if (current.collectorCompletion) {
          return { value: true };
        }
        const entry = structuredClone(current);
        prepareTerminatedCollectorLaunch(
          entry,
          current.execution.endedAt,
          error,
          () => this.options.getRuntimeConfig(),
          prepared,
        );
        return { value: true, postimages: new Map([[entry.runId, entry]]) };
      },
      {
        runs: this.options.runs,
        context,
        onPublished: (postimages) => {
          const published = postimages.get(selected.runId);
          if (published) {
            clearPublishedSwarmCollectorOutput(published);
          }
        },
      },
    );
  };
}
