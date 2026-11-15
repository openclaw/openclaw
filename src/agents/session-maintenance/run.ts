import type { FollowupRun } from "../../auto-reply/reply/queue.js";
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
import { getPluginRegistryGatewayOwner } from "../../plugins/registry-lifecycle.js";
import {
  getPluginRegistryForContext,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { runOutsidePluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  beginSessionEffect,
  bindSessionControllerTarget,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { runWithSessionControllerCleanup } from "../../sessions/session-controller.owner-context.js";
import { createCommandBudget } from "../command/maintenance-budget.js";
import {
  loadAgentRunnerMemoryRuntime,
  loadSessionStoreRuntime,
} from "../command/runtime-loaders.js";
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../prepared-model-runtime-generation-scope.js";
import type { CompactionRequestBudget } from "../sessions/compaction/request-budget.js";
import { createSessionMaintenanceOwner } from "./coordinator.js";

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
  const gatewayOwner = getPluginRegistryGatewayOwner(pluginRegistry);
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
  const budget = createCommandBudget(request.startedAt, prepared.timeoutMs);
  if (budget.remainingMs() === 0) {
    budget.dispose();
    return;
  }
  let readSource: CapturedSessionEntryCurrentRead | undefined;
  const interrupted = new AbortController();
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
    abortSignal: AbortSignal.any([interrupted.signal, budget.signal]),
  });
  const assertCurrent = () => {
    owner.assertCurrent();
    assertAgentRunLifecycleGenerationCurrent(request.lifecycleGeneration);
    if (resolveGatewayContext && !resolveGatewayContext()) {
      throw createAbortError("Optional maintenance Gateway instance retired");
    }
    readSource?.assertSourceCurrent();
  };
  // Maintenance leaves the completed turn's controller and plugin custody.
  // Its original Gateway selects the generation when this work becomes eligible.
  const run = runOutsidePreparedModelRuntimePluginGenerationScope(() =>
    runOutsidePluginRuntimeGenerationScope(() =>
      runWithSessionControllerCleanup(async () => {
        if (
          afterOwnerSettles &&
          !(await racePromiseWithAbortSignal(afterOwnerSettles, owner.signal))
        ) {
          log.debug(
            "Optional session maintenance skipped: foreground owner did not complete successfully.",
          );
          return;
        }
        const currentRegistry = gatewayOwner ? gatewayOwner.current() : pluginRegistry;
        if (!currentRegistry) {
          throw createAbortError("Optional maintenance plugin runtime retired");
        }
        await withPluginRuntimeGatewayRequestScope(
          {
            pluginRegistry: currentRegistry,
            resolveGatewayContext,
            isWebchatConnect: () => false,
          },
          () =>
            owner.run({
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
                        // Post-turn upkeep must not look like the finished turn restarting.
                        projectSessionActive: false,
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
                          const {
                            captureSessionEntryCurrentRead,
                            withSessionEntryReadOnlyInWorker,
                          } = await loadSessionStoreRuntime();
                          let entry: SessionEntry | undefined;
                          const admission = await beginSessionEffect({
                            agentId: followupRun.run.agentId,
                            scope: prepared.storePath,
                            identities: [sessionKey, request.sessionId],
                            signal: operationSignal,
                            operation,
                            onInterrupt: () =>
                              interrupted.abort(
                                createAbortError(
                                  "Session maintenance writer admission interrupted",
                                ),
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
                                          identity.key ===
                                            `file:${captured.source.databaseIdentity}` &&
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
                            },
                          });
                          try {
                            await admission.run(async () => {
                              assertTurnCurrent();
                              if (!entry) {
                                throw createAbortError(
                                  "Session maintenance has no admitted session",
                                );
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
                                runtimePolicySessionKey:
                                  prepared.runtimePolicySessionKey ?? sessionKey,
                                storePath: prepared.storePath,
                                replyOperation: operation,
                                abortSignal: operationSignal,
                              });
                              // Flush reports aborted attempts as failed outcomes; cancellation still forbids compaction.
                              assertTurnCurrent();
                              entry = flushed.sessionEntry ?? entry;
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
                                runtimePolicySessionKey:
                                  prepared.runtimePolicySessionKey ?? sessionKey,
                                storePath: prepared.storePath,
                                defaultModel: followupRun.run.model,
                                agentHarnessId: request.agentHarnessId,
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
            }),
        );
      }),
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
