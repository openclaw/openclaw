import type { CopilotClient } from "@github/copilot-sdk";
import {
  compactWithSafetyTimeout,
  getModelProviderRequestTransport,
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
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { AttemptParamsLike, ModelRefInputObject } from "./src/attempt-types.js";
import type { CopilotSessionConfig } from "./src/attempt.js";
import { createCopilotByokAuth, resolveCopilotAuth, tokenFingerprint } from "./src/auth-bridge.js";
import { createCopilotByokProxy } from "./src/byok-proxy.js";
import {
  buildCopilotCompactionHookContext,
  isStaleSdkSessionError,
  throwIfAborted,
  type CopilotHistoryCompactResult,
  type CopilotHistoryCompactSession,
} from "./src/history-compaction.js";
import {
  isCopilotByokUnsupportedProviderError,
  resolveCopilotProvider,
  supportsCopilotByokProviderShape,
} from "./src/provider-bridge.js";
import type {
  ClientCreateOptions,
  CopilotClientPool,
  CopilotClientPoolOptions,
  PooledClient,
  PoolKey,
} from "./src/runtime.js";

type AgentHarnessIsolatedCompletion = NonNullable<AgentHarness["runIsolatedCompletionV2"]>;
type AgentHarnessIsolatedCompletionParams = Parameters<AgentHarnessIsolatedCompletion>[0];
type AgentHarnessIsolatedCompletionResult = Awaited<ReturnType<AgentHarnessIsolatedCompletion>>;
type CopilotSettledTurnFinalizationAttemptParams = Parameters<
  NonNullable<AgentHarnessV2["finalizeSettledTurn"]>
>[0]["attempt"];
type CopilotHarnessAttemptParams = (
  | AgentHarnessAttemptParamsV2
  | CopilotSettledTurnFinalizationAttemptParams
) & {
  initialReplayState?: AgentHarnessAttemptParamsV2["initialReplayState"] & {
    journalValidated?: boolean;
    sdkSessionId?: string;
  };
};

const COPILOT_PROVIDER_IDS: ReadonlySet<string> = new Set(["github-copilot"]);

interface CreateCopilotAgentHarnessOptions {
  id?: string;
  label?: string;
  pluginConfig?: unknown;
  pool?: CopilotClientPool;
  poolOptions?: CopilotClientPoolOptions;
  sessionStore?: CopilotSessionBindingStore;
}

interface TrackedSession {
  journalVersion?: 1;
  sdkSessionId: string;
  client: CopilotClient;
  clientOptions: ClientCreateOptions;
  poolKey: PoolKey;
  sessionConfig: CopilotSessionConfig;
  // A provider/model/cwd/auth change starts a fresh SDK session instead of resuming.
  compatKey: string;
  compactKey: string;
  authMode: "gitHubToken" | "useLoggedInUser" | "byok";
  authProfileId?: string;
  authProfileVersion?: string;
}

export type CopilotSessionBinding = {
  schemaVersion: 2;
  journalVersion?: 1;
  sdkSessionId: string;
  compatKey: string;
  compactKey: string;
  authMode: "gitHubToken" | "useLoggedInUser" | "byok";
  authProfileId?: string;
  authProfileVersion?: string;
  updatedAt: number;
};

type LegacyCopilotSessionBinding = {
  schemaVersion: 1;
  sdkSessionId: string;
  compatKey: string;
  updatedAt: number;
};

type CopilotAttemptSessionBinding = Pick<
  CopilotSessionBinding,
  "compatKey" | "journalVersion" | "sdkSessionId"
>;
type DeferredCompactionCleanupOutcome = "aborted" | "completed" | "deadline";
type DeferredCompactionCleanup = {
  abort: () => void;
  sdkSessionId: string;
};

type CopilotSessionBindingStore = Pick<
  PluginStateKeyedStore<CopilotSessionBinding>,
  "delete" | "lookup" | "register"
>;

type CopilotSessionAuth = Pick<
  CopilotSessionBinding,
  "authMode" | "authProfileId" | "authProfileVersion"
>;

function sessionAuthFields(auth: CopilotSessionAuth): CopilotSessionAuth {
  return auth.authMode === "gitHubToken" || auth.authMode === "byok"
    ? {
        authMode: auth.authMode,
        authProfileId: auth.authProfileId,
        authProfileVersion: auth.authProfileVersion,
      }
    : { authMode: "useLoggedInUser" };
}

function sessionAuthMatches(stored: CopilotSessionAuth, current: CopilotSessionAuth): boolean {
  if (stored.authMode !== current.authMode) {
    return false;
  }
  if (stored.authMode === "useLoggedInUser") {
    return true;
  }
  return (
    stored.authProfileId === current.authProfileId &&
    stored.authProfileVersion === current.authProfileVersion
  );
}

function normalizeBinding(
  value: CopilotSessionBinding | undefined,
): CopilotSessionBinding | undefined {
  if (
    !value ||
    value.schemaVersion !== 2 ||
    typeof value.sdkSessionId !== "string" ||
    value.sdkSessionId.trim() === "" ||
    typeof value.compatKey !== "string" ||
    value.compatKey.trim() === "" ||
    typeof value.compactKey !== "string" ||
    value.compactKey.trim() === "" ||
    (value.journalVersion !== undefined && value.journalVersion !== 1) ||
    (value.authMode !== "gitHubToken" &&
      value.authMode !== "byok" &&
      value.authMode !== "useLoggedInUser") ||
    ((value.authMode === "gitHubToken" || value.authMode === "byok") &&
      (typeof value.authProfileId !== "string" ||
        value.authProfileId.trim() === "" ||
        typeof value.authProfileVersion !== "string" ||
        value.authProfileVersion.trim() === "")) ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 2,
    ...(value.journalVersion === 1 ? { journalVersion: 1 as const } : {}),
    sdkSessionId: value.sdkSessionId.trim(),
    compatKey: value.compatKey,
    compactKey: value.compactKey,
    authMode: value.authMode,
    ...(value.authMode === "gitHubToken" || value.authMode === "byok"
      ? {
          authProfileId: value.authProfileId,
          authProfileVersion: value.authProfileVersion,
        }
      : {}),
    updatedAt: value.updatedAt,
  };
}

function normalizeAttemptBinding(value: unknown): CopilotAttemptSessionBinding | undefined {
  const current = normalizeBinding(value as CopilotSessionBinding | undefined);
  if (current) {
    return current;
  }
  const legacy = value as LegacyCopilotSessionBinding | undefined;
  if (
    !legacy ||
    legacy.schemaVersion !== 1 ||
    typeof legacy.sdkSessionId !== "string" ||
    legacy.sdkSessionId.trim() === "" ||
    typeof legacy.compatKey !== "string" ||
    legacy.compatKey.trim() === "" ||
    typeof legacy.updatedAt !== "number" ||
    !Number.isFinite(legacy.updatedAt)
  ) {
    return undefined;
  }
  return {
    sdkSessionId: legacy.sdkSessionId.trim(),
    compatKey: legacy.compatKey,
  };
}

async function lookupStoredBinding(
  store: CopilotSessionBindingStore | undefined,
  key: string,
): Promise<CopilotAttemptSessionBinding | undefined> {
  try {
    return normalizeAttemptBinding(await store?.lookup(key));
  } catch {
    try {
      await store?.delete(key);
    } catch {
      // Durable binding cleanup is best-effort; the turn can create a fresh SDK session.
    }
    return undefined;
  }
}

async function registerStoredBinding(
  store: CopilotSessionBindingStore | undefined,
  key: string,
  binding: CopilotSessionBinding,
): Promise<boolean> {
  try {
    await store?.register(key, binding);
    return true;
  } catch {
    try {
      await store?.delete(key);
    } catch {
      // A failed invalidation just degrades to in-memory reuse for this process.
    }
    // The in-memory binding still keeps this process warm; persistence is an optimization.
    return false;
  }
}

async function deleteStoredBinding(
  store: CopilotSessionBindingStore | undefined,
  key: string,
): Promise<boolean> {
  try {
    await store?.delete(key);
    return true;
  } catch {
    // Reset must still clear tracked SDK sessions even if plugin state is unhealthy.
    return false;
  }
}

async function compactTrackedSdkSession(params: {
  abortSignal?: AbortSignal;
  assertCurrent: () => void;
  client: CopilotClient;
  customInstructions?: string;
  gitHubToken?: string;
  onSession?: (session: CopilotHistoryCompactSession) => void;
  sessionConfig: CopilotSessionConfig;
  sdkSessionId: string;
}): Promise<CopilotHistoryCompactResult> {
  params.assertCurrent();
  throwIfAborted(params.abortSignal);
  const session = (await params.client.resumeSession(params.sdkSessionId, {
    ...params.sessionConfig,
    continuePendingWork: false,
    ...(params.gitHubToken ? { gitHubToken: params.gitHubToken } : {}),
    suppressResumeEvent: true,
  })) as unknown as CopilotHistoryCompactSession;
  params.onSession?.(session);
  const request = params.customInstructions?.trim()
    ? { customInstructions: params.customInstructions }
    : undefined;
  try {
    params.assertCurrent();
    throwIfAborted(params.abortSignal);
    return await session.rpc.history.compact(request);
  } finally {
    try {
      await session.disconnect();
    } catch {
      // Preserve the compaction or cancellation outcome; cleanup is best-effort here.
    }
  }
}

type CopilotCompactParamsLike = Omit<AgentHarnessCompactParams, "model"> &
  Pick<AttemptParamsLike, "auth" | "copilotHome" | "profileVersion"> & {
    model?: string | ModelRefInputObject;
    modelId?: string;
  };

type CopilotSessionCompatInput =
  | { kind: "attempt"; params: AttemptParamsLike }
  | { kind: "compact"; params: CopilotCompactParamsLike };

function readAgentIdFromSessionKey(sessionKey: unknown): string | undefined {
  if (typeof sessionKey !== "string") {
    return undefined;
  }
  const parts = sessionKey.trim().split(":");
  return parts[0] === "agent" && parts[1]?.trim() ? parts[1].trim() : undefined;
}

function computeSessionKey(
  input: CopilotSessionCompatInput,
  options: { includeApi: boolean; includeAuth: boolean },
): string {
  // Match the pool's effective auth resolution; hash tokens so rotation invalidates
  // replay without retaining the credential itself.
  const attempt = input.kind === "attempt" ? input.params : undefined;
  const compact = input.kind === "compact" ? input.params : undefined;
  const attemptModel = attempt?.model;
  const compactModel = compact?.model;
  const rawModel: string | ModelRefInputObject | undefined = attemptModel ?? compactModel;
  const modelObj: ModelRefInputObject =
    rawModel && typeof rawModel === "object"
      ? rawModel
      : (compact?.runtimeModel ?? {
          id: typeof rawModel === "string" ? rawModel : undefined,
        });
  const provider =
    normalizeOptionalString(modelObj.provider) ?? attempt?.provider ?? compact?.provider ?? "";
  const modelId =
    normalizeOptionalString(modelObj.id) ??
    attempt?.modelId ??
    compact?.modelId ??
    (typeof compactModel === "string" ? compactModel : "");
  const requestTransport =
    rawModel && typeof rawModel === "object"
      ? getModelProviderRequestTransport(rawModel)
      : undefined;
  const requestAuthMode = normalizeOptionalString(
    requestTransport?.auth?.mode ?? modelObj.request?.auth?.mode,
  );
  const azureApiVersion = normalizeOptionalString(
    modelObj.azureApiVersion ?? modelObj.params?.azureApiVersion,
  );
  // Invalid explicit auth fails in resolvePoolAcquire; keep its fingerprint
  // deterministic here without allowing it to match a valid session.
  let authParts: string[];
  let resolvedAgentId = "";
  let resolvedCopilotHome = "";
  try {
    const resolved = !options.includeAuth
      ? resolveCopilotAuth({
          agentId: input.params.agentId ?? readAgentIdFromSessionKey(input.params.sessionKey),
          agentDir: input.params.agentDir,
          workspaceDir: input.params.workspaceDir,
          copilotHome: input.params.copilotHome,
          auth: { useLoggedInUser: true },
        })
      : (() => {
          const modelProvider = resolveCopilotProvider({
            model: {
              api: normalizeOptionalString(modelObj.api),
              id: modelId,
              provider,
              baseUrl: normalizeOptionalString(modelObj.baseUrl),
              azureApiVersion,
              headers: modelObj.headers,
              authHeader: modelObj.authHeader,
              requestAuthMode,
              requestProxy: requestTransport?.proxy ?? modelObj.request?.proxy,
              requestTls: requestTransport?.tls ?? modelObj.request?.tls,
              requestAllowPrivateNetwork:
                requestTransport?.allowPrivateNetwork ?? modelObj.request?.allowPrivateNetwork,
              contextTokens: modelObj.contextTokens,
              contextWindow: modelObj.contextWindow,
              maxTokens: modelObj.maxTokens,
            },
            resolvedApiKey: input.params.resolvedApiKey,
            authProfileId: input.params.authProfileId,
          });
          return modelProvider.mode === "byok"
            ? createCopilotByokAuth({
                agentId: input.params.agentId ?? readAgentIdFromSessionKey(input.params.sessionKey),
                agentDir: input.params.agentDir,
                workspaceDir: input.params.workspaceDir,
                copilotHome: input.params.copilotHome,
                authProfileId: modelProvider.authProfileId,
                authProfileVersion: modelProvider.authProfileVersion,
              })
            : resolveCopilotAuth({
                agentId: input.params.agentId ?? readAgentIdFromSessionKey(input.params.sessionKey),
                agentDir: input.params.agentDir,
                workspaceDir: input.params.workspaceDir,
                copilotHome: input.params.copilotHome,
                auth: input.params.auth,
                resolvedApiKey: input.params.resolvedApiKey,
                authProfileId: input.params.authProfileId,
                profileVersion: input.params.profileVersion,
              });
        })();
    resolvedAgentId = resolved.agentId;
    resolvedCopilotHome = resolved.copilotHome;
    authParts = [
      `auth.mode=${resolved.authMode}`,
      `auth.profileId=${resolved.authProfileId ?? ""}`,
      `auth.profileVersion=${resolved.authProfileVersion ?? ""}`,
    ];
    if (!options.includeAuth) {
      authParts = [];
    }
  } catch {
    authParts = ["auth=unresolvable"];
  }
  const parts = [
    `provider=${provider}`,
    `model=${modelId}`,
    ...(options.includeApi ? [`api=${normalizeOptionalString(modelObj.api) ?? ""}`] : []),
    ...(options.includeApi
      ? [`baseUrlFingerprint=${fingerprintSessionValue(modelObj.baseUrl)}`]
      : []),
    `cwd=${input.params.cwd ?? input.params.workspaceDir ?? ""}`,
    `agentId=${resolvedAgentId}`,
    `agentDir=${input.params.agentDir ?? ""}`,
    `copilotHome=${input.params.copilotHome ?? ""}`,
    `resolvedCopilotHome=${resolvedCopilotHome}`,
    ...(options.includeAuth ? authParts : []),
  ];
  return parts.join("|");
}

function fingerprintSessionValue(value: unknown): string {
  return typeof value === "string" && value ? tokenFingerprint(value) : "";
}

function computeSessionCompatKey(params: AttemptParamsLike): string {
  return computeSessionKey({ kind: "attempt", params }, { includeApi: true, includeAuth: true });
}

function computeAttemptCompactKey(params: AttemptParamsLike): string {
  return computeSessionKey({ kind: "attempt", params }, { includeApi: false, includeAuth: false });
}

function computeCompactRequestKey(params: CopilotCompactParamsLike): string {
  return computeSessionKey({ kind: "compact", params }, { includeApi: false, includeAuth: false });
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

  function trackDeferredCompactionCleanup(params: {
    abort: () => void;
    cleanup: Promise<DeferredCompactionCleanupOutcome>;
    sessionId: string;
    sdkSessionId: string;
  }): void {
    const cleanups =
      deferredCompactionCleanups.get(params.sessionId) ??
      new Map<Promise<DeferredCompactionCleanupOutcome>, DeferredCompactionCleanup>();
    cleanups.set(params.cleanup, { abort: params.abort, sdkSessionId: params.sdkSessionId });
    deferredCompactionCleanups.set(params.sessionId, cleanups);
    void params.cleanup.then(
      () => removeDeferredCompactionCleanup(params.sessionId, params.cleanup),
      () => removeDeferredCompactionCleanup(params.sessionId, params.cleanup),
    );
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
      if (disposed) {
        throw new Error("[copilot] harness was disposed while starting an attempt");
      }
      const pool = await getPool();
      if (disposed) {
        throw new Error("[copilot] harness was disposed while starting an attempt");
      }
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
      const openclawSessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;

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
      if (disposed) {
        throw new Error("[copilot] harness was disposed while starting an attempt");
      }
      const resumableSessionId = resumableBinding?.sdkSessionId;
      if (operation === "settled-tool-finalization" && !resumableSessionId) {
        throw new Error(
          "[copilot] cannot safely finalize a settled tool turn without its compatible SDK session",
        );
      }
      const effectiveParams: CopilotHarnessAttemptParams = resumableSessionId
        ? ({
            ...params,
            ...(operation === "settled-tool-finalization"
              ? {
                  disableTools: true,
                  onAgentEvent: undefined,
                  onAgentToolResult: undefined,
                  onAssistantDelta: undefined,
                  onAssistantMessageStart: undefined,
                  onBlockReply: undefined,
                  onBlockReplyFlush: undefined,
                  onPartialReply: undefined,
                  onReasoningEnd: undefined,
                  onReasoningStream: undefined,
                  onToolResult: undefined,
                  onToolStreamBoundary: undefined,
                }
              : {}),
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
            ? ({
                compactionSessionConfig,
                sdkSessionId,
                pooledClient,
                sessionConfig,
              }: {
                compactionSessionConfig?: CopilotSessionConfig;
                sdkSessionId: string;
                pooledClient: PooledClient;
                sessionConfig: CopilotSessionConfig;
              }) =>
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
                  await registerStoredBinding(options?.sessionStore, openclawSessionId, {
                    schemaVersion: 2,
                    sdkSessionId,
                    compatKey: currentCompatKey,
                    compactKey: currentCompactKey,
                    ...sessionAuthFields(poolAcquire.auth),
                    updatedAt: Date.now(),
                  });
                  trackedSessions.set(openclawSessionId, tracked);
                  resetBlockedStoredSessions.delete(openclawSessionId);
                })
            : undefined,
        onDeferredCompaction: openclawSessionId
          ? ({
              abort,
              cleanup,
              sdkSessionId,
            }: {
              abort: () => void;
              cleanup: Promise<DeferredCompactionCleanupOutcome>;
              sdkSessionId: string;
            }) =>
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
                trackDeferredCompactionCleanup({
                  abort,
                  cleanup: bindingCleanup,
                  sessionId: openclawSessionId,
                  sdkSessionId,
                });
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
            await registerStoredBinding(options?.sessionStore, openclawSessionId, {
              schemaVersion: 2,
              ...(attemptResult.journalValidated ? { journalVersion: 1 } : {}),
              sdkSessionId,
              compatKey: nextTracked.compatKey,
              compactKey: nextTracked.compactKey,
              ...sessionAuthFields(nextTracked),
              updatedAt: Date.now(),
            });
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
      if (disposed) {
        throw new Error("[copilot] harness was disposed while starting isolated completion");
      }
      return await runCopilotIsolatedCompletion(params, async () => {
        const pool = await getPool();
        if (disposed) {
          throw new Error("[copilot] harness was disposed while starting isolated completion");
        }
        return pool;
      });
    });
  }

  return {
    id: options?.id ?? "copilot",
    label: options?.label ?? "GitHub Copilot agent runtime",
    autoSelection: { providerIds: [] },
    conversationToolPolicySupport: "exact",

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

    finalizeSettledTurn: async ({ attempt }) => {
      const result = await runHarnessAttempt(attempt, "settled-tool-finalization");
      return projectSettledTurnFinalizationAttemptResult(result);
    },

    reset: (params: AgentHarnessResetParams): Promise<void> =>
      trackOperation(async () => {
        if (disposed) {
          return;
        }
        const openclawSessionId =
          typeof params.sessionId === "string" ? params.sessionId : undefined;
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
        const openclawSessionId =
          typeof params.sessionId === "string" ? params.sessionId : undefined;
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
          return {
            ok: false,
            compacted: false,
            reason: "background-compaction-pending",
            failure: { reason: "background-compaction-pending" },
          };
        }
        const tracked = trackedSessions.get(openclawSessionId);
        const currentCompactKey = computeCompactRequestKey(params);
        const { resolvePoolAcquire } = await import("./src/attempt.js");
        let resolvedPoolAcquire: ReturnType<typeof resolvePoolAcquire> | undefined;
        try {
          resolvedPoolAcquire = resolvePoolAcquire(params as never);
        } catch (error) {
          if (isCopilotByokUnsupportedProviderError(error)) {
            return {
              ok: false,
              compacted: false,
              reason: "missing_thread_binding",
              failure: { reason: "missing_thread_binding" },
            };
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
          return {
            ok: false,
            compacted: false,
            reason: "missing_thread_binding",
            failure: { reason: "missing_thread_binding" },
          };
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
            return {
              ok: false,
              compacted: false,
              reason: "stale_thread_binding",
              failure: { reason: "stale_thread_binding", rawError },
            };
          }
          return {
            ok: false,
            compacted: false,
            reason: "copilot-sdk-history-compact-failed",
            failure: {
              reason: "copilot-sdk-history-compact-failed",
              rawError,
            },
          };
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
          return {
            ok: false,
            compacted: false,
            reason: "copilot-sdk-history-compact-failed",
            failure: { reason: "copilot-sdk-history-compact-failed" },
          };
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
