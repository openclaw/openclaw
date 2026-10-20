import type { FollowupRun } from "../../auto-reply/reply/queue.js";
import { getRuntimeConfigSnapshot } from "../../config/config.js";
import type { CapturedSessionEntryCurrentRead } from "../../config/sessions/session-entry-current.types.js";
import { listSqliteTargetCandidatePathsForSessionStorePath } from "../../config/sessions/session-sqlite-target-paths.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { fenceScheduledGatewayContextResolver } from "../../gateway/scheduled-run-gateway-context.js";
import {
  createAbortError,
  isAbortError,
  racePromiseWithAbortSignal,
} from "../../infra/abort-signal.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getPluginRegistryForContext,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeSnapshotRevisionState } from "../../secrets/runtime-state.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  beginSessionEffect,
  bindSessionControllerTarget,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { runWithSessionControllerCleanup } from "../../sessions/session-controller.owner-context.js";
import { getRuntimeAuthProfileStoreCredentialsRevision } from "../auth-profiles/runtime-snapshots.js";
import { createCommandBudget } from "../command/maintenance-budget.js";
import {
  loadAgentRunnerMemoryRuntime,
  loadSessionStoreRuntime,
} from "../command/runtime-loaders.js";
import { resolveCompactionTimeoutMs } from "../embedded-agent-runner/compaction-safety-timeout.js";
import type { PromptCacheExpiryEstimate } from "../embedded-agent-runner/prompt-cache-expiry.js";
import type { CompactionRequestBudget } from "../sessions/compaction/request-budget.js";
import { planCacheExpiryCompaction } from "./cache-expiry.js";
import { createSessionMaintenanceOwner } from "./coordinator.js";
import type { SessionCompactionRequest } from "./request.js";

const log = createSubsystemLogger("agents/session-maintenance");
export type SessionMaintenanceRequest = {
  prepared: {
    cfg: OpenClawConfig;
    sessionKey?: string;
    storePath: string;
    timeoutMs: number;
    runtimePolicySessionKey?: string;
  };
  followupRun: FollowupRun;
  sessionId: string;
  lifecycleRevision: SessionEntry["lifecycleRevision"];
  lifecycleGeneration: string;
  startedAt: number;
  oneShotCliRun?: boolean;
  agentHarnessId?: string;
  compactionRequestBudget?: CompactionRequestBudget;
  requestedCompaction?: SessionCompactionRequest;
  cacheExpiry?: PromptCacheExpiryEstimate;
  expectedCompactionCount?: number;
  /** Selection captured by the successful foreground owner, not chosen by the timer. */
  expectedSelection?: Pick<
    SessionEntry,
    "model" | "modelProvider" | "modelOverride" | "providerOverride" | "authProfileOverride"
  >;
};

/** Copy data only: turn callbacks, tool grants, delivery context and writer custody stay behind. */
export function createSessionMaintenanceFollowup(params: {
  run: Pick<
    FollowupRun["run"],
    | "agentId"
    | "agentDir"
    | "workspaceDir"
    | "cwd"
    | "messageProvider"
    | "agentAccountId"
    | "chatType"
    | "conversationRoutePeerId"
    | "conversationToolPolicy"
    | "requesterOrigin"
    | "operatorProfileId"
    | "conversationId"
    | "messageThreadId"
    | "groupId"
    | "groupChannel"
    | "groupSpace"
    | "skillsSnapshot"
    | "thinkingCatalog"
    | "skipProviderRuntimeHints"
    | "thinkLevel"
    | "verboseLevel"
    | "timeoutMs"
    | "senderIsOwner"
  >;
  sessionEntry: SessionEntry;
  cfg: OpenClawConfig;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  provider: string;
  model: string;
  auth: Pick<FollowupRun["run"], "authProfileId" | "authProfileIdSource">;
}): FollowupRun {
  const { run, sessionEntry } = params;
  return {
    prompt: "",
    enqueuedAt: Date.now(),
    run: {
      agentId: run.agentId,
      agentDir: run.agentDir,
      sessionId: sessionEntry.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionKey ?? sessionEntry.sessionId,
      workspaceDir: run.workspaceDir,
      cwd: run.cwd ?? run.workspaceDir,
      runtimePolicySessionKey: params.runtimePolicySessionKey ?? params.sessionKey,
      config: params.cfg,
      messageProvider: run.messageProvider,
      agentAccountId: run.agentAccountId,
      chatType: run.chatType,
      conversationRoutePeerId: run.conversationRoutePeerId,
      conversationToolPolicy: run.conversationToolPolicy,
      requesterOrigin: run.requesterOrigin,
      operatorProfileId: run.operatorProfileId,
      conversationId: run.conversationId,
      messageThreadId: run.messageThreadId,
      groupId: run.groupId,
      groupChannel: run.groupChannel,
      groupSpace: run.groupSpace,
      provider: params.provider,
      model: params.model,
      authProfileId: params.auth.authProfileId,
      authProfileIdSource: params.auth.authProfileIdSource,
      blockReplyBreak: "message_end",
      skillsSnapshot: run.skillsSnapshot,
      thinkingCatalog: run.thinkingCatalog,
      skipProviderRuntimeHints: run.skipProviderRuntimeHints,
      thinkLevel: run.thinkLevel,
      verboseLevel: run.verboseLevel ?? "off",
      timeoutMs: run.timeoutMs,
      senderIsOwner: false,
    },
    // A pre-compaction flush resolves the source turn's audience from this, not the run's grant.
    memoryAudienceSenderIsOwner: run.senderIsOwner === true,
  };
}

