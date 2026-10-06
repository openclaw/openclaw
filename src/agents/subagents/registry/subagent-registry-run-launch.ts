import { resolvePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
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
import { bindSwarmRunReservation, ownsSwarmRunReservation } from "../swarm/swarm-scheduler.js";
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import {
  getCurrentSubagentRunOwner,
  subagentRuns,
  waitForSubagentRetirementPublication,
} from "./subagent-registry-memory.js";
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
  compareSubagentRunGeneration,
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
  latestSubagentRun,
  nextSubagentRunGeneration,
} from "./subagent-run-generation.js";

function resolveSwarmWaitOwnerSessionKeys(
  getRunsForChildSession: (
    childSessionKey: string,
    childAgentId?: string,
  ) => Iterable<SubagentRunRecord>,
  requesterSessionKey: string,
  requesterAgentId?: string,
): string[] {
  const ownerSessionKeys: string[] = [];
  const visited: Array<{ childSessionKey: string; childAgentId?: string }> = [];
  let currentSessionKey = requesterSessionKey.trim();
  let currentAgentId = requesterAgentId;
  while (
    currentSessionKey &&
    !visited.some((entry) =>
      matchesSubagentChildSessionOwner(entry, currentSessionKey, currentAgentId),
    )
  ) {
    visited.push({ childSessionKey: currentSessionKey, childAgentId: currentAgentId });
    ownerSessionKeys.push(currentSessionKey);
    const latestOwner = latestSubagentRun(
      getRunsForChildSession(currentSessionKey, currentAgentId),
    );
    currentSessionKey =
      latestOwner?.controllerSessionKey?.trim() || latestOwner?.requesterSessionKey.trim() || "";
    currentAgentId =
      parseAgentSessionKey(currentSessionKey)?.agentId ?? latestOwner?.requesterAgentId;
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
    const gatewayContextResolver = registerParams.gatewayContextResolver;
    const gatewayContext = gatewayContextResolver?.();
    const selected = this.options.runs.get(runId);
    const childAgentId = selected
      ? selected.childAgentId
      : keyAgentId
        ? undefined
        : explicitChildAgentId?.value;
    const registrationOwnership = subagentRuns.captureRegistrationOwnership(
      childSessionKey,
      undefined,
      childAgentId,
    );
    let authority: Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>;
    let plannedEntry: SubagentRunRecord | undefined;
    let registered: SubagentRunRecord | undefined;
    let custodyTransferred = false;
    let queuedScope: SubagentRegistrationScope | undefined;
    let initialOutcome: "pending" | "refused" | "uncertain" = "pending";
    let initialFailure: unknown;
    let registrationSettled = false;
    let activated = false;
    const currentEntry = () =>
      registered && getCurrentSubagentRunOwner(this.options.runs, registered);
    const registryCurrent = () => {
      try {
        assertSubagentRegistryWriteSourceCurrent(context);
        return isAgentEventLifecycleGenerationCurrent(lifecycleGeneration);
      } catch {
        return false;
      }
    };
    const ownsSession = () => {
      const observed = registered ?? plannedEntry;
      return (
        !registrationOwnership.superseded &&
        (!this.options.runs.has(runId) ||
          (observed !== undefined &&
            isSameSubagentRunOwner(this.options.runs.get(runId), observed))) &&
        !Array.from(this.options.getRunsForChildSession(childSessionKey, childAgentId)).some(
          (candidate) =>
            !observed ||
            (!isSameSubagentRunOwner(candidate, observed) &&
              compareSubagentRunGeneration(candidate, observed) > 0),
        )
      );
    };
    const canCleanupRefusedIntent = () =>
      initialOutcome === "refused" &&
      !this.options.runs.has(runId) &&
      [...this.options.getRunsForChildSession(childSessionKey, childAgentId)].length === 0 &&
      registryCurrent();
    const activate = () => {
      this.options.ensureListener();
      this.options.startSweeper();
    };
    try {
      options.retainOwnership?.(
        registerParams.queued
          ? Object.freeze({
              waitForClaim: () => queuedScope?.waitForClaim(),
              waitForRetirementPublication: () => queuedScope?.waitForRetirementPublication(),
              canLaunch: () => queuedScope?.canLaunch() ?? false,
              canAcceptLaunch: () => queuedScope?.canAcceptLaunch() ?? false,
              canAbortAcceptedRun: () => queuedScope?.canAbortAcceptedRun() ?? false,
              canCleanupSession: () =>
                queuedScope?.canCleanupSession() ?? canCleanupRefusedIntent(),
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
            })
          : Object.freeze({
              waitForClaim: () => undefined,
              waitForRetirementPublication: () =>
                registered && waitForSubagentRetirementPublication(registered),
              canLaunch: () =>
                activated && registryCurrent() && Boolean(currentEntry()) && ownsSession(),
              canAcceptLaunch: () =>
                registered !== undefined &&
                !subagentRuns.isCompletionAuthorityRetired(registered) &&
                registryCurrent() &&
                Boolean(currentEntry()) &&
                ownsSession(),
              canAbortAcceptedRun: () => registryCurrent() && ownsSession(),
              canCleanupSession: () =>
                registrationSettled &&
                initialOutcome !== "uncertain" &&
                registryCurrent() &&
                ownsSession() &&
                !currentEntry(),
              canRetireReservation: () =>
                Boolean(
                  registered &&
                  ownsSwarmRunReservation(
                    registered.schedulerSlotId ?? runId,
                    getSubagentRunRuntimeKey(registered),
                  ),
                ),
              settleFailedLaunch: async () => {
                if (initialOutcome === "uncertain") {
                  throw initialFailure;
                }
              },
            }),
      );
      authority = registerParams.collect
        ? undefined
        : await captureOperatorToolGatewayContinuationContext();
      const runIds = new Set([
        runId,
        ...Array.from(
          this.options.getRunsForChildSession(childSessionKey, childAgentId),
          (row) => row.runId,
        ),
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
          const siblings = [...this.options.getRunsForChildSession(childSessionKey, childAgentId)];
          if (siblings.some((row) => !runIds.has(row.runId))) {
            throw new SubagentRegistryMutationRejectedError("Subagent registration cohort changed");
          }
          const entry = createSubagentRegistrationRecord(registerParams, {
            now: Date.now(),
            generation: nextSubagentRunGeneration(siblings, childSessionKey, childAgentId),
            lifecycleGeneration,
            requesterAgentId,
            requesterOrigin: normalizeDeliveryContext(registerParams.requesterOrigin),
            swarmWaitOwnerSessionKeys:
              registerParams.collect && registerParams.swarmRequesterSessionKey
                ? resolveSwarmWaitOwnerSessionKeys(
                    this.options.getRunsForChildSession,
                    registerParams.swarmRequesterSessionKey,
                    requesterAgentId,
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
          plannedEntry = entry;
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
              options.assertPublicationCurrent?.();
              if (authority?.operatorAuthority) {
                subagentRuns.bindCompletionAuthority(entry, authority);
                custodyTransferred = true;
              }
            } finally {
              bindGatewayContextResolver(entry, gatewayContextResolver);
              if (!registrationOwnership.superseded) {
                registrationOwnership.accept(entry);
              }
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
      const published = currentEntry();
      if (!published) {
        throw new SubagentRegistryMutationRejectedError(
          "Subagent registration lost its acknowledged run owner",
        );
      }
      if (registerParams.queued) {
        await registerRequiredQueuedSubagent({
          context,
          entry: published,
          queuedLaunch: registerParams.queuedLaunch,
          manager: this.options,
          activate,
          ...options,
          retainOwnership: (scope) => {
            queuedScope = scope;
          },
        });
      } else {
        assertSubagentRegistryWriteSourceCurrent(context);
        options.assertCurrent?.();
        options.assertPublicationCurrent?.();
        authority?.assertCurrent();
        authority?.signal.throwIfAborted();
        const current = currentEntry();
        if (
          !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
          !current ||
          !ownsSession() ||
          current.killIntent ||
          current.killReconciliation ||
          getGatewayContextResolver(current) !== gatewayContextResolver ||
          (gatewayContextResolver &&
            (!gatewayContext || gatewayContextResolver() !== gatewayContext))
        ) {
          throw new SubagentRegistryMutationRejectedError(
            "Subagent registration lost its original run owner",
          );
        }
        activate();
        activated = true;
        void this.waitForSubagentCompletion(
          runId,
          this.options.resolveSubagentWaitTimeoutMs(cfg, registerParams.runTimeoutSeconds ?? 0),
          current,
        );
      }
    } catch (error) {
      if (!queuedScope) {
        initialOutcome =
          hasSqliteWorkerOutcomeUnknown(error) ||
          (error instanceof SubagentRegistryWriteError &&
            error.outcome === "committed" &&
            !registered)
            ? "uncertain"
            : "refused";
        initialFailure = error;
      }
      if (!registerParams.queued && registered && !activated) {
        subagentRuns.retireCompletionAuthority(registered);
        if (registryCurrent() && currentEntry()) {
          // A committed child still needs terminal observation after its caller retires.
          activate();
        }
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
      registrationSettled = true;
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

  readonly settleFailedQueuedSubagentLaunch = async (
    runId: string,
    error: string,
  ): Promise<boolean> => {
    const selected = this.findRunByIdentity(runId);
    if (!selected?.collect) {
      return false;
    }
    // Usage preparation can outlive completion; retain the phase selected for this attempt.
    const wasQueued = typeof selected.execution.endedAt !== "number";
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
        if (!current || !isSameSubagentRunOwner(current, selected) || current.killIntent) {
          return { value: false };
        }
        let entry: SubagentRunRecord;
        if (wasQueued) {
          if (current.execution.status !== "queued" || current.killReconciliation) {
            return { value: false };
          }
          entry = structuredClone(current);
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
        } else {
          const endedAt = current.execution.endedAt;
          if (!current.collect || typeof endedAt !== "number") {
            return { value: false };
          }
          if (current.collectorCompletion) {
            return { value: true };
          }
          entry = structuredClone(current);
          prepareTerminatedCollectorLaunch(
            entry,
            endedAt,
            error,
            () => this.options.getRuntimeConfig(),
            prepared,
          );
        }
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
