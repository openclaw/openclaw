import { resolvePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
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
  updateSwarmCollectorCompletion,
} from "../swarm/swarm-collector.js";
import { bindSwarmRunReservation } from "../swarm/swarm-scheduler.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  SubagentRegistryWriteError,
  publishSubagentRunPostimages,
  replaceSubagentRunRecord,
  waitForPendingSubagentKillClaim,
} from "./subagent-registry-persistence.js";
import { registerRequiredQueuedSubagent } from "./subagent-registry-queued-registration.js";
import {
  createSubagentRegistrationRecord,
  type RegisterSubagentRunParams,
} from "./subagent-registry-run-launch-record.js";
import { SubagentRecoveryManager } from "./subagent-registry-run-recovery.js";
import type { RegisterSubagentRunOptions, SubagentRunRecord } from "./subagent-registry.types.js";
import { latestSubagentRun, nextSubagentRunGeneration } from "./subagent-run-generation.js";

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

/** Owns subagent registration and queued collector launch transitions. */
export class SubagentLaunchManager extends SubagentRecoveryManager {
  private findRunByIdentity(runId: string): SubagentRunRecord | undefined {
    return (
      this.options.runs.get(runId) ??
      [...this.options.runs.values()].find((candidate) => candidate.swarmRunId === runId)
    );
  }