/** Optional work has a fresh root and writer admission after the foreground owner closes. */
export function scheduleSessionMaintenance(
  request: SessionMaintenanceRequest,
  afterOwnerSettles?: Promise<boolean>,
): void {
  if (request.prepared.cfg.agents?.defaults?.compaction?.enabled === false) {
    return;
  }
  scheduleMaintenanceWork(request, afterOwnerSettles);
  const cachePlan =
    !request.requestedCompaction &&
    request.prepared.cfg.agents?.defaults?.compaction?.cacheExpiry?.enabled === true &&
    request.cacheExpiry
      ? planCacheExpiryCompaction(request.cacheExpiry)
      : undefined;
  if (cachePlan) {
    scheduleMaintenanceWork(request, afterOwnerSettles, cachePlan);
  }
}

function scheduleMaintenanceWork(
  request: SessionMaintenanceRequest,
  afterOwnerSettles?: Promise<boolean>,
  cachePlan?: { notBefore: number; expiresAt: number },
): void {
  const { prepared, followupRun } = request;
  const sessionKey = prepared.sessionKey;
  if (!sessionKey) {
    return;
  }
  const sessionReadScope = {
    ...captureSessionTranscriptTargetBinding({
      agentId: followupRun.run.agentId,
      sessionId: request.sessionId,
      storePath: prepared.storePath,
      sessionKey,
    }),
    readConsistency: "latest" as const,
  };
  if (request.oneShotCliRun) {
    log.debug("Optional session maintenance skipped: one-shot CLI owns no post-return runtime.");
    return;
  }
  const pluginRegistry = getPluginRegistryForContext();
  if (!pluginRegistry) {
    log.warn("Optional session maintenance skipped: no active plugin registry.");
    return;
  }
  const resolveGatewayContext = fenceScheduledGatewayContextResolver(
    getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
  );
  let sourceIdentities: ReturnType<typeof readDatabasePathIdentitySync>[];
  try {
    sourceIdentities = listSqliteTargetCandidatePathsForSessionStorePath(
      sessionReadScope.storePath,
    ).map(readDatabasePathIdentitySync);
  } catch (error) {
    log.warn(`Optional session maintenance source unavailable: ${formatErrorMessage(error)}`);
    return;
  }
  // Cache lifetime gates admission, not paid work already in flight. Keep the normal
  // bounded compaction budget once started, even if the estimated window passes.
  const budget = createCommandBudget(
    cachePlan?.notBefore ?? request.startedAt,
    cachePlan
      ? Math.min(prepared.timeoutMs, resolveCompactionTimeoutMs(prepared.cfg))
      : prepared.timeoutMs,
  );
  if (budget.remainingMs() === 0) {
    budget.dispose();
    return;
  }
  let readSource: CapturedSessionEntryCurrentRead | undefined;
  const interrupted = new AbortController();
  const runtimeConfig = getRuntimeConfigSnapshot();
  const credentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();
  const secretsRevision = getActiveSecretsRuntimeSnapshotRevisionState();
  const target = captureSessionTarget({
    storeScope: prepared.storePath,
    sessionKey,
    incarnation: request.sessionId,
    agentId: followupRun.run.agentId,
  });
  const owner = createSessionMaintenanceOwner({
    sessionKey,
    target,
    preemptible: true,
    notBefore: cachePlan?.notBefore,
    abortSignal: AbortSignal.any([interrupted.signal, budget.signal]),
  });
  const assertCurrent = () => {
    owner.assertCurrent();
    if (getRuntimeConfigSnapshot()?.agents?.defaults?.compaction?.enabled === false) {
      throw createAbortError("Optional compaction was disabled");
    }
    assertAgentRunLifecycleGenerationCurrent(request.lifecycleGeneration);
    if (resolveGatewayContext && !resolveGatewayContext()) {
      throw createAbortError("Optional maintenance Gateway instance retired");
    }
    readSource?.assertSourceCurrent();
    if (
      cachePlan &&
      (getRuntimeConfigSnapshot() !== runtimeConfig ||
        getRuntimeAuthProfileStoreCredentialsRevision() !== credentialsRevision ||
        getActiveSecretsRuntimeSnapshotRevisionState() !== secretsRevision)
    ) {
      throw createAbortError("Cache-expiry maintenance estimate is no longer current");
    }
  };
  // Scheduled from the foreground turn's async context, this work runs after that turn
  // retires; it leaves the turn's controller context so withSessionTurn admits a fresh turn.
  const run = runWithSessionControllerCleanup(() =>
    withPluginRuntimeGatewayRequestScope(
      {
        pluginRegistry,
        resolveGatewayContext,
        isWebchatConnect: () => false,
      },
      async () => {
        if (
          afterOwnerSettles &&
          !(await racePromiseWithAbortSignal(afterOwnerSettles, owner.signal))
        ) {
          log.debug(
            "Optional session maintenance skipped: foreground owner did not complete successfully.",
          );
          return;
        }
        await owner.run({
          admit: (runAdmitted) =>
            runWithGatewayIndependentRootWorkAdmission(
              async () =>
                await withSessionTurn(
                  {
                    sessionKey,
                    storePath: prepared.storePath,
                    sessionId: request.sessionId,
                    agentId: followupRun.run.agentId,
                    abortSignal: owner.signal,
                  },
                  async (operation, operationSignal) => {
                    if (!operation) {
                      throw new Error("Maintenance requires a session controller owner");
                    }
                    bindSessionControllerTarget(operation, target);
                    const assertTurnCurrent = () => {
                      operationSignal.throwIfAborted();
                      assertCurrent();
                    };
                    return await runAdmitted(async () => {
                      assertTurnCurrent();
                      const { captureSessionEntryCurrentRead, withSessionEntryReadOnlyInWorker } =
                        await loadSessionStoreRuntime();
                      let entry: SessionEntry | undefined;
                      const admission = await beginSessionEffect({
                        agentId: followupRun.run.agentId,
                        scope: prepared.storePath,
                        identities: [sessionKey, request.sessionId],
                        signal: operationSignal,
                        operation,
                        onInterrupt: () =>
                          interrupted.abort(
                            createAbortError("Session maintenance writer admission interrupted"),
                          ),
                        assertAllowed: async () => {
                          assertTurnCurrent();
                          entry = await withSessionEntryReadOnlyInWorker(
                            sessionReadScope,
                            assertTurnCurrent,
                            async (read, source) => {
                              if (!read.ok) {
                                throw read.error;
                              }
                              const captured = captureSessionEntryCurrentRead(
                                sessionReadScope,
                                source,
                              );
                              if (
                                (readSource &&
                                  (captured.kind !== readSource.kind ||
                                    (captured.kind === "file" &&
                                      readSource.kind === "file" &&
                                      (captured.source.agentId !== readSource.source.agentId ||
                                        captured.source.path !== readSource.source.path ||
                                        captured.source.databaseIdentity !==
                                          readSource.source.databaseIdentity ||
                                        captured.source.databaseBirthtime !==
                                          readSource.source.databaseBirthtime)))) ||
                                (captured.kind === "file" &&
                                  !sourceIdentities.some(
                                    (identity) =>
                                      identity.canonicalPath === captured.source.path &&
                                      identity.key === `file:${captured.source.databaseIdentity}` &&
                                      identity.birthtime === captured.source.databaseBirthtime,
                                  ))
                              ) {
                                throw createAbortError(
                                  "Session maintenance database changed before admission",
                                );
                              }
                              readSource ??= captured;
                              return read.value;
                            },
                          );
                          assertTurnCurrent();
                          if (
                            !entry ||
                            entry.sessionId !== request.sessionId ||
                            entry.lifecycleRevision !== request.lifecycleRevision
                          ) {
                            throw createAbortError(
                              "Session changed before optional maintenance admission",
                            );
                          }
                          if (entry.pendingFinalDelivery) {
                            throw createAbortError(
                              "Optional maintenance skipped while final delivery is pending",
                            );
                          }
                          const selectionKeys = [
                            "model",
                            "modelProvider",
                            "modelOverride",
                            "providerOverride",
                            "authProfileOverride",
                          ] as const;
                          if (
                            cachePlan &&
                            (Date.now() >= cachePlan.expiresAt ||
                              (entry.compactionCount ?? 0) !==
                                (request.expectedCompactionCount ?? 0) ||
                              (request.expectedSelection &&
                                selectionKeys.some(
                                  (key) => entry?.[key] !== request.expectedSelection?.[key],
                                )))
                          ) {
                            throw createAbortError(
                              "Cache-expiry maintenance window or session selection changed before admission",
                            );
                          }
                        },
                      });
                      try {
                        await admission.run(async () => {
                          assertTurnCurrent();
                          if (!entry) {
                            throw createAbortError("Session maintenance has no admitted session");
                          }
                          const sessionStore = { [sessionKey]: entry };
                          const memory = await loadAgentRunnerMemoryRuntime();
                          followupRun.run.timeoutMs = budget.remainingMs();
                          assertTurnCurrent();
                          const flushed = await memory.runMemoryFlushIfNeeded({
                            cfg: prepared.cfg,
                            followupRun,
                            promptForEstimate: "",
                            defaultModel: followupRun.run.model,
                            resolvedVerboseLevel: followupRun.run.verboseLevel ?? "off",
                            sessionEntry: entry,
                            sessionStore,
                            sessionKey,
                            runtimePolicySessionKey: prepared.runtimePolicySessionKey ?? sessionKey,
                            storePath: prepared.storePath,
                            isHeartbeat: false,
                            replyOperation: operation,
                            force: Boolean(request.requestedCompaction || cachePlan),
                            abortSignal: operationSignal,
                          });
                          // Flush reports aborted attempts as failed outcomes; cancellation still forbids compaction.
                          assertTurnCurrent();
                          entry = flushed.sessionEntry ?? entry;
                          if (
                            (request.requestedCompaction || cachePlan) &&
                            (flushed.outcome === "failed" || flushed.outcome === "exhausted")
                          ) {
                            throw createAbortError(
                              "Optional compaction skipped because memory checkpointing failed",
                            );
                          }
                          followupRun.run.sessionId = entry.sessionId;
                          followupRun.run.timeoutMs = budget.remainingMs();
                          assertTurnCurrent();
                          await memory.runSessionCompactionIfNeeded({
                            cfg: prepared.cfg,
                            followupRun,
                            promptForEstimate: "",
                            // The completed user is canonical history; do not reserve its input twice.
                            compactionRequestBudget: request.compactionRequestBudget
                              ? { ...request.compactionRequestBudget, pendingTokens: 0 }
                              : undefined,
                            sessionEntry: entry,
                            sessionStore,
                            sessionKey,
                            runtimePolicySessionKey: prepared.runtimePolicySessionKey ?? sessionKey,
                            storePath: prepared.storePath,
                            defaultModel: followupRun.run.model,
                            isHeartbeat: false,
                            agentHarnessId: request.agentHarnessId,
                            requestedCompaction:
                              request.requestedCompaction ?? (cachePlan ? {} : undefined),
                            abortSignal: operationSignal,
                            authorize: () => {
                              assertTurnCurrent();
                              return true;
                            },
                          });
                        });
                      } finally {
                        admission.release();
                      }
                    });
                  },
                ),
              "session-maintenance",
              owner.signal,
            ),
        });
      },
    ),
  );
  void owner
    .track(run)
    .catch((error: unknown) => {
      if (owner.signal.aborted || isAbortError(error)) {
        log.debug(`Optional session maintenance cancelled: ${formatErrorMessage(error)}`);
      } else {
        log.warn(`Optional session maintenance failed: ${formatErrorMessage(error)}`);
      }
    })
    .finally(() => budget.dispose());
}
