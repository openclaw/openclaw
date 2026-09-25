import {
  embeddedAgentLog,
  resolveCompactionTimeoutMs,
  type CompactEmbeddedAgentSessionParams,
  type EmbeddedAgentCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
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
  runExclusiveCodexNativeCompaction,
  watchCodexNativeCompactionCompletion,
} from "./compact-lifecycle.js";
import { persistCodexContextCompactionActivity } from "./context-compaction-activity.js";
import type { JsonObject } from "./protocol.js";
import { CODEX_RESPONSES_OAUTH_PROVIDER } from "./responses-oauth.js";
import { resolveCodexNativeExecutionBlock } from "./sandbox-guard.js";
import {
  CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS,
  sessionBindingIdentity,
  resolveCodexSessionBinding,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
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
  params: CompactEmbeddedAgentSessionParams,
  options: CodexAppServerCompactOptions,
): Promise<EmbeddedAgentCompactResult | undefined> {
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
  const abortedResult = (expectedThreadId?: string, currentThreadId = expectedThreadId) =>
    options.allowNonManualNativeRequest
      ? skippedCodexNativeCompactionResult(params, {
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
    return abortedResult(options.bindingStore.read(bindingIdentity)?.threadId);
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
  try {
    return await runExclusiveCodexNativeCompaction(
      binding.threadId,
      params.abortSignal,
      async () => {
        assertCurrent();
        const client = await clientFactory({
          startOptions: appServer.start,
          ...(preparedApiKey
            ? { preparedAuth: { kind: "api-key" as const, apiKey: preparedApiKey } }
            : { authProfileId: connection.clientAuthProfileId }),
          agentDir: params.agentDir,
          config: params.config,
          assertCurrent,
        });
        let releaseThreadSubscription: (() => Promise<void>) | undefined;
        let retainedThreadOwnership: CodexAppServerLiveThreadOwnership | undefined;
        let canRetainThreadOwnership = false;
        let compactionSucceeded = false;
        let compactionRequestDefinitelyRejected = false;
        let tokensAfter: number | undefined;
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
          signal: params.abortSignal,
          timeoutMs: options.nativeCompletionTimeoutMs ?? resolveCompactionTimeoutMs(params.config),
          interruptGraceMs:
            options.nativeInterruptGraceMs ?? CODEX_NATIVE_COMPACTION_INTERRUPT_GRACE_MS,
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
          if (!isIncognitoSessionKey(params.sessionKey)) {
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
                ...(params.abortSignal ? { signal: params.abortSignal } : {}),
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
          const guardedResult = await options.bindingStore.withLease(bindingIdentity, async () => {
            const currentBinding = options.bindingStore.read(bindingIdentity);
            if (params.abortSignal?.aborted) {
              if (!options.allowNonManualNativeRequest) {
                params.abortSignal.throwIfAborted();
              }
              return {
                started: false as const,
                result: skippedCodexNativeCompactionResult(params, {
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
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
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
              const isRequiredPreflight = options.nativeCompactionRequest === "required_preflight";
              return {
                started: false as const,
                result:
                  options.allowNonManualNativeRequest && !isRequiredPreflight
                    ? skippedCodexNativeCompactionResult(params, {
                        reason: "codex app-server binding changed before native compaction",
                        code: "binding_changed_before_native_compaction",
                        request: options.nativeCompactionRequest ?? "after_context_engine",
                        expectedThreadId: binding.threadId,
                        currentThreadId: currentBinding?.threadId,
                      })
                    : failedCodexThreadBindingCompactionResult(params, {
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
            await acquireThreadSubscription(guardedRequestTimeoutMs);
            canRetainThreadOwnership = true;
            params.abortSignal?.throwIfAborted();
            await clearContextEngineProjectionBeforeNativeCompaction({
              sessionId: params.sessionId,
              bindingStore: options.bindingStore,
              identity: bindingIdentity,
              binding,
              assertCurrent,
            });
            assertCurrent();
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
                  signal: params.abortSignal,
                  assertCurrent: () => {
                    try {
                      assertCurrent();
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
                if (error instanceof CodexAppServerRpcError || binding.contextEngine?.projection) {
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
          });
          if (!guardedResult.started) {
            return guardedResult.result;
          }
          if (!guardedResult.accepted) {
            if (compactionRequestDefinitelyRejected) {
              throw guardedResult.error;
            }
            if (
              !params.abortSignal?.aborted ||
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
            sessionId: params.sessionId,
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
              sessionTarget: params.sessionTarget,
              config: params.config,
              cwd: params.workspaceDir,
              runId: params.runId,
              threadId: binding.threadId,
              turnId: completion.turnId,
              itemId: completion.itemId,
              timestamp: Date.now(),
            });
          }
          assertCurrent();
          embeddedAgentLog.info("completed codex app-server compaction", {
            sessionId: params.sessionId,
            threadId: binding.threadId,
          });
          canRetainThreadOwnership = true;
        } catch (error) {
          if (isCodexThreadNotFoundError(error)) {
            return failedCodexThreadBindingCompactionResult(params, {
              threadId: binding.threadId,
              reason: coerceErrorMessage(error),
              recovery: "stale_thread_binding",
            });
          }
          embeddedAgentLog.warn("codex app-server compaction failed", {
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
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
            if (shouldReleaseDefaultLease) {
              releaseLeasedSharedCodexAppServerClient(client);
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
                trigger: params.trigger ?? "unknown",
              }
            : {}),
        };
        return codexNativeCompactionResult(params, { compacted: true, tokensAfter, details });
      },
    );
  } catch (error) {
    if (params.abortSignal?.aborted) {
      return abortedResult(initialBinding.threadId, binding.threadId);
    }
    throw error;
  }
}

function codexNativeCompactionResult(
  params: CompactEmbeddedAgentSessionParams,
  outcome: { compacted: boolean; reason?: string; tokensAfter?: number; details: JsonObject },
): EmbeddedAgentCompactResult {
  return {
    ok: true,
    compacted: outcome.compacted,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: params.currentTokenCount ?? 0,
      ...(outcome.tokensAfter !== undefined ? { tokensAfter: outcome.tokensAfter } : {}),
      details: outcome.details,
    },
  };
}

function skippedCodexNativeCompactionResult(
  params: CompactEmbeddedAgentSessionParams,
  skipped: {
    reason: string;
    code: string;
    request?: "required_preflight" | "after_context_engine";
    expectedThreadId?: string;
    currentThreadId?: string;
  },
): EmbeddedAgentCompactResult {
  return codexNativeCompactionResult(params, {
    compacted: false,
    reason: skipped.reason,
    details: {
      backend: "codex-app-server",
      skipped: true,
      reason: skipped.code,
      request: skipped.request ?? "after_context_engine",
      trigger: params.trigger ?? "unknown",
      ...(skipped.expectedThreadId ? { expectedThreadId: skipped.expectedThreadId } : {}),
      ...(skipped.currentThreadId ? { currentThreadId: skipped.currentThreadId } : {}),
    },
  });
}

function failedCodexThreadBindingCompactionResult(
  params: CompactEmbeddedAgentSessionParams,
  recovery: {
    reason: string;
    recovery: "missing_thread_binding" | "stale_thread_binding";
    threadId?: string;
  },
): EmbeddedAgentCompactResult {
  embeddedAgentLog.warn("codex app-server compaction could not use thread binding", {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    threadId: recovery.threadId,
    reason: recovery.reason,
    recovery: recovery.recovery,
  });
  return {
    ok: false,
    compacted: false,
    reason: recovery.reason,
    failure: {
      reason: recovery.recovery,
      rawError: recovery.reason,
    },
  };
}

async function clearContextEngineProjectionBeforeNativeCompaction(params: {
  sessionId: string;
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  binding: CodexAppServerThreadBinding;
  assertCurrent: () => void;
}): Promise<void> {
  const contextEngineBinding = params.binding.contextEngine;
  if (!contextEngineBinding?.projection) {
    return;
  }
  // Native Codex compaction mutates the thread history outside the projection
  // guard. Clear only the projection marker so the next turn reprojects context.
  await params.bindingStore.mutate(
    params.identity,
    {
      kind: "patch",
      threadId: params.binding.threadId,
      patch: {
        contextEngine: {
          ...contextEngineBinding,
          projection: undefined,
        },
      },
    },
    params.assertCurrent,
  );
  embeddedAgentLog.info("cleared codex context-engine projection before native compaction", {
    sessionId: params.sessionId,
    threadId: params.binding.threadId,
    previousEpoch: contextEngineBinding.projection.epoch,
    previousFingerprint: contextEngineBinding.projection.fingerprint,
  });
}

function isSameNativeCompactionBinding(
  current: CodexAppServerThreadBinding,
  expected: CodexAppServerThreadBinding,
): boolean {
  return (
    isSameCodexAppServerThreadOwner(current, expected) &&
    current.authProfileId === expected.authProfileId &&
    current.contextEngine?.engineId === expected.contextEngine?.engineId &&
    current.contextEngine?.policyFingerprint === expected.contextEngine?.policyFingerprint &&
    current.contextEngine?.projection?.mode === expected.contextEngine?.projection?.mode &&
    current.contextEngine?.projection?.epoch === expected.contextEngine?.projection?.epoch &&
    current.contextEngine?.projection?.fingerprint ===
      expected.contextEngine?.projection?.fingerprint
  );
}

function isCodexThreadNotFoundError(error: unknown): boolean {
  // codex-rs exposes no dedicated error code for a missing compaction thread:
  // thread/compact/start returns generic INVALID_REQUEST (-32600), and the
  // app-server's own contract/test asserts the "thread not found" MESSAGE as
  // the discriminator (thread_processor.rs load_thread → invalid_request;
  // compaction.rs asserts message.contains("thread not found")). So the message
  // gates recovery, not user-facing classification; the generic code is ambiguous.
  return coerceErrorMessage(error).toLowerCase().includes("thread not found");
}