  readonly registerSubagentRun = (
    registerParams: RegisterSubagentRunParams,
    options: RegisterSubagentRunOptions = {},
  ): void | Promise<void> => {
    const runId = registerParams.runId.trim();
    const childSessionKey = registerParams.childSessionKey.trim();
    const requesterSessionKey = registerParams.requesterSessionKey.trim();
    if (!runId || !childSessionKey || !requesterSessionKey) {
      return;
    }
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const cfg = this.options.getRuntimeConfig();
    const now = Date.now();
    const runTimeoutSeconds = registerParams.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = this.options.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const requesterOrigin = normalizeDeliveryContext(registerParams.requesterOrigin);
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
    const previous = this.options.runs.get(runId);
    const previousGeneration = previous?.generation;
    const previousCreatedAt = previous?.createdAt;
    if (options.persistence === "worker" && previous) {
      options.assertCurrent?.();
      if (
        previous.childSessionKey !== childSessionKey ||
        previous.requesterSessionKey !== requesterSessionKey ||
        previous.requesterAgentId !== requesterAgentId ||
        previous.requesterTurnRunId !== (registerParams.requesterTurnRunId?.trim() || undefined) ||
        previous.expectsCompletionMessage !== registerParams.expectsCompletionMessage ||
        Boolean(previous.collect) !== Boolean(registerParams.collect)
      ) {
        throw new Error(
          "Accepted run already has another completion owner; inspect it before retrying.",
        );
      }
      // Admission replay retains the original result, generation, custody, and sole waiter.
      subagentRuns.runWithCompletionAuthority(previous, () => options.assertCurrent?.());
      return;
    }
    const requesterStorePath = previous
      ? previous.requesterStorePath
      : resolvePhysicalSessionStorePath(
          { sessionKey: requesterSessionKey, agentId: requesterAgentId },
          cfg,
        );
    const controllerStorePath = previous
      ? previous.controllerStorePath
      : resolvePhysicalSessionStorePath(
          {
            sessionKey: controllerSessionKey,
            agentId: resolveAgentIdFromSessionKey(controllerSessionKey, requesterAgentId),
          },
          cfg,
        );
    const childAgentId = previous
      ? previous.childAgentId
      : keyAgentId
        ? undefined
        : explicitChildAgentId?.value;
    const queued = registerParams.queued === true;
    const queuedContext = queued ? captureOpenClawStateWorkerContext() : undefined;
    const workerContext =
      !queued && options.persistence === "worker" ? captureOpenClawStateWorkerContext() : undefined;
    const registrationOwnership = subagentRuns.captureRegistrationOwnership(childSessionKey);
    let workerOwnsRegistration = false;
    const register = (
      completionAuthority?: Awaited<
        ReturnType<typeof captureOperatorToolGatewayContinuationContext>
      >,
    ): void | Promise<void> => {
      let custodyTransferred = false;
      try {
        completionAuthority?.assertCurrent();
        options.assertCurrent?.();
        completionAuthority?.signal.throwIfAborted();
        queuedContext?.admission.assertCurrent();
        if (!isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
          throw new Error("Subagent registration lifecycle changed during preparation");
        }
        if (
          this.options.runs.get(runId) !== previous ||
          previous?.generation !== previousGeneration ||
          previous?.createdAt !== previousCreatedAt
        ) {
          throw new Error("Subagent registration owner changed during preparation");
        }
        registrationOwnership.assertCurrent();
        const generation = nextSubagentRunGeneration(
          this.options.getRunsForChildSession(childSessionKey),
          childSessionKey,
        );
        const entry = createSubagentRegistrationRecord(registerParams, {
          now,
          generation,
          lifecycleGeneration,
          requesterAgentId,
          requesterOrigin,
          swarmWaitOwnerSessionKeys:
            registerParams.collect && registerParams.swarmRequesterSessionKey
              ? resolveSwarmWaitOwnerSessionKeys(
                  this.options.getRunsForChildSession,
                  registerParams.swarmRequesterSessionKey,
                )
              : undefined,
        });
        entry.requesterStorePath = requesterStorePath;
        entry.controllerStorePath = controllerStorePath;
        entry.childAgentId = childAgentId;
        if (completionAuthority?.operatorAuthority) {
          subagentRuns.bindCompletionAuthority(entry, completionAuthority);
          custodyTransferred = true;
        } else {
          completionAuthority?.release();
        }
        this.options.runs.set(runId, entry);
        bindGatewayContextResolver(entry, registerParams.gatewayContextResolver);
        const killReconciliationSnapshots = this.markOlderKillReconciliationsSuperseded(entry);
        const registeredRunIds = [
          runId,
          ...[...killReconciliationSnapshots.keys()].map((candidate) => candidate.runId),
        ];
        const rollbackRegistration = () => {
          this.options.runs.delete(runId);
          this.restoreKillReconciliationSnapshots(killReconciliationSnapshots);
        };
        const bindRegistrationReservation = () => {
          bindSwarmRunReservation(entry.schedulerSlotId ?? runId, entry, () => {
            if (this.options.runs.get(entry.runId) === entry) {
              emitSessionLifecycleEvent({
                sessionKey: entry.childSessionKey,
                reason: "run-capacity",
                scope: "runtime",
              });
            }
          });
        };
        const activateRegistrationLifecycle = () => {
          bindRegistrationReservation();
          subagentRuns.commitOwnership(entry);
          this.options.ensureListener();
          // Session-mode and persistence-recovery runs also need TTL cleanup.
          this.options.startSweeper();
          if (!queued) {
            void this.waitForSubagentCompletion(runId, waitTimeoutMs, entry);
          }
        };
        if (queuedContext) {
          return registerRequiredQueuedSubagent({
            context: queuedContext,
            entry,
            manager: this.options,
            originals: killReconciliationSnapshots,
            bindReservation: bindRegistrationReservation,
            activate: activateRegistrationLifecycle,
            ...options,
          });
        }
        if (workerContext) {
          const preimages = new Map<SubagentRunRecord, SubagentRunRecord | undefined>([
            [entry, undefined],
          ]);
          for (const [row, killReconciliation] of killReconciliationSnapshots) {
            preimages.set(row, { ...row, killReconciliation });
          }
          const assertPublicationCurrent = () => {
            options.assertPublicationCurrent?.();
            if (custodyTransferred) {
              completionAuthority?.assertCurrent();
            }
            registrationOwnership.assertCurrent();
            if (!isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
              throw new Error("Subagent registration changed before worker publication");
            }
          };
          const assertRegistrationCurrent = () => {
            options.assertCurrent?.();
            assertPublicationCurrent();
          };
          workerOwnsRegistration = true;
          return (async () => {
            try {
              const result = await publishSubagentRunPostimages({
                runs: this.options.runs,
                previous: preimages,
                persist: this.options.persistAsyncOrThrow,
                context: workerContext,
                assertCurrent: assertRegistrationCurrent,
                assertPublicationCurrent,
                onPublished: activateRegistrationLifecycle,
              });
              if (result.publication !== "published") {
                throw new SubagentRegistryWriteError(
                  "committed",
                  new Error("Subagent registration changed before worker publication"),
                  result.publication,
                );
              }
            } catch (error) {
              // Ambiguous commits retain private custody and the persistence owner's write fence.
              if (
                error instanceof SubagentRegistryWriteError &&
                error.outcome === "not-committed"
              ) {
                subagentRuns.releaseCompletionAuthority(entry);
              }
              throw error;
            } finally {
              registrationOwnership.release();
            }
          })();
        }
        try {
          this.options.persistOrThrow(...registeredRunIds);
        } catch (error) {
          rollbackRegistration();
          subagentRuns.releaseCompletionAuthority(entry);
          throw error;
        }
        // Wait through Gateway RPC; the in-process lifecycle listener is the embedded fallback.
        activateRegistrationLifecycle();
      } catch (error) {
        if (!custodyTransferred) {
          completionAuthority?.release();
        }
        throw error;
      } finally {
        if (!workerOwnsRegistration) {
          registrationOwnership.release();
        }
      }
    };
    try {
      const preparation = registerParams.collect
        ? undefined
        : captureOperatorToolGatewayContinuationContext();
      return preparation
        ? preparation.then(register, (error: unknown) => {
            registrationOwnership.release();
            throw error;
          })
        : register();
    } catch (error) {
      registrationOwnership.release();
      throw error;
    }
  };

