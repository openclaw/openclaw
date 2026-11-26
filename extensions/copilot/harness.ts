import type { CopilotClient, SessionConfig } from "@github/copilot-sdk";
import {
  compactWithSafetyTimeout,
  projectSettledTurnFinalizationAttemptResult,
  resolveCompactionTimeoutMs,
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessBeforeCompactionHook,
  type AgentHarness,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessV2,
  type AgentHarnessAttemptResult,
  type AgentHarnessCompactParams,
  type AgentHarnessCompactResult,
  type AgentHarnessResetParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { CopilotAttemptParams } from "./src/attempt-types.js";
import { sessionAuthFields, sessionAuthMatches } from "./src/auth-bridge.js";
import { createCopilotByokProxy } from "./src/byok-proxy.js";
import {
  buildCopilotCompactionHookContext,
  compactTrackedSdkSession,
  isStaleSdkSessionError,
  throwIfAborted,
  type CopilotHistoryCompactResult,
  type CopilotHistoryCompactSession,
} from "./src/history-compaction.js";
import {
  isCopilotByokUnsupportedProviderError,
  supportsCopilotByokProviderShape,
} from "./src/provider-bridge.js";
import type {
  ClientCreateOptions,
  CopilotClientPool,
  CopilotClientPoolOptions,
  PooledClient,
  PoolKey,
} from "./src/runtime.js";
import {
  deleteStoredBinding,
  lookupStoredBinding,
  registerStoredBinding,
  type CopilotSessionBinding,
  type CopilotSessionBindingStore,
} from "./src/session-bindings.js";
import {
  computeSessionCompatKey,
  computeAttemptCompactKey,
  computeCompactRequestKey,
} from "./src/session-compat.js";
export type { CopilotSessionBinding } from "./src/session-bindings.js";

type AgentHarnessIsolatedCompletion = NonNullable<AgentHarness["runIsolatedCompletionV2"]>;
type AgentHarnessIsolatedCompletionParams = Parameters<AgentHarnessIsolatedCompletion>[0];
type AgentHarnessIsolatedCompletionResult = Awaited<ReturnType<AgentHarnessIsolatedCompletion>>;
type CopilotHarnessAttemptParams = CopilotAttemptParams & {
  initialReplayState?: AgentHarnessAttemptParamsV2["initialReplayState"] & {
    journalValidated?: boolean;
    sdkSessionId?: string;
  };
};

const COPILOT_PROVIDER_IDS: ReadonlySet<string> = new Set(["github-copilot"]);

interface CreateCopilotAgentHarnessOptions {
  id?: string;
  label?: string;
  pool?: CopilotClientPool;
  poolOptions?: CopilotClientPoolOptions;
  sessionStore?: CopilotSessionBindingStore;
}

interface TrackedSession extends Omit<CopilotSessionBinding, "schemaVersion" | "updatedAt"> {
  client: CopilotClient;
  clientOptions: ClientCreateOptions;
  poolKey: PoolKey;
  sessionConfig: SessionConfig;
}

type DeferredCompactionCleanupOutcome = "aborted" | "completed" | "deadline";
type DeferredCompactionCleanup = {
  abort: () => void;
  sdkSessionId: string;
};

function failedCompaction(reason: string, rawError?: string): AgentHarnessCompactResult {
  return {
    ok: false,
    compacted: false,
    reason,
    failure: { reason, ...(rawError === undefined ? {} : { rawError }) },
  };
}

export function createCopilotAgentHarness(
  options?: CreateCopilotAgentHarnessOptions,
): AgentHarnessV2 {
  let poolPromise: Promise<CopilotClientPool> | undefined;
  let createdPool: CopilotClientPool | undefined;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const inFlight = new Set<Promise<unknown>>();
  const bindingQueue = new KeyedAsyncQueue();
  const deferredCompactionCleanups = new Map<
    string,
    Map<Promise<DeferredCompactionCleanupOutcome>, DeferredCompactionCleanup>
  >();
  const trackedSessions = new Map<string, TrackedSession>();
  const resetBlockedStoredSessions = new Set<string>();

  async function trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation();
    inFlight.add(pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(pending);
    }
  }

  async function getPool(): Promise<CopilotClientPool> {
    if (options?.pool) {
      return options.pool;
    }
    if (!poolPromise) {
      poolPromise = (async () => {
        const { createCopilotClientPool } = await import("./src/runtime.js");
        createdPool = createCopilotClientPool(options?.poolOptions);
        return createdPool;
      })();
    }
    return poolPromise;
  }

  function removeDeferredCompactionCleanup(
    sessionId: string,
    cleanup: Promise<DeferredCompactionCleanupOutcome>,
  ): void {
    const cleanups = deferredCompactionCleanups.get(sessionId);
    if (!cleanups) {
      return;
    }
    cleanups.delete(cleanup);
    if (cleanups.size === 0) {
      deferredCompactionCleanups.delete(sessionId);
    }
  }

  async function hasPendingDeferredCompactionCleanup(sessionId: string): Promise<boolean> {
    const cleanups = deferredCompactionCleanups.get(sessionId);
    if (!cleanups) {
      return false;
    }
    const currentSdkSessionId =
      trackedSessions.get(sessionId)?.sdkSessionId ??
      (await lookupStoredBinding(options?.sessionStore, sessionId))?.sdkSessionId;
    return (
      currentSdkSessionId !== undefined &&
      [...cleanups.values()].some((cleanup) => cleanup.sdkSessionId === currentSdkSessionId)
    );
  }

  async function abortDeferredCompactionCleanups(sessionId: string): Promise<void> {
    const cleanups = deferredCompactionCleanups.get(sessionId);
    if (!cleanups) {
      return;
    }
    const pending = [...cleanups.entries()];
    for (const [, cleanup] of pending) {
      cleanup.abort();
    }
    await Promise.allSettled(pending.map(([cleanup]) => cleanup));
  }

  async function runHarnessAttempt(
    params: CopilotHarnessAttemptParams,
    operation: "attempt" | "settled-tool-finalization",
  ): Promise<AgentHarnessAttemptResult> {
    return trackOperation(async () => {
      if (disposed) {
        throw new Error("[copilot] harness has been disposed; cannot start new attempts");
      }
      const { resolvePoolAcquire, runCopilotAttempt } = await import("./src/attempt.js");
      const pool = await getPool();
      let poolAcquire: ReturnType<typeof resolvePoolAcquire>;
      try {
        poolAcquire = resolvePoolAcquire(params as never);
      } catch (error) {
        // Keep invalid forced BYOK model configuration on the normal attempt
        // result path so callers receive `model_not_supported` instead of an
        // uncaught harness rejection. Finalization cannot safely create a new
        // incompatible session and therefore keeps the failure closed.
        if (operation === "attempt" && isCopilotByokUnsupportedProviderError(error)) {
          return runCopilotAttempt(params, { pool });
        }
        throw error;
      }
      // An in-memory manager alone is not one-shot: memory Ask reuses it across turns.
      // Explicitly detached runs own fresh native history, never a resumable binding.
      const openclawSessionId =
        params.sessionPersistence === "detached" ? undefined : params.sessionId;

      // Reuse the SDK session across turns within the same OpenClaw session so
      // Copilot's prompt cache, tool history, and compaction state survive.
      // Compatibility covers provider/model/cwd/auth; incompatible state starts
      // a fresh ordinary attempt but cannot be used for settled finalization.
      const currentCompatKey = computeSessionCompatKey(params);
      const currentCompactKey = computeAttemptCompactKey(params);
      const resumableBinding = openclawSessionId
        ? await bindingQueue.enqueue(openclawSessionId, async () => {
            const replayBlocked =
              (await hasPendingDeferredCompactionCleanup(openclawSessionId)) ||
              resetBlockedStoredSessions.has(openclawSessionId);
            if (replayBlocked) {
              return undefined;
            }
            const tracked = trackedSessions.get(openclawSessionId);
            const stored = tracked
              ? undefined
              : await lookupStoredBinding(options?.sessionStore, openclawSessionId);
            const binding = tracked ?? stored;
            return binding?.compatKey === currentCompatKey ? binding : undefined;
          })
        : undefined;
      const resumableSessionId = resumableBinding?.sdkSessionId;
      if (operation === "settled-tool-finalization" && !resumableSessionId) {
        throw new Error(
          "[copilot] cannot safely finalize a settled tool turn without its compatible SDK session",
        );
      }
      const effectiveParams: CopilotHarnessAttemptParams = resumableSessionId
        ? ({
            ...params,
            // Finalization is a new, isolated turn over settled state, not a
            // replay of the side-effecting prompt. Ignore replayInvalid while
            // still requiring the exact compatible native session above.
            initialReplayState: {
              ...(operation === "attempt" ? params.initialReplayState : undefined),
              ...(resumableBinding?.journalVersion === 1 ? { journalValidated: true } : {}),
              sdkSessionId: resumableSessionId,
            },
          } as CopilotHarnessAttemptParams)
        : params;

      const result = await runCopilotAttempt(effectiveParams, {
        pool,
        ...(operation === "settled-tool-finalization" ? { operation } : {}),
        onSessionEstablished:
          operation === "attempt" && openclawSessionId
            ? ({ compactionSessionConfig, sdkSessionId, pooledClient, sessionConfig }) =>
                bindingQueue.enqueue(openclawSessionId, async () => {
                  const tracked: TrackedSession = {
                    sdkSessionId,
                    client: pooledClient.client,
                    clientOptions: poolAcquire.options,
                    compatKey: currentCompatKey,
                    compactKey: currentCompactKey,
                    poolKey: pooledClient.key,
                    sessionConfig: compactionSessionConfig ?? sessionConfig,
                    ...sessionAuthFields(poolAcquire.auth),
                  };
                  await registerStoredBinding(options?.sessionStore, openclawSessionId, tracked);
                  trackedSessions.set(openclawSessionId, tracked);
                  resetBlockedStoredSessions.delete(openclawSessionId);
                })
            : undefined,
        onDeferredCompaction: openclawSessionId
          ? ({ abort, cleanup, sdkSessionId }) =>
              bindingQueue.enqueue(openclawSessionId, async () => {
                const trackedBinding = trackedSessions.get(openclawSessionId);
                const storedBinding = await lookupStoredBinding(
                  options?.sessionStore,
                  openclawSessionId,
                );
                const ownsTrackedSession = trackedBinding?.sdkSessionId === sdkSessionId;
                const ownsStoredSession = storedBinding?.sdkSessionId === sdkSessionId;
                if (!ownsTrackedSession && !ownsStoredSession) {
                  return;
                }
                // The attempt retains this SDK session until its background
                // compaction resolves. Preserve its binding for a successful
                // completion, but do not let a new turn resume it yet.
                resetBlockedStoredSessions.add(openclawSessionId);
                const bindingCleanup = cleanup.then((outcome) =>
                  bindingQueue.enqueue(openclawSessionId, async () => {
                    const currentTracked = trackedSessions.get(openclawSessionId);
                    const currentStored = await lookupStoredBinding(
                      options?.sessionStore,
                      openclawSessionId,
                    );
                    const stillOwnsTrackedSession = currentTracked?.sdkSessionId === sdkSessionId;
                    const stillOwnsStoredSession = currentStored?.sdkSessionId === sdkSessionId;
                    if (outcome === "completed") {
                      if (stillOwnsTrackedSession || stillOwnsStoredSession) {
                        resetBlockedStoredSessions.delete(openclawSessionId);
                      }
                      return outcome;
                    }
                    if (stillOwnsTrackedSession) {
                      trackedSessions.delete(openclawSessionId);
                    }
                    if (stillOwnsStoredSession) {
                      await deleteStoredBinding(options?.sessionStore, openclawSessionId);
                    }
                    if (stillOwnsTrackedSession || stillOwnsStoredSession) {
                      resetBlockedStoredSessions.add(openclawSessionId);
                    }
                    return outcome;
                  }),
                );
                const cleanups =
                  deferredCompactionCleanups.get(openclawSessionId) ??
                  new Map<Promise<DeferredCompactionCleanupOutcome>, DeferredCompactionCleanup>();
                cleanups.set(bindingCleanup, { abort, sdkSessionId });
                deferredCompactionCleanups.set(openclawSessionId, cleanups);
                void bindingCleanup.then(
                  () => removeDeferredCompactionCleanup(openclawSessionId, bindingCleanup),
                  () => removeDeferredCompactionCleanup(openclawSessionId, bindingCleanup),
                );
              })
          : undefined,
      });
      if (operation === "attempt" && openclawSessionId) {
        const attemptResult = result as AgentHarnessAttemptResult & {
          journalValidated?: boolean;
          sdkSessionId?: string;
        };
        const sdkSessionId = attemptResult.sdkSessionId;
        await bindingQueue.enqueue(openclawSessionId, async () => {
          const trackedSession = trackedSessions.get(openclawSessionId);
          if (sdkSessionId && trackedSession?.sdkSessionId === sdkSessionId) {
            const { journalVersion: _journalVersion, ...baseTracked } = trackedSession;
            const nextTracked: TrackedSession = {
              ...baseTracked,
              ...(attemptResult.journalValidated ? { journalVersion: 1 } : {}),
            };
            await registerStoredBinding(options?.sessionStore, openclawSessionId, nextTracked);
            trackedSessions.set(openclawSessionId, nextTracked);
          }
        });
      }
      return result;
    });
  }

  async function runIsolatedCompletionV2(
    params: AgentHarnessIsolatedCompletionParams,
  ): Promise<AgentHarnessIsolatedCompletionResult> {
    return trackOperation(async () => {
      if (disposed) {
        throw new Error("[copilot] harness has been disposed; cannot start isolated completion");
      }
      const { runCopilotIsolatedCompletion } = await import("./src/isolated-completion.js");
      return await runCopilotIsolatedCompletion(params, async () => {
        const pool = await getPool();
        return pool;
      });
    });
  }

  return {
    id: options?.id ?? "copilot",
    label: options?.label ?? "GitHub Copilot agent runtime",
    autoSelection: { providerIds: [] },
    conversationToolPolicySupport: "exact",
    runtimeArtifact: {
      async validate(binding) {
        const { validateCopilotRuntimeArtifact } = await import("./src/runtime-artifact.js");
        return await validateCopilotRuntimeArtifact(binding);
      },
    },

    supports(ctx) {
      const requestedRuntime = String(ctx.requestedRuntime ?? "")
        .trim()
        .toLowerCase();
      if (requestedRuntime !== "copilot") {
        return { supported: false, reason: "copilot is opt-in only" };
      }
      const provider = ctx.provider.trim().toLowerCase();
      if (!provider) {
        return { supported: false, reason: "provider is required" };
      }
      if (COPILOT_PROVIDER_IDS.has(provider)) {
        return { supported: true, priority: 100 };
      }
      const providerOwnerPluginIds = ctx.providerOwnerPluginIds;
      if (
        ctx.providerOwnerStatus !== "unowned" ||
        !providerOwnerPluginIds ||
        providerOwnerPluginIds.length > 0
      ) {
        return {
          supported: false,
          reason: `provider is not one of: ${[...COPILOT_PROVIDER_IDS].toSorted().join(", ")}`,
        };
      }
      if (
        !supportsCopilotByokProviderShape({
          api: ctx.modelProvider?.api,
          baseUrl: ctx.modelProvider?.baseUrl,
          requestProxy: ctx.modelProvider?.request?.proxy,
          requestTls: ctx.modelProvider?.request?.tls,
          requestAllowPrivateNetwork: ctx.modelProvider?.request?.allowPrivateNetwork,
        })
      ) {
        return {
          supported: false,
          reason:
            "provider is not a supported Copilot BYOK model (requires supported api, baseUrl, and no request transport policy overrides)",
        };
      }
      return { supported: true, priority: 100 };
    },

    runAttempt: (params) => runHarnessAttempt(params, "attempt"),

    runIsolatedCompletionV2,

    runSideQuestion: (params) =>
      trackOperation(async () => {
        if (disposed) {
          throw new Error("[copilot] harness has been disposed; cannot answer side questions");
        }
        const { runCopilotSideQuestion } = await import("./src/side-question.js");
        return await runCopilotSideQuestion(params, getPool);
      }),

    modelCatalogProviderIds: [...COPILOT_PROVIDER_IDS],
    loadModelCatalog: (params) =>
      trackOperation(async () => {
        if (disposed) {
          throw new Error("[copilot] harness has been disposed; cannot discover models");
        }
        if (params.providerIds && !params.providerIds.includes("github-copilot")) {
          return [];
        }
        const { loadCopilotModelCatalog } = await import("./src/model-catalog.js");
        return await loadCopilotModelCatalog(params, await getPool(), options?.id ?? "copilot");
      }),

    finalizeSettledTurn: async ({ attempt }) => {
      const result = await runHarnessAttempt(attempt, "settled-tool-finalization");
      return projectSettledTurnFinalizationAttemptResult(result);
    },

    reset: (params: AgentHarnessResetParams): Promise<void> =>
      trackOperation(async () => {
        if (disposed) {
          return;
        }
        const openclawSessionId = params.sessionId;
        if (!openclawSessionId) {
          return;
        }
        // Deferred cleanup yields while another attempt can establish a fresh
        // session. Capture the reset target first so reset never deletes that
        // replacement session or its durable binding.
        const { tracked, stored } = await bindingQueue.enqueue(openclawSessionId, async () => {
          const binding = await lookupStoredBinding(options?.sessionStore, openclawSessionId);
          resetBlockedStoredSessions.add(openclawSessionId);
          return { tracked: trackedSessions.get(openclawSessionId), stored: binding };
        });
        await abortDeferredCompactionCleanups(openclawSessionId);
        await bindingQueue.enqueue(openclawSessionId, async () => {
          const currentStored = await lookupStoredBinding(options?.sessionStore, openclawSessionId);
          const stillOwnsStoredSession =
            stored !== undefined && currentStored?.sdkSessionId === stored.sdkSessionId;
          if (stillOwnsStoredSession) {
            if (await deleteStoredBinding(options?.sessionStore, openclawSessionId)) {
              resetBlockedStoredSessions.delete(openclawSessionId);
            }
          } else {
            resetBlockedStoredSessions.delete(openclawSessionId);
          }
          if (
            tracked &&
            trackedSessions.get(openclawSessionId)?.sdkSessionId === tracked.sdkSessionId
          ) {
            trackedSessions.delete(openclawSessionId);
          }
        });
        if (!tracked) {
          // Session was created by a different harness, or already reset.
          return;
        }
        try {
          await tracked.client.deleteSession(tracked.sdkSessionId);
        } catch {
          // Best-effort: client may be stopped, session may not exist
          // server-side, or the SDK may report a transient error. The
          // registry already logs broadcast reset failures; swallow here
          // so one harness cannot block the reset broadcast.
        }
      }),

    compact: (
      params: AgentHarnessCompactParams &
        Partial<Pick<AgentHarnessCompactParams<2>, "hostCapabilities">>,
    ): Promise<AgentHarnessCompactResult | undefined> =>
      trackOperation(async () => {
        if (disposed) {
          return undefined;
        }
        const hostCapabilities = params.hostCapabilities;
        if (
          hostCapabilities?.kind !== "agent-harness-host-capability" ||
          hostCapabilities.version !== 1 ||
          typeof hostCapabilities.assertActive !== "function" ||
          typeof hostCapabilities.retainSourceAuthority !== "function"
        ) {
          throw new Error(
            "This host did not provide compaction source authority. Update OpenClaw before compacting this session.",
          );
        }
        hostCapabilities.assertActive();
        // The SDK owns Copilot history compaction. OpenClaw only resumes
        // the tracked SDK session and calls the session-scoped RPC; durable
        // OpenClaw session/transcript state stays in SQLite, with no marker
        // sidecars under the workspace.
        const openclawSessionId = params.sessionId;
        if (!openclawSessionId) {
          return {
            ok: false,
            compacted: false,
            reason: "missing-required-params",
          };
        }
        if (
          await bindingQueue.enqueue(openclawSessionId, () =>
            hasPendingDeferredCompactionCleanup(openclawSessionId),
          )
        ) {
          return failedCompaction("background-compaction-pending");
        }
        const tracked = trackedSessions.get(openclawSessionId);
        const currentCompactKey = computeCompactRequestKey(params);
        const { resolvePoolAcquire } = await import("./src/attempt.js");
        let resolvedPoolAcquire: ReturnType<typeof resolvePoolAcquire> | undefined;
        try {
          resolvedPoolAcquire = resolvePoolAcquire(params as never);
        } catch (error) {
          if (isCopilotByokUnsupportedProviderError(error)) {
            return failedCompaction("missing_thread_binding");
          }
          throw error;
        }
        const currentAuth = sessionAuthFields(resolvedPoolAcquire.auth);
        const compatibleTracked =
          tracked?.compactKey === currentCompactKey && sessionAuthMatches(tracked, currentAuth)
            ? tracked
            : undefined;
        if (!compatibleTracked) {
          // Durable bindings only carry SDK session ids. Manual SDK compaction also
          // needs the live SessionConfig with OpenClaw hooks/tools, so preserve the
          // binding for the next attempt and let the host compact transcript state.
          return failedCompaction("missing_thread_binding");
        }
        const poolAcquire = {
          key: compatibleTracked.poolKey,
          options: compatibleTracked.clientOptions,
        };
        let compactResult: CopilotHistoryCompactResult;
        let handle: PooledClient | undefined;
        let pool: CopilotClientPool | undefined;
        let activeSdkSession: CopilotHistoryCompactSession | undefined;
        let cleanupByokProxy: (() => Promise<void>) | undefined;
        const hookContext = buildCopilotCompactionHookContext(params);
        try {
          throwIfAborted(params.abortSignal);
          pool = await getPool();
          handle = await pool.acquire(poolAcquire.key, poolAcquire.options);
          const client = handle.client;
          const byokProxy =
            compatibleTracked.authMode === "byok" && compatibleTracked.sessionConfig.provider
              ? await createCopilotByokProxy({
                  mode: "byok",
                  provider: compatibleTracked.sessionConfig.provider,
                })
              : undefined;
          cleanupByokProxy = byokProxy?.close;
          const sessionConfig = byokProxy?.provider.provider
            ? { ...compatibleTracked.sessionConfig, provider: byokProxy.provider.provider }
            : compatibleTracked.sessionConfig;
          // Manual compaction resumes a distinct SDK session, bypassing the attempt event bridge.
          // Run the portable lifecycle hook here so both compaction paths stay observable.
          await runAgentHarnessBeforeCompactionHook({
            sessionFile: params.sessionFile,
            ctx: hookContext,
          });
          hostCapabilities.assertActive();
          compactResult = await compactWithSafetyTimeout(
            (abortSignal) =>
              compactTrackedSdkSession({
                abortSignal,
                assertCurrent: hostCapabilities.assertActive,
                client,
                customInstructions: params.customInstructions,
                gitHubToken:
                  compatibleTracked?.clientOptions.gitHubToken ??
                  (resolvedPoolAcquire?.auth.authMode === "gitHubToken"
                    ? resolvedPoolAcquire.auth.gitHubToken
                    : undefined),
                onSession: (session) => {
                  activeSdkSession = session;
                },
                sessionConfig,
                sdkSessionId: compatibleTracked.sdkSessionId,
              }),
            resolveCompactionTimeoutMs(
              (params as { config?: Parameters<typeof resolveCompactionTimeoutMs>[0] }).config,
            ),
            {
              abortSignal: params.abortSignal,
              onCancel: () =>
                void activeSdkSession?.rpc.history.abortManualCompaction().catch(() => undefined),
            },
          );
        } catch (err) {
          const rawError = err instanceof Error ? err.message : String(err);
          if (isStaleSdkSessionError(err)) {
            await bindingQueue.enqueue(openclawSessionId, async () => {
              if (
                trackedSessions.get(openclawSessionId)?.sdkSessionId ===
                compatibleTracked.sdkSessionId
              ) {
                await deleteStoredBinding(options?.sessionStore, openclawSessionId);
                trackedSessions.delete(openclawSessionId);
              }
            });
            return failedCompaction("stale_thread_binding", rawError);
          }
          return failedCompaction("copilot-sdk-history-compact-failed", rawError);
        } finally {
          await cleanupByokProxy?.();
          if (pool && handle) {
            try {
              await pool.release(handle);
            } catch {
              // Pool release failure must not mask the compaction outcome.
            }
          }
        }
        if (!compactResult.success) {
          return failedCompaction("copilot-sdk-history-compact-failed");
        }
        const compacted = compactResult.tokensRemoved > 0 || compactResult.messagesRemoved > 0;
        if (compacted) {
          await runAgentHarnessAfterCompactionHook({
            sessionFile: params.sessionFile,
            compactedCount: compactResult.messagesRemoved,
            ctx: hookContext,
          });
        }
        return {
          ok: true,
          compacted,
          reason: compacted ? "copilot-sdk-history-compacted" : "already under target",
          ...(compacted
            ? {
                result: {
                  summary: compactResult.summaryContent ?? "",
                  firstKeptEntryId: "",
                  tokensBefore:
                    params.currentTokenCount ??
                    (compactResult.contextWindow?.currentTokens ?? 0) + compactResult.tokensRemoved,
                  tokensAfter: compactResult.contextWindow?.currentTokens,
                  details: compactResult,
                  sessionId: params.sessionId,
                  sessionFile: params.sessionFile,
                },
              }
            : {}),
        };
      }),

    async dispose() {
      if (disposePromise) {
        return disposePromise;
      }
      disposed = true;
      disposePromise = (async () => {
        if (inFlight.size > 0) {
          await Promise.allSettled(inFlight);
        }
        // Deferred compaction callbacks retain pooled clients after an attempt.
        // Cancel them before pool disposal so they cannot outlive this harness.
        const cleanupSessionIds = [...deferredCompactionCleanups.keys()];
        for (const sessionId of cleanupSessionIds) {
          await abortDeferredCompactionCleanups(sessionId);
        }
        trackedSessions.clear();
        resetBlockedStoredSessions.clear();
        if (createdPool) {
          const errors = await createdPool.dispose();
          if (errors.length > 0) {
            throw new AggregateError(errors, "[copilot] pool disposal errors");
          }
        }
      })();
      return disposePromise;
    },
  };
}
