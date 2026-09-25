import {
  embeddedAgentLog,
  resolveCompactionTimeoutMs,
  type AgentHarnessCompactParams,
  type CompactEmbeddedAgentSessionParams,
  type EmbeddedAgentCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { runWithAsyncWorkResources } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isIncognitoSessionKey } from "../incognito-session.js";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { resolveCodexBindingAppServerConnection } from "./binding-connection.js";
import {
  consumeCodexAppServerLiveThread,
  protectCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
  revertCodexAppServerLiveThreadSkillsCatalog,
} from "./client-runtime.js";
import type { CodexAppServerLiveThreadOwnership } from "./client-thread-owner.js";
import {
  CodexAppServerRpcError,
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerPrewriteRequestCancellationError,
} from "./client.js";
import {
  clearContextEngineProjectionBeforeNativeCompaction,
  codexNativeCompactionResult,
  failedCodexThreadBindingCompactionResult,
  isCodexThreadNotFoundError,
  isSameNativeCompactionBinding,
  skippedCodexNativeCompactionResult,
} from "./compact-helpers.js";
import {
  runExclusiveCodexNativeCompaction,
  watchCodexNativeCompactionCompletion,
} from "./compact-lifecycle.js";
import { persistCodexContextCompactionActivity } from "./context-compaction-activity.js";
import { getCodexInferenceThreadQualification } from "./inference-routing.js";
import { readCodexRuntimeModelId } from "./model-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import type { JsonObject } from "./protocol.js";
import { CODEX_RESPONSES_OAUTH_PROVIDER } from "./responses-oauth.js";
import { resolveCodexNativeExecutionBlock } from "./sandbox-guard.js";
import {
  CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS,
  sessionBindingIdentity,
  resolveCodexSessionBinding,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
} from "./session-binding.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  retainSharedCodexAppServerClientIfCurrent,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import { isSameCodexAppServerThreadOwner } from "./thread-ownership.js";
import { assertCodexSupervisionThreadLineage } from "./thread-policy.js";
import { resumeCodexAppServerThread } from "./thread-resume.js";

// ttlMs: 0 retains keys until the 4,096-entry LRU cap evicts them, after which a
// previously suppressed warning can intentionally emit again.
const warnedIgnoredCompactionOverrides = createDedupeCache({ ttlMs: 0, maxSize: 4096 });
const CODEX_NATIVE_COMPACTION_INTERRUPT_GRACE_MS = 30_000;
type CodexAppServerCompactOptions = {
  bindingStore: CodexAppServerBindingStore;
  pluginConfig?: unknown;
  clientFactory?: CodexAppServerClientFactory;
  allowNonManualNativeRequest?: boolean;
  nativeCompactionRequest?: "required_preflight" | "after_context_engine";
  nativeCompletionTimeoutMs?: number;
  nativeInterruptGraceMs?: number;
};

function warnIfIgnoringOpenClawCompactionOverrides(
  params: CompactEmbeddedAgentSessionParams,
): void {
  const ignoredConfig = readIgnoredCompactionOverridePaths(params);
  if (ignoredConfig.length === 0) {
    return;
  }
  const warningKey = ignoredConfig.join("\0");
  if (warnedIgnoredCompactionOverrides.check(warningKey)) {
    return;
  }
  embeddedAgentLog.warn(
    "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      ignoredConfig,
    },
  );
}

function readIgnoredCompactionOverridePaths(params: CompactEmbeddedAgentSessionParams): string[] {
  const compaction = asOptionalRecord(params.config?.agents?.defaults?.compaction);
  return ["model", "thinkingLevel", "provider"].flatMap((field) => {
    const value = compaction?.[field];
    return typeof value === "string" && value.trim() ? [`agents.defaults.compaction.${field}`] : [];
  });
}

/**
 * Starts native Codex compaction for a manually requested bound session, or
 * reports why Codex-owned automatic compaction should handle the trigger.
 */