  readonly startQueuedSubagentRun = (
    runId: string,
    gatewayRunId?: string,
    lifecycleGeneration?: string,
    gatewayContextResolver?: GatewayContextResolver,
  ): boolean => {
    const key = runId.trim();
    const entry = this.findRunByIdentity(key);
    const acceptedLifecycleGeneration = lifecycleGeneration ?? getAgentEventLifecycleGeneration();
    if (
      lifecycleGeneration !== undefined &&
      !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
    ) {
      return false;
    }
    const lifecycleStarted =
      entry?.execution.status === "running" &&
      typeof entry.execution.startedAt === "number" &&
      entry.swarmLaunchPending === true;
    const provisionalTerminalBeforeAcceptance =
      entry?.swarmLaunchPending === true &&
      typeof entry.execution.endedAt === "number" &&
      entry.collectorCompletion === undefined;
    if (provisionalTerminalBeforeAcceptance) {
      // Cancellation won before Gateway acceptance. The caller must abort the
      // newly accepted run before freezing completion or releasing the FIFO slot.
      return false;
    }
    // Completion clears swarmLaunchPending, but queuedLaunch remains until the
    // delayed acceptance response remaps the durable terminal row.
    const terminalBeforeAcceptance =
      entry?.collectorCompletion !== undefined && entry.queuedLaunch !== undefined;
    if (
      !entry ||
      entry.killIntent ||
      waitForPendingSubagentKillClaim(entry, captureOpenClawStateWorkerContext().admission) ||
      entry.killReconciliation ||
      (!terminalBeforeAcceptance && entry.execution.status !== "queued" && !lifecycleStarted)
    ) {
      return false;
    }
    const nextRunId = gatewayRunId?.trim() || entry.runId;
    const conflicting = this.options.runs.get(nextRunId);
    if (conflicting && conflicting !== entry) {
      throw new Error(`collector gateway run id already exists: ${nextRunId}`);
    }
    const acceptedAt = Date.now();
    const previousRunId = entry.runId;
    const previous = structuredClone(entry);
    const restoreQueuedRun = () => {
      if (previousRunId !== nextRunId) {
        this.options.runs.delete(nextRunId);
      }
      replaceSubagentRunRecord(entry, previous);
      if (previousRunId !== nextRunId) {
        this.options.runs.set(previousRunId, entry);
      }
    };
    entry.swarmRunId ??= previousRunId;
    entry.schedulerSlotId ??= entry.swarmRunId;
    if (previousRunId !== nextRunId) {
      this.options.runs.delete(previousRunId);
      entry.runId = nextRunId;
      this.options.runs.set(nextRunId, entry);
    }
    if (!terminalBeforeAcceptance) {
      // Acceptance is not a lifecycle start; preserve a raced start or leave its clock unset.
      const lifecycleStartedAt =
        entry.execution.status === "running" ? entry.execution.startedAt : undefined;
      entry.execution = {
        ...entry.execution,
        status: "running",
        acceptedAt,
        lifecycleGeneration: acceptedLifecycleGeneration,
        restartRecovery: undefined,
        suppressSessionEffects: undefined,
      };
      if (typeof lifecycleStartedAt === "number") {
        entry.sessionStartedAt ??= lifecycleStartedAt;
        entry.execution.startedAt = lifecycleStartedAt;
      } else {
        delete entry.sessionStartedAt;
        delete entry.execution.startedAt;
      }
    }
    entry.swarmLaunchPending = false;
    entry.queuedLaunch = undefined;
    try {
      this.options.persistOrThrow(previousRunId, nextRunId);
      if (terminalBeforeAcceptance) {
        bindGatewayContextResolver(entry, gatewayContextResolver);
        return true;
      }
    } catch (error) {
      restoreQueuedRun();
      throw error;
    }
    bindGatewayContextResolver(entry, gatewayContextResolver);
    const cfg = this.options.getRuntimeConfig();
    void this.waitForSubagentCompletion(
      nextRunId,
      this.options.resolveSubagentWaitTimeoutMs(cfg, entry.runTimeoutSeconds),
      entry,
    );
    return true;
  };

  readonly failQueuedSubagentRun = (runId: string, error: string): boolean => {
    const key = runId.trim();
    const entry = this.findRunByIdentity(key);
    if (!entry || entry.execution.status !== "queued") {
      return false;
    }
    const snapshot = structuredClone(entry);
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
    updateSwarmCollectorCompletion(entry, this.options.getRuntimeConfig());
    try {
      this.options.persistOrThrow(entry.runId);
    } catch (persistError) {
      replaceSubagentRunRecord(entry, snapshot);
      throw persistError;
    }
    return true;
  };

  readonly settleFailedQueuedSubagentLaunch = (runId: string, error: string): boolean => {
    const entry = this.findRunByIdentity(runId);
    if (!entry?.collect) {
      return false;
    }
    if (typeof entry.execution.endedAt !== "number") {
      return this.failQueuedSubagentRun(runId, error);
    }
    if (entry.collectorCompletion) {
      return true;
    }
    const snapshot = structuredClone(entry);
    prepareTerminatedCollectorLaunch(entry, entry.execution.endedAt, error, () =>
      this.options.getRuntimeConfig(),
    );
    try {
      this.options.persistOrThrow(entry.runId);
    } catch (persistError) {
      replaceSubagentRunRecord(entry, snapshot);
      throw persistError;
    }
    return true;
  };
}