export async function maybeCompactCodexAppServerSession(
  params: AgentHarnessCompactParams<2>,
  options: CodexAppServerCompactOptions,
): Promise<EmbeddedAgentCompactResult | undefined> {
  params.hostCapabilities.assertActive();
  warnIfIgnoringOpenClawCompactionOverrides(params);
  // Codex owns automatic context-pressure compaction for Codex runtime sessions.
  // Retain the lease until Codex reports the context-compaction item complete.
  if (params.trigger !== "manual" && !options.allowNonManualNativeRequest) {
    embeddedAgentLog.info("skipping codex app-server compaction for non-manual trigger", {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      trigger: params.trigger,
    });
    return codexNativeCompactionResult(params, {
      compacted: false,
      reason: "codex app-server owns automatic compaction",
      details: {
        backend: "codex-app-server",
        skipped: true,
        reason: "non_manual_trigger",
        trigger: params.trigger ?? "unknown",
      },
    });
  }
  const sandbox = (params as typeof params & { sandbox?: SandboxContext | null }).sandbox;
  const nativeExecutionBlock = resolveCodexNativeExecutionBlock({
    config: params.config,
    sessionKey: params.sandboxSessionKey ?? params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.sandboxAgentId ?? params.agentId,
    sandbox,
    surface: "native compaction",
  });
  if (nativeExecutionBlock) {
    return { ok: false, compacted: false, reason: nativeExecutionBlock };
  }
  const bindingIdentity: CodexAppServerBindingIdentity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const abortedResult = (
    attempt: AgentHarnessCompactParams<2>,
    expectedThreadId?: string,
    currentThreadId = expectedThreadId,
  ) =>
    options.allowNonManualNativeRequest
      ? skippedCodexNativeCompactionResult(attempt, {
          reason: "codex app-server compaction aborted before native compaction",
          code: "aborted_before_native_compaction",
          request: options.nativeCompactionRequest ?? "after_context_engine",
          ...(expectedThreadId ? { expectedThreadId, currentThreadId } : {}),
        })
      : {
          ok: false as const,
          compacted: false,
          reason: "codex app-server compaction aborted while waiting to start",
        };
  let resolvedBinding: Awaited<ReturnType<typeof resolveCodexSessionBinding>>;
  try {
    resolvedBinding = await resolveCodexSessionBinding({
      bindingStore: options.bindingStore,
      identity: bindingIdentity,
      config: params.config,
      storePath: params.sessionTarget?.storePath,
      signal: params.abortSignal,
    });
  } catch (error) {
    if (!params.abortSignal?.aborted) {
      throw error;
    }
    return abortedResult(params, options.bindingStore.read(bindingIdentity)?.threadId);
  }
  const { binding: initialBinding, assertCurrent } = resolvedBinding;
  if (!initialBinding?.threadId) {
    return failedCodexThreadBindingCompactionResult(params, {
      reason: "no codex app-server thread binding",
      recovery: "missing_thread_binding",
    });
  }
  if (initialBinding.modelProvider === CODEX_RESPONSES_OAUTH_PROVIDER) {
    // The pinned manual compact RPC cannot carry the admitted turn generation.
    // Automatic in-turn summarization carries it and remains authorized.
    return {
      ok: false,
      compacted: false,
      reason:
        "Manual compaction is unavailable with ChatGPT subscription sharing. Automatic compaction runs during normal turns; continue the conversation or start a new session.",
    };
  }
  if (
    params.nativeToolSurface === "host-isolated" ||
    initialBinding.nativeToolPolicyRestricted === true ||
    initialBinding.ringZeroConfigFingerprint !== undefined
  ) {
    // Compact is a separate Codex operation without a turn-scoped environment
    // override, so resuming here would silently restore ambient native tools.
    return codexNativeCompactionResult(params, {
      compacted: false,
      reason: "native compaction is unavailable for a host-isolated Codex session",
      details: {
        backend: "codex-app-server",
        skipped: true,
        reason: "native_tool_policy_restricted",
        expectedThreadId: initialBinding.threadId,
      },
    });
  }
  let binding = initialBinding;
  const requestedAuthProfileId = params.authProfileId?.trim() || undefined;
  let connection: Awaited<ReturnType<typeof resolveCodexBindingAppServerConnection>>;
  try {
    const config = params.config ?? {};
    connection = await resolveCodexBindingAppServerConnection({
      binding,
      authProfileId: requestedAuthProfileId ?? binding.authProfileId,
      pluginConfig: options.pluginConfig,
      config,
      assertCurrent,
      agentDir: resolveAgentDir(config, bindingIdentity.agentId),
    });
  } catch (error) {
    return {
      ok: false,
      compacted: false,
      reason: coerceErrorMessage(error),
    };
  }
  const { appServer, usesSupervisionConnection } = connection;
  if (
    !usesSupervisionConnection &&
    requestedAuthProfileId &&
    binding.authProfileId &&
    binding.authProfileId !== requestedAuthProfileId
  ) {
    // A session binding belongs to the auth profile that created it; compacting
    // with another profile risks operating on a different Codex account.
    return { ok: false, compacted: false, reason: "auth profile mismatch for session binding" };
  }
  const shouldReleaseDefaultLease = !options.clientFactory;
  const clientFactory = options.clientFactory ?? getLeasedSharedCodexAppServerClient;
  const runtimeAuthPlan = params.runtimeAuthPlan ?? params.runtimePlan?.auth;
  // A user-home app-server keeps its native Codex account; injecting a prepared key
  // would rewrite the CODEX_HOME auth that Codex CLI and Desktop share.
  const usesPreparedApiKey =
    !usesSupervisionConnection &&
    appServer.start.homeScope !== "user" &&
    runtimeAuthPlan?.modelRoute?.authRequirement === "api-key";
  const preparedApiKey = usesPreparedApiKey ? params.resolvedApiKey?.trim() : undefined;
  if (usesPreparedApiKey && !preparedApiKey) {
    return {
      ok: false,
      compacted: false,
      reason: "Prepared Codex Platform compaction route is missing its resolved API key.",
    };
  }
  return await runWithAsyncWorkResources(async (onAcquired) => {
    const modelSource = params.hostCapabilities.retainSourceAuthority();
    let modelSourceTransferred = false;
    onAcquired({
      release: () => {
        if (!modelSourceTransferred) {
          modelSource?.release();
        }
      },
      releaseBeforeResultWhenIdle: true,
    });
    const modelCancellation = new AbortController();
    const signals = [params.abortSignal, modelSource?.signal, modelCancellation.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const attempt = { ...params, abortSignal: AbortSignal.any(signals) };
    const assertAdmissionCurrent = () => {
      attempt.hostCapabilities.assertActive();
      assertCurrent();
    };
    try {
      return await runExclusiveCodexNativeCompaction(
        binding.threadId,
        attempt.abortSignal,
        async () => {
          assertAdmissionCurrent();
          const client = await clientFactory({
            startOptions: appServer.start,
            ...(preparedApiKey
              ? { preparedAuth: { kind: "api-key" as const, apiKey: preparedApiKey } }
              : { authProfileId: connection.clientAuthProfileId }),
            agentDir: attempt.agentDir,
            config: attempt.config,
            assertCurrent: assertAdmissionCurrent,
          });
          let releaseThreadSubscription: (() => Promise<void>) | undefined;
          let retainedThreadOwnership: CodexAppServerLiveThreadOwnership | undefined;
          let canRetainThreadOwnership = false;
          let compactionSucceeded = false;
          let compactionRequestDefinitelyRejected = false;
          let tokensAfter: number | undefined;
          let modelOwner:
            | Awaited<ReturnType<typeof codexNativeSubagentMonitorRuntime.register>>
            | undefined;
          const releaseCompactionThread = async (threadId: string) => {
            if (
              await unsubscribeCodexThreadBestEffort(client, {
                threadId,
                timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
              })
            ) {
              return;
            }
            await closeCodexStartupClientBestEffort(client);
            throw new CodexAppServerUnsafeSubscriptionError(
              `Codex compaction thread subscription could not be released: ${threadId}`,
            );
          };
          const completionWatch = watchCodexNativeCompactionCompletion({
            client,
            threadId: binding.threadId,
            signal: attempt.abortSignal,
            timeoutMs:
              options.nativeCompletionTimeoutMs ?? resolveCompactionTimeoutMs(attempt.config),
            interruptGraceMs:
              options.nativeInterruptGraceMs ?? CODEX_NATIVE_COMPACTION_INTERRUPT_GRACE_MS,
            onCompactionTurn: (turnId) => {
              assertAdmissionCurrent();
              const runtimeModel = attempt.runtimeModel;
              // Compaction keeps native settings; only prepared catalog facts may map
              // the actual provider/model tuple checked by inference egress.
              const mapping =
                !usesSupervisionConnection &&
                attempt.provider &&
                attempt.model &&
                runtimeModel?.provider === attempt.provider &&
                runtimeModel.id === attempt.model
                  ? {
                      nativeModel: {
                        provider: attempt.provider,
                        model: readCodexRuntimeModelId(runtimeModel, attempt.model),
                      },
                      authorizedModel: { provider: attempt.provider, model: attempt.model },
                    }
                  : undefined;
              modelOwner?.bindTurn(turnId, mapping);
            },
            retireUnconfirmed: async () => {
              releaseThreadSubscription = undefined;
              const transportStopped = await client.closeAndWait({
                exitTimeoutMs: 5_000,
                forceKillDelayMs: 250,
              });
              if (appServer.start.transport === "stdio") {
                if (transportStopped.exited) {
                  return;
                }
                // A local thread remains runnable with its stdio process. Keep
                // the lifecycle fence held unless process exit is observed.
                throw new Error("failed to stop unconfirmed codex app-server process");
              }
              if (usesSupervisionConnection) {
                // A supervised thread is native user-home state, not an
                // OpenClaw-owned remote binding. Keep the lifecycle fence held
                // rather than detach and permit a second writer.
                throw new Error("cannot detach an unconfirmed supervised codex thread");
              }
              // Closing a WebSocket proves only that the connection ended, not
              // that its remote turn stopped. Detach only while this generation
              // owns the row; a successor may need it as its recorded predecessor.
              const bindingCleared = await options.bindingStore.mutate(
                bindingIdentity,
                { kind: "clear", threadId: binding.threadId },
                assertCurrent,
              );
              if (bindingCleared) {
                return;
              }
              const currentBinding = options.bindingStore.read(bindingIdentity);
              if (currentBinding?.threadId !== binding.threadId) {
                return;
              }
              throw new Error("failed to detach unconfirmed codex app-server thread binding");
            },
          });
          const acquireThreadSubscription = async (timeoutMs?: number) => {
            if (!isIncognitoSessionKey(attempt.sessionKey)) {
              // Remove any idle ownership first: sibling cleanup must not evict
              // this subscription while compaction still awaits terminal events.
              retainedThreadOwnership = await consumeCodexAppServerLiveThread(
                client,
                binding.threadId,
              );
              if (!retainedThreadOwnership) {
                const resumed = await resumeCodexAppServerThread({
                  client,
                  abandonClient: async () => closeCodexStartupClientBestEffort(client),
                  request: { threadId: binding.threadId, excludeTurns: true },
                  timeoutMs: timeoutMs ?? appServer.requestTimeoutMs,
                  assertCurrent,
                  signal: attempt.abortSignal,
                });
                releaseThreadSubscription = async () => releaseCompactionThread(binding.threadId);
                assertCodexSupervisionThreadLineage(binding, resumed.thread);
              } else if (binding.connectionScope === "supervision") {
                releaseThreadSubscription = async () =>
                  retainedThreadOwnership?.release(binding.threadId);
                const { thread } = await client.request(
                  "thread/read",
                  {
                    threadId: binding.threadId,
                    includeTurns: false,
                  },
                  { assertCurrent },
                );
                assertCurrent();
                retainedThreadOwnership.assertCurrent();
                assertCodexSupervisionThreadLineage(binding, thread);
              }
              releaseThreadSubscription ??= async () => releaseCompactionThread(binding.threadId);
            }
          };
          try {
            const guardedResult = await options.bindingStore.withLease(
              bindingIdentity,
              async () => {
                const currentBinding = options.bindingStore.read(bindingIdentity);
                if (attempt.abortSignal.aborted) {
                  if (!options.allowNonManualNativeRequest) {
                    attempt.abortSignal.throwIfAborted();
                  }
                  return {
                    started: false as const,
                    result: skippedCodexNativeCompactionResult(attempt, {
                      reason: "codex app-server compaction aborted before native compaction",
                      code: "aborted_before_native_compaction",
                      request: options.nativeCompactionRequest ?? "after_context_engine",
                      expectedThreadId: binding.threadId,
                      currentThreadId: currentBinding?.threadId,
                    }),
                  };
                }
                assertCurrent();
                if (!currentBinding || !isSameNativeCompactionBinding(currentBinding, binding)) {
                  embeddedAgentLog.warn(
                    "codex app-server compaction could not use the thread binding because it changed",
                    {
                      sessionId: attempt.sessionId,
                      sessionKey: attempt.sessionKey,
                      expectedThreadId: binding.threadId,
                      currentThreadId: currentBinding?.threadId,
                    },
                  );
                  // A binding change between the initial read and the native request
                  // is a stale-binding race. For required-preflight (and the
                  // non-manual CLI path) it must surface as the canonical
                  // recoverable failure so the caller falls back to the context
                  // engine instead of treating an uncompacted ok:true skip as a
                  // completed turn. Only a genuine post-context-engine request may
                  // skip, because the context engine has already compacted.
                  const isRequiredPreflight =
                    options.nativeCompactionRequest === "required_preflight";
                  return {
                    started: false as const,
                    result:
                      options.allowNonManualNativeRequest && !isRequiredPreflight
                        ? skippedCodexNativeCompactionResult(attempt, {
                            reason: "codex app-server binding changed before native compaction",
                            code: "binding_changed_before_native_compaction",
                            request: options.nativeCompactionRequest ?? "after_context_engine",
                            expectedThreadId: binding.threadId,
                            currentThreadId: currentBinding?.threadId,
                          })
                        : failedCodexThreadBindingCompactionResult(attempt, {
                            threadId: currentBinding?.threadId ?? binding.threadId,
                            reason: "codex app-server binding changed before native compaction",
                            recovery: "stale_thread_binding",
                          }),
                  };
                }
                binding = currentBinding;
                const guardedRequestTimeoutMs = options.allowNonManualNativeRequest
                  ? Math.min(
                      appServer.requestTimeoutMs,
                      CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS,
                    )
                  : undefined;
                assertAdmissionCurrent();
                await acquireThreadSubscription(guardedRequestTimeoutMs);
                canRetainThreadOwnership = true;
                attempt.abortSignal.throwIfAborted();
                const configurationQualification = getCodexInferenceThreadQualification(
                  client,
                  binding.threadId,
                );
                modelOwner = await codexNativeSubagentMonitorRuntime.register({
                  client,
                  parentThreadId: binding.threadId,
                  modelSource,
                  configurationQualification,
                  unqualifiedModelExecution:
                    modelSource && !configurationQualification ? true : undefined,
                  onUnqualifiedModelCancelled: (reason) => modelCancellation.abort(reason),
                  requesterSessionKey: attempt.sessionKey,
                  agentId: bindingIdentity.agentId,
                  assertCurrent: assertAdmissionCurrent,
                  retainClient: () => retainSharedCodexAppServerClientIfCurrent(client),
                  retainParentThread: (threadId) =>
                    protectCodexAppServerLiveThread(client, threadId),
                });
                modelSourceTransferred = true;
                assertAdmissionCurrent();
                attempt.abortSignal.throwIfAborted();
                await clearContextEngineProjectionBeforeNativeCompaction({
                  sessionId: attempt.sessionId,
                  bindingStore: options.bindingStore,
                  identity: bindingIdentity,
                  binding,
                  assertCurrent: assertAdmissionCurrent,
                });
                assertAdmissionCurrent();
                try {
                  canRetainThreadOwnership = false;
                  completionWatch.beginRequest();
                  await client.request(
                    "thread/compact/start",
                    { threadId: binding.threadId },
                    {
                      ...(guardedRequestTimeoutMs === undefined
                        ? {}
                        : { timeoutMs: guardedRequestTimeoutMs }),
                      signal: attempt.abortSignal,
                      assertCurrent: () => {
                        try {
                          assertAdmissionCurrent();
                        } catch (error) {
                          // This physical pre-write rejection proves no compaction
                          // started, including retries after ingress overload.
                          compactionRequestDefinitelyRejected = true;
                          throw error;
                        }
                      },
                    },
                  );
                  return { started: true as const, accepted: true as const };
                } catch (error) {
                  compactionRequestDefinitelyRejected ||=
                    isCodexAppServerPrewriteRequestCancellationError(error) ||
                    error instanceof CodexAppServerRpcError;
                  if (compactionRequestDefinitelyRejected) {
                    canRetainThreadOwnership = !isCodexThreadNotFoundError(error);
                    // Settle a definite rejection before restoration so a refused
                    // write cannot strand the watcher waiting for a nonexistent turn.
                    completionWatch.confirmRequestRejected();
                    if (
                      error instanceof CodexAppServerRpcError ||
                      binding.contextEngine?.projection
                    ) {
                      await options.bindingStore.mutate(
                        bindingIdentity,
                        { kind: "set", binding },
                        assertCurrent,
                      );
                    }
                  }
                  // Retirement can acquire this same generation lease.
                  return { started: true as const, accepted: false as const, error };
                }
              },
            );
            if (!guardedResult.started) {
              return guardedResult.result;
            }
            if (!guardedResult.accepted) {
              if (compactionRequestDefinitelyRejected) {
                throw guardedResult.error;
              }
              if (
                !attempt.abortSignal.aborted ||
                !isCodexAppServerIndeterminateRequestCancellationError(guardedResult.error)
              ) {
                // Transport errors after the write leave the server-side start
                // ambiguous. Retire or detach the thread before releasing its fence.
                await completionWatch.retireUnconfirmedRequest(
                  `codex app-server compaction start was unconfirmed: ${coerceErrorMessage(guardedResult.error)}`,
                );
                throw guardedResult.error;
              }
              // A canceled acknowledgement cannot override native completion or
              // release the thread before interruption reaches terminal state.
            }
            embeddedAgentLog.info("waiting for codex app-server compaction completion", {
              sessionId: attempt.sessionId,
              threadId: binding.threadId,
            });
            const completion = await completionWatch.completion;
            assertCurrent();
            if (!completion.completed) {
              throw new Error(completion.reason);
            }
            compactionSucceeded = true;
            tokensAfter = completion.tokensAfter;
            if (completion.turnId && completion.itemId) {
              await persistCodexContextCompactionActivity({
                sessionTarget: attempt.sessionTarget,
                config: attempt.config,
                cwd: attempt.workspaceDir,
                runId: attempt.runId,
                threadId: binding.threadId,
                turnId: completion.turnId,
                itemId: completion.itemId,
                timestamp: Date.now(),
              });
            }
            assertCurrent();
            embeddedAgentLog.info("completed codex app-server compaction", {
              sessionId: attempt.sessionId,
              threadId: binding.threadId,
            });
            canRetainThreadOwnership = true;
          } catch (error) {
            if (isCodexThreadNotFoundError(error)) {
              return failedCodexThreadBindingCompactionResult(attempt, {
                threadId: binding.threadId,
                reason: coerceErrorMessage(error),
                recovery: "stale_thread_binding",
              });
            }
            embeddedAgentLog.warn("codex app-server compaction failed", {
              sessionId: attempt.sessionId,
              sessionKey: attempt.sessionKey,
              threadId: binding.threadId,
              reason: coerceErrorMessage(error),
            });
            return {
              ok: false,
              compacted: false,
              reason: coerceErrorMessage(error),
            };
          } finally {
            completionWatch.cancel();
            try {
              if (compactionSucceeded) {
                // An incognito thread keeps its separately owned subscription, so
                // it never reaches the re-retain below. Correct its record in place
                // or the discarded catalog refresh is never delivered again.
                revertCodexAppServerLiveThreadSkillsCatalog(client, binding.threadId);
              }
              if (canRetainThreadOwnership && retainedThreadOwnership) {
                const ownership = retainedThreadOwnership;
                const currentBinding = options.bindingStore.read(bindingIdentity);
                // Reset uses this same generation lease; without it compaction
                // could return an obsolete subscription after its owner ended.
                const retained =
                  isSameCodexAppServerThreadOwner(currentBinding, binding) &&
                  (await options.bindingStore.withLease(bindingIdentity, async () => {
                    const leasedBinding = options.bindingStore.read(bindingIdentity);
                    if (!isSameCodexAppServerThreadOwner(leasedBinding, binding)) {
                      return false;
                    }
                    return await retainCodexAppServerLiveThread(
                      client,
                      binding.threadId,
                      ownership.release,
                      ownership.configFingerprint,
                      ownership.serviceTier,
                      // Creation policy has to survive standalone compaction, or the
                      // next turn reads a live ephemeral thread as policy drift. A
                      // completed compaction rebuilt initial context from the
                      // creation-time developer instructions and discarded the
                      // injected catalog refresh, so record that reversion and let
                      // the next turn deliver the current catalog again.
                      ownership.ephemeralPolicy && compactionSucceeded
                        ? {
                            ...ownership.ephemeralPolicy,
                            skillsInstructions: ownership.ephemeralPolicy.nativeSkillsInstructions,
                          }
                        : ownership.ephemeralPolicy,
                    );
                  }));
                if (!retained) {
                  await releaseThreadSubscription?.();
                }
              } else {
                await releaseThreadSubscription?.();
              }
            } finally {
              try {
                await modelOwner?.unregister();
              } finally {
                if (shouldReleaseDefaultLease) {
                  releaseLeasedSharedCodexAppServerClient(client);
                }
              }
            }
          }
          const details: JsonObject = {
            backend: "codex-app-server",
            threadId: binding.threadId,
            signal: "thread/compact/start",
            pending: false,
            completed: true,
            ...(options.allowNonManualNativeRequest
              ? {
                  request: options.nativeCompactionRequest ?? "after_context_engine",
                  trigger: attempt.trigger ?? "unknown",
                }
              : {}),
          };
          return codexNativeCompactionResult(attempt, { compacted: true, tokensAfter, details });
        },
      );
    } catch (error) {
      if (attempt.abortSignal.aborted) {
        return abortedResult(attempt, initialBinding.threadId, binding.threadId);
      }
      throw error;
    }
  });
}
