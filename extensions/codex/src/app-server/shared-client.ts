import {
  AgentHarnessPreflightError,
  resolveDefaultAgentDir,
} from "openclaw/plugin-sdk/agent-harness-registration";
import type { AgentHarnessRuntimeArtifactBinding } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { codexBuildSymbol } from "../build-state.js";
import { observeCodexCatalogClient } from "../session-catalog-events.js";
import {
  CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE,
  buildCodexAppServerInitializeTimeoutError,
  CodexAppServerStartupError,
} from "./attempt-timeouts.js";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  resolveCodexAppServerPreparedAuthProfileSnapshot,
  reconcileCodexComputerUseStartArtifacts,
} from "./auth-bridge.js";
import {
  CodexAppServerAuthProfileUnavailableError,
  formatCodexAuthProfileUnavailableMessage,
} from "./auth-profile-recovery.js";
import {
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerAuthProfileStore,
} from "./auth-profile.js";
import type * as codexAuth from "./auth-types.js";
import {
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerThreadOwnership,
  recordCodexAppServerAuthHandoff,
} from "./client-runtime.js";
import {
  resolveRemainingAcquireTimeout,
  withCodexWebSocketOpenRetry,
  withCodexAppServerAcquireDeadline,
} from "./client-startup-retry.js";
import { CodexAppServerClient, isUnsupportedCodexAppServerVersionError } from "./client.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexAppServerStartOptionsForAgent,
} from "./config-runtime.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";
import { waitForCodexDesktopGeneration } from "./desktop-generation.js";
import { ownCodexInferenceClient } from "./inference-routing.js";
import { isCodexAppServerProxyLaunch } from "./launch-args.js";
import {
  isManagedCodexDesktopCommand,
  assertInstalledCodexAppServerVersion,
  INSTALLED_CODEX_START_TIMEOUT_MS,
  readInstalledCodexAppServerStatus,
  rejectInstalledCodexAppServer,
  resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand,
} from "./managed-binary.js";
import {
  isCodexComputerUseCandidateArtifactsUnavailableError,
  resolveManagedFallbackStartOptions,
} from "./managed-fallback.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { createCodexResponsesOAuth, isCodexResponsesOAuth } from "./responses-oauth.js";
import { createSharedCodexAppServerClientKeyResolver } from "./shared-client-key.js";
import {
  SharedCodexFallbackJoinError,
  isSharedCodexFallbackJoinError,
  retainSharedClientEntry,
  releaseSharedClientEntry,
  refreshSharedClientIdleRetirement,
  createCodexAppServerStartupLifetime,
  getCurrentSharedClientEntry,
  getOrCreateSharedClientEntry,
  closeSharedClientEntryIfUnclaimed,
  getSharedCodexAppServerClientState,
  observeAcquire,
  observeSharedClientAcquire,
  recordSharedClientAcquireBoundary,
  ownCodexStartup,
  rekeySharedClientEntry,
  retireSharedCodexAppServerClientIfCurrent,
  retirePendingSharedClientEntryIfUnclaimed,
  waitForUnclaimedSharedClientStartup,
  type CodexAppServerAcquireObservation,
  type CodexAppServerStartupLifetime,
  type SharedCodexAppServerClientEntry,
  type SharedCodexAppServerClientStartup,
} from "./shared-client-lifecycle.js";
import { shouldTrackDesktopGeneration } from "./shared-client-start-policy.js";
import {
  resolveCodexAppServerSpawnIdentity,
  type CodexAppServerClientProcessIdentity,
} from "./spawn-identity.js";
import { CodexAdoptedThreadActiveError } from "./thread-lifecycle-errors.js";

export type { CodexAppServerAcquireObservation } from "./shared-client-lifecycle.js";

export {
  retireSharedCodexAppServerClientIfCurrent,
  retainSharedCodexAppServerClientByInstanceId,
} from "./shared-client-lifecycle.js";
// Keep disposal preloaded and build-scoped: shutdown must close the old clients
// even if another module copy has loaded replacement code.
const SHARED_CODEX_APP_SERVER_CLIENT_DISPOSER = codexBuildSymbol(
  "openclaw.codexAppServerClientDisposer",
);

type CodexAppServerClientStartupOptions = Omit<
  Awaited<ReturnType<typeof resolveCodexAppServerClientStartContext>>,
  "usesNativeAuth" | "authProfileId"
> &
  Pick<
    CodexAppServerClientOptions,
    | "runtimeArtifactMode"
    | "expectedRuntimeArtifact"
    | "config"
    | "timeoutMs"
    | "abandonSignal"
    | "onStartedClient"
    | "onAcquireObservation"
    | "assertCurrent"
  > & {
    lifetime: CodexAppServerStartupLifetime;
    authProfileId: string | null | undefined;
    onStartingClient?: (starting: Promise<CodexAppServerClient>) => void;
    onInitializedClient?: () => void;
    /** False asks this acquisition to join an already owned fallback startup. */
    onManagedFallback?: (startOptions: CodexAppServerStartOptions) => boolean;
  };

async function prepareCodexAppServerClient(options?: CodexAppServerClientOptions) {
  const lifetime = getSharedCodexAppServerClientState().startup;
  const abandonSignal = options?.abandonSignal
    ? AbortSignal.any([lifetime.controller.signal, options.abandonSignal])
    : lifetime.controller.signal;
  const assertCurrent = () => {
    if (abandonSignal.aborted) {
      throw new CodexAppServerStartupError("aborted", "codex app-server initialize aborted");
    }
  };
  assertCurrent();
  const startedAt = performance.now();
  observeAcquire(options, { boundary: "context" });
  const context = await withCodexAppServerAcquireDeadline(
    options?.timeoutMs ?? 0,
    ownCodexStartup(lifetime, resolveCodexAppServerClientStartContext(options, startedAt)),
    abandonSignal,
  );
  return { context, lifetime, abandonSignal, startedAt, assertCurrent };
}

/** Reads the exact successful spawn selection plus its initialized runtime identity. */
export function readCodexAppServerClientProcessIdentity(
  client: CodexAppServerClient,
): CodexAppServerClientProcessIdentity | undefined {
  const metadata = getSharedCodexAppServerClientState().startMetadata.get(client);
  if (!metadata) {
    return undefined;
  }
  const runtimeIdentity = client.getRuntimeIdentity();
  return {
    clientId: client.getInstanceId(),
    ...resolveCodexAppServerSpawnIdentity(metadata.startOptions, metadata.nativeCommand),
    ...(runtimeIdentity?.serverVersion ? { serverVersion: runtimeIdentity.serverVersion } : {}),
    ...(runtimeIdentity?.userAgent ? { userAgent: runtimeIdentity.userAgent } : {}),
  };
}

export function readCodexAppServerClientDesktopGenerationFingerprint(
  client: CodexAppServerClient,
): string | undefined {
  return readCodexAppServerClientDesktopGeneration(client)?.fingerprint;
}

export function readCodexAppServerClientDesktopGeneration(
  client: CodexAppServerClient,
): CodexDesktopGeneration | undefined {
  return getSharedCodexAppServerClientState().startMetadata.get(client)?.desktopGeneration;
}

export type CodexAppServerClientOptions = {
  startOptions?: CodexAppServerStartOptions;
  pluginConfig?: unknown;
  timeoutMs?: number;
  authProfileId?: string | null;
  authProfileStore?: AuthProfileStore;
  authBindingFingerprint?: string;
  /** Setup-only generation whose exact local runtime bytes are captured. */
  runtimeArtifactMode?: "capture";
  /** Previously minted exact runtime required before the process may start. */
  expectedRuntimeArtifact?: AgentHarnessRuntimeArtifactBinding;
  preparedAuth?: codexAuth.CodexAppServerPreparedAuth;
  authRequirement?: codexAuth.CodexAppServerAuthRequirement;
  agentId?: string;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  onStartedClient?: (client: CodexAppServerClient) => void;
  onAcquireObservation?: (observation: CodexAppServerAcquireObservation) => void;
  abandonSignal?: AbortSignal;
  /** Caller authority for startup of an isolated, caller-owned client. */
  assertCurrent?: () => void;
};

/** Factory used by attempt startup and side turns to acquire a leased client. */
export type CodexAppServerClientFactory = (
  options?: CodexAppServerClientOptions,
) => Promise<CodexAppServerClient>;

async function resolveCodexAppServerClientStartContext(
  options: CodexAppServerClientOptions | undefined,
  startedAt: number,
) {
  const requestedStartOptions =
    options?.startOptions ??
    resolveCodexAppServerRuntimeOptions({ pluginConfig: options?.pluginConfig }).start;
  const agentDir =
    options?.agentDir ??
    (requestedStartOptions.homeScope === "user"
      ? undefined
      : resolveDefaultAgentDir(options?.config ?? {}));
  const desktopGeneration = shouldTrackDesktopGeneration(
    requestedStartOptions,
    options?.pluginConfig,
  )
    ? await waitForCodexDesktopGeneration()
    : undefined;
  const preparedAuth = options?.preparedAuth;
  const preparedApiKey = preparedAuth?.kind === "api-key" ? preparedAuth.apiKey.trim() : undefined;
  if (preparedAuth && options?.authProfileId !== undefined) {
    throw new Error("Prepared Codex auth cannot also select a legacy auth profile.");
  }
  if (preparedAuth?.kind === "profile" && !preparedAuth.store.profiles[preparedAuth.profileId]) {
    throw new CodexAppServerAuthProfileUnavailableError(
      formatCodexAuthProfileUnavailableMessage(preparedAuth.profileId),
    );
  }
  if (preparedAuth?.kind === "api-key" && !preparedApiKey) {
    throw new Error("Prepared Codex API-key auth is missing its resolved key.");
  }
  if (preparedAuth && requestedStartOptions.homeScope === "user") {
    // Backstop for the auth-bridge handoff: an app-server on the operator's native
    // home persists api-key logins into CODEX_HOME/auth.json and replaces the live
    // ChatGPT account for token logins, so prepared auth must never reach it.
    throw new Error("Prepared Codex auth requires an isolated app-server home.");
  }
  const preparedAuthRequirement =
    preparedAuth &&
    (preparedAuth.kind === "api-key" || isCodexResponsesOAuth(preparedAuth)
      ? "api-key"
      : "subscription");
  if (
    options?.authRequirement &&
    preparedAuthRequirement &&
    options.authRequirement !== preparedAuthRequirement
  ) {
    throw new Error("Prepared Codex auth does not satisfy the requested auth requirement.");
  }
  let authRequirement = options?.authRequirement ?? preparedAuthRequirement;
  const usesNativeAuth =
    !preparedAuth &&
    (options?.authProfileId === null || requestedStartOptions.homeScope === "user");
  const requestedAuthProfileId =
    preparedAuth?.kind === "profile"
      ? preparedAuth.profileId
      : (options?.authProfileId ?? undefined);
  const authProfileStore =
    preparedAuth?.kind === "profile"
      ? preparedAuth.store
      : !usesNativeAuth && preparedAuth?.kind !== "api-key"
        ? resolveCodexAppServerAuthProfileStore({
            agentDir,
            authProfileId: requestedAuthProfileId,
            authProfileStore: options?.authProfileStore,
            config: options?.config,
          })
        : options?.authProfileStore;
  const authProfileId =
    preparedAuth?.kind === "profile"
      ? preparedAuth.profileId
      : usesNativeAuth || preparedAuth?.kind === "api-key"
        ? undefined
        : resolveCodexAppServerAuthProfileIdForAgent({
            authProfileId: requestedAuthProfileId,
            agentDir,
            config: options?.config,
            ...(authProfileStore ? { authProfileStore } : {}),
          });
  // Resolve the selected profile once: the keyed process must log in with the
  // same account material, including ordinary catalog callers without prepared auth.
  const preparedAuthProfileSnapshot =
    !usesNativeAuth && authProfileId
      ? ((preparedAuth?.kind === "profile" ? preparedAuth.snapshot : undefined) ??
        (await resolveCodexAppServerPreparedAuthProfileSnapshot({
          authProfileId,
          authProfileStore,
          agentDir,
          config: options?.config,
        })))
      : undefined;
  if (preparedAuth?.kind === "profile" && !preparedAuthProfileSnapshot) {
    throw new CodexAppServerAuthProfileUnavailableError(
      `Prepared Codex auth profile "${preparedAuth.profileId}" is unusable. Repair or replace the selected OpenAI profile, then retry.`,
    );
  }
  const resolvedPreparedAuth: codexAuth.CodexAppServerResolvedPreparedAuth | undefined =
    preparedAuth?.kind === "api-key"
      ? { kind: "api-key", apiKey: preparedApiKey as string }
      : preparedAuthProfileSnapshot && authProfileId && authProfileStore
        ? {
            kind: "profile",
            profileId: authProfileId,
            store: authProfileStore,
            snapshot: preparedAuthProfileSnapshot,
          }
        : undefined;
  if (isCodexResponsesOAuth(resolvedPreparedAuth)) {
    if (authRequirement && authRequirement !== "api-key") {
      throw new Error("ChatGPT subscription sharing requires the public OpenAI API route.");
    }
    authRequirement = "api-key";
  }
  const agentStartOptions = resolveCodexAppServerStartOptionsForAgent({
    startOptions: requestedStartOptions,
    agentDir,
  });
  const remainingMs = resolveRemainingAcquireTimeout(options?.timeoutMs ?? 0, startedAt);
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(agentStartOptions, {
    selectionTimeoutMs: remainingMs > 0 ? remainingMs / 2 : undefined,
  });
  // Preserve ordinary profile environment policy; only explicitly prepared
  // handoffs clear all inherited auth variables before spawning.
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentId: options?.agentId,
    agentDir,
    authProfileId: usesNativeAuth || preparedAuth?.kind === "api-key" ? null : authProfileId,
    ...((preparedAuth || isCodexResponsesOAuth(resolvedPreparedAuth)) && resolvedPreparedAuth
      ? { preparedAuth: resolvedPreparedAuth }
      : {}),
    authRequirement,
    config: options?.config,
    pluginConfig: options?.pluginConfig,
    ...(authProfileStore ? { authProfileStore } : {}),
  });
  return {
    agentDir,
    usesNativeAuth,
    authProfileId,
    authProfileStore,
    requestedStartOptions,
    preparedAuth: resolvedPreparedAuth,
    authRequirement,
    startOptions,
    ...(options?.pluginConfig !== undefined ? { pluginConfig: options.pluginConfig } : {}),
    ...(desktopGeneration ? { desktopGeneration } : {}),
  };
}

/** Gets or starts a shared Codex app-server client without retaining a lease. */
export function getSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  return acquireSharedCodexAppServerClient(options);
}

/** Gets or starts a shared Codex app-server client and records a release lease. */
export function getLeasedSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  return acquireSharedCodexAppServerClient(options, true);
}

export function releaseLeasedSharedCodexAppServerClient(client: CodexAppServerClient): boolean {
  const entry = getSharedCodexAppServerClientState().entriesByClient.get(client);
  if (!entry || entry.anonymousLeases === 0) {
    return false;
  }
  entry.anonymousLeases -= 1;
  releaseSharedClientEntry(entry, "activeLeases");
  return true;
}

/** Mutable ownership token for one shared-client lease across client replacement. */
export type CodexAppServerClientLease = { client?: CodexAppServerClient };

/** Releases the currently owned client exactly once. */
export function releaseCodexAppServerClientLease(lease: CodexAppServerClientLease): boolean {
  const client = lease.client;
  lease.client = undefined;
  return client ? releaseLeasedSharedCodexAppServerClient(client) : false;
}

export type CodexAppServerLeasedRequestOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  assertCurrent: () => void;
};

/** Shares a deadline and live lease check across one operation's requests. */
export async function withCodexAppServerClientRequestScope<T>(params: {
  lease: CodexAppServerClientLease;
  options?: CodexAppServerClientOptions;
  signal?: AbortSignal;
  run: (
    client: CodexAppServerClient,
    requestOptions: () => CodexAppServerLeasedRequestOptions,
  ) => Promise<T>;
}): Promise<T> {
  const client = params.lease.client;
  if (!client) {
    throw new Error("Codex app-server request scope requires an active client lease");
  }
  const timeoutMs = params.options?.timeoutMs ?? 60_000;
  const deadline = performance.now() + timeoutMs;
  const signal = params.signal ?? params.options?.abandonSignal;
  const requestOptions = () => {
    if (signal?.aborted) {
      throw new CodexAppServerStartupError("aborted", "Codex app-server request aborted");
    }
    const remainingTimeoutMs = deadline - performance.now();
    if (remainingTimeoutMs <= 0) {
      throw new CodexAppServerStartupError("timed_out", "Codex app-server request timed out");
    }
    return {
      timeoutMs: remainingTimeoutMs,
      ...(signal ? { signal } : {}),
    };
  };
  let scopeActive = true;
  const assertCurrent = () => {
    if (!scopeActive || params.lease.client !== client) {
      throw new CodexAppServerStartupError("aborted", "Codex app-server request scope is closed");
    }
  };
  try {
    requestOptions();
    return await params.run(client, () => {
      assertCurrent();
      return { ...requestOptions(), assertCurrent };
    });
  } finally {
    scopeActive = false;
  }
}

async function acquireSharedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
  leased = false,
): Promise<CodexAppServerClient> {
  const timeoutMs = options?.timeoutMs ?? 0;
  const state = getSharedCodexAppServerClientState();
  const { context, lifetime, abandonSignal, startedAt, assertCurrent } =
    await prepareCodexAppServerClient(options);
  assertCurrent();
  observeAcquire(options, { boundary: "entry-selection" });
  const { usesNativeAuth, ...startContext } = context;
  const {
    agentDir,
    authProfileId,
    authProfileStore,
    preparedAuth,
    authRequirement,
    startOptions,
    desktopGeneration,
  } = startContext;
  const remainingTimeoutMs = resolveRemainingAcquireTimeout(timeoutMs, startedAt);
  const runtimeArtifactMode =
    options?.runtimeArtifactMode ?? (options?.expectedRuntimeArtifact ? "capture" : undefined);
  const keyFor = createSharedCodexAppServerClientKeyResolver({
    startOptions,
    agentDir,
    authProfileId,
    authBindingFingerprint: options?.authBindingFingerprint,
    preparedAuth,
    authRequirement,
    usesNativeAuth,
    desktopGeneration,
    runtimeArtifactMode,
    expectedRuntimeArtifact: options?.expectedRuntimeArtifact,
  });
  const key = keyFor(startOptions);
  const entry = getOrCreateSharedClientEntry(state, key);
  entry.startupAbort ??= new AbortController();
  entry.closeWhenIdle = false;
  const releasePendingAcquire = retainSharedClientEntry(entry, "pendingAcquires");
  const stopAcquireObservations = observeSharedClientAcquire(entry, options);
  const startedCallback = options?.onStartedClient;
  if (startedCallback) {
    entry.onStartedClientCallbacks.add(startedCallback);
    if (entry.client) {
      startedCallback(entry.client);
    }
  }
  const stopStartedClientNotifications = () => {
    stopAcquireObservations();
    if (startedCallback) {
      entry.onStartedClientCallbacks.delete(startedCallback);
    }
  };
  let cleanupAbandonSignal: (() => void) | undefined;
  if (options?.abandonSignal) {
    const abandon = () => {
      // Release this acquire before cleanup checks ownership; only other
      // pending callers should keep the startup client alive.
      stopStartedClientNotifications();
      releasePendingAcquire();
      retirePendingSharedClientEntryIfUnclaimed(entry);
    };
    options.abandonSignal.addEventListener("abort", abandon, { once: true });
    cleanupAbandonSignal = () => options.abandonSignal?.removeEventListener("abort", abandon);
    if (options.abandonSignal.aborted) {
      abandon();
    }
  }
  const startup =
    entry.startup ??
    (entry.startup = createSharedCodexAppServerClientStartup({
      ...startContext,
      lifetime,
      entry,
      onManagedFallback: (fallback) => rekeySharedClientEntry(entry, keyFor(fallback)),
      authProfileId: usesNativeAuth || preparedAuth?.kind === "api-key" ? null : authProfileId,
      runtimeArtifactMode,
      expectedRuntimeArtifact: options?.expectedRuntimeArtifact,
      abandonSignal: entry.startupAbort.signal,
      config: options?.config,
    }));
  try {
    await withCodexAppServerAcquireDeadline(
      remainingTimeoutMs,
      startup.initialized,
      abandonSignal,
      CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE,
      () => buildCodexAppServerInitializeTimeoutError(entry.client),
    );
    const client = await withCodexAppServerAcquireDeadline(
      timeoutMs,
      startup.ready,
      abandonSignal,
      "codex app-server authentication timed out",
    );
    if (entry.closeError) {
      throw entry.closeError;
    }
    // Later leases of the same keyed client may carry fresher config; the
    // runtime install itself stays one-per-physical-client.
    ensureCodexAppServerClientRuntime(client, {
      agentDir,
      authProfileId: usesNativeAuth ? undefined : authProfileId,
      ...(authProfileStore ? { authProfileStore } : {}),
      authMode:
        preparedAuth?.kind === "api-key" || isCodexResponsesOAuth(preparedAuth)
          ? "prepared-api-key"
          : "profile",
      config: options?.config,
    });
    if (leased) {
      entry.anonymousLeases += 1;
      entry.activeLeases += 1;
    }
    return client;
  } catch (error) {
    // This deadline belongs to one waiter, not the shared physical client.
    // Release first so only the final claimant can tear down stalled startup.
    releasePendingAcquire();
    retirePendingSharedClientEntryIfUnclaimed(entry);
    observeAcquire(options, { boundary: "cleanup" });
    await waitForUnclaimedSharedClientStartup(entry);
    if (isSharedCodexFallbackJoinError(error)) {
      return acquireSharedCodexAppServerClient(
        { ...options, timeoutMs: resolveRemainingAcquireTimeout(timeoutMs, startedAt) },
        leased,
      );
    }
    throw error;
  } finally {
    cleanupAbandonSignal?.();
    stopStartedClientNotifications();
    releasePendingAcquire();
  }
}

function createSharedCodexAppServerClientStartup(
  params: CodexAppServerClientStartupOptions & {
    entry: SharedCodexAppServerClientEntry;
  },
): SharedCodexAppServerClientStartup {
  const initialized = createDeferred<void>();
  const ready = ownCodexStartup(
    params.lifetime,
    startInitializedCodexAppServerClient({
      ...params,
      onAcquireObservation: ({ boundary }) => {
        recordSharedClientAcquireBoundary(params.entry, boundary);
      },
      onStartingClient: (starting) => {
        params.entry.startupTransport = starting;
      },
      onStartedClient: (startedClient) => {
        const state = getSharedCodexAppServerClientState();
        // Rejected candidates must never retain a reverse path to their replacement.
        if (params.entry.client) {
          state.entriesByClient.delete(params.entry.client);
        }
        params.entry.client = startedClient;
        state.entriesByClient.set(startedClient, params.entry);
        // Graceful retirement detaches active clients from the acquisition map,
        // so generation fencing tracks physical lifetime until transport exit.
        state.liveClients.add(startedClient);
        startedClient.addTransportExitHandler((exitedClient) => {
          state.liveClients.delete(exitedClient);
        });
        for (const callback of params.entry.onStartedClientCallbacks) {
          callback(startedClient);
        }
        retirePendingSharedClientEntryIfUnclaimed(params.entry);
      },
      onInitializedClient: () => initialized.resolve(),
    }).then(
      (client) => {
        const state = getSharedCodexAppServerClientState();
        params.entry.client = client;
        params.entry.hasOwnedThreads = () => hasCodexAppServerThreadOwnership(client);
        // Unsupported managed candidates close before fallback starts. Only the
        // ready client's closure may remove the shared acquisition entry.
        client.addCloseHandler((closedClient) => {
          clearTimeout(params.entry.idleTimer);
          params.entry.idleTimer = undefined;
          const entry = getCurrentSharedClientEntry(closedClient);
          if (entry) {
            state.clients.delete(entry.key);
          }
        });
        return client;
      },
      (error: unknown) => {
        initialized.reject(error);
        throw error;
      },
    ),
  );
  // Callers observe pre-initialize failures through the phase promise first.
  void initialized.promise.catch(() => undefined);
  void ready.catch(() => undefined);
  return { initialized: initialized.promise, ready };
}

/** Starts a caller-owned client; its assertion never binds ordinary shared-client leases. */
export async function createIsolatedCodexAppServerClient(
  options?: CodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  options?.assertCurrent?.();
  const { context, lifetime, abandonSignal, startedAt, assertCurrent } =
    await prepareCodexAppServerClient(options);
  assertCurrent();
  const timeoutMs = options?.timeoutMs ?? 0;
  const { usesNativeAuth, ...startContext } = context;
  observeAcquire(options, { boundary: "entry-selection", startup: "isolated" });
  return await ownCodexStartup(
    lifetime,
    startInitializedCodexAppServerClient({
      ...startContext,
      lifetime,
      authProfileId:
        usesNativeAuth || context.preparedAuth?.kind === "api-key" ? null : context.authProfileId,
      runtimeArtifactMode:
        options?.runtimeArtifactMode ?? (options?.expectedRuntimeArtifact ? "capture" : undefined),
      expectedRuntimeArtifact: options?.expectedRuntimeArtifact,
      config: options?.config,
      timeoutMs: resolveRemainingAcquireTimeout(timeoutMs, startedAt),
      abandonSignal,
      assertCurrent: options?.assertCurrent,
      onAcquireObservation: options?.onAcquireObservation,
      onStartedClient: (client) => {
        const state = getSharedCodexAppServerClientState();
        state.isolatedClients.add(client);
        client.addTransportExitHandler((exitedClient) => {
          state.isolatedClients.delete(exitedClient);
        });
        options?.onStartedClient?.(client);
      },
    }),
  );
}

function startInitializedCodexAppServerClient(params: CodexAppServerClientStartupOptions) {
  return withCodexWebSocketOpenRetry({
    timeoutMs: params.timeoutMs ?? 0,
    signal: params.abandonSignal
      ? AbortSignal.any([params.lifetime.controller.signal, params.abandonSignal])
      : params.lifetime.controller.signal,
    start: (timeoutMs) => startInitializedCodexAppServerClientOnce({ ...params, timeoutMs }),
  });
}

async function startInitializedCodexAppServerClientOnce(
  params: CodexAppServerClientStartupOptions,
): Promise<CodexAppServerClient> {
  const acquireStartedAt = performance.now();
  const timeoutMs = params.timeoutMs ?? 0;
  const abandonSignal = params.abandonSignal
    ? AbortSignal.any([params.lifetime.controller.signal, params.abandonSignal])
    : params.lifetime.controller.signal;
  const waitForStartup = <T>(
    operation: () => Promise<T>,
    timeoutErrorFactory?: () => CodexAppServerStartupError,
    candidateLimitMs?: number,
  ) => {
    if (abandonSignal.aborted) {
      throw new CodexAppServerStartupError("aborted", "codex app-server initialize aborted");
    }
    const remainingMs = resolveRemainingAcquireTimeout(timeoutMs, acquireStartedAt);
    return withCodexAppServerAcquireDeadline(
      candidateLimitMs === undefined
        ? remainingMs
        : remainingMs > 0
          ? Math.min(remainingMs / 2, candidateLimitMs)
          : candidateLimitMs,
      ownCodexStartup(params.lifetime, operation()),
      abandonSignal,
      CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE,
      timeoutErrorFactory,
    );
  };
  const startOptionsCandidates = resolveManagedFallbackStartOptions(params.startOptions);
  // A selected installed Codex that cannot start or reports another version
  // yields to the bundled package here, before any thread or turn exists.
  const yieldInstalledCodex = (index: number, command: string, error: unknown) => {
    if (
      params.startOptions.commandSource !== "resolved-managed" ||
      index + 1 >= startOptionsCandidates.length ||
      readInstalledCodexAppServerStatus(command) === undefined ||
      abandonSignal.aborted
    ) {
      return false;
    }
    try {
      params.assertCurrent?.();
    } catch {
      return false;
    }
    // Publish fallback ownership before rejection makes fresh callers resolve
    // the bundled command. A prior owner is joined through a fresh acquisition.
    const ownsFallback = params.onManagedFallback?.(startOptionsCandidates[index + 1]!) ?? true;
    rejectInstalledCodexAppServer(command, error);
    if (!ownsFallback) {
      throw new SharedCodexFallbackJoinError();
    }
    return true;
  };
  for (const [index, startOptions] of startOptionsCandidates.entries()) {
    params.assertCurrent?.();
    const desktopCommand = isManagedCodexDesktopCommand(startOptions.command);
    const desktopGeneration =
      params.desktopGeneration ??
      (desktopCommand ? await waitForStartup(waitForCodexDesktopGeneration) : undefined);
    const assertStartupCurrent = () => {
      params.assertCurrent?.();
      if (abandonSignal.aborted) {
        throw new CodexAppServerStartupError("aborted", "codex app-server initialize aborted");
      }
    };
    const ownsIsolatedCodexHome =
      params.requestedStartOptions.homeScope !== "user" &&
      !params.requestedStartOptions.env?.CODEX_HOME?.trim();
    try {
      // Desktop updates during startup are best effort; the next acquisition
      // observes the new fingerprint without draining unrelated active turns.
      await reconcileCodexComputerUseStartArtifacts({
        startOptions,
        agentDir: params.agentDir,
        pluginConfig: params.pluginConfig,
        ...(desktopGeneration ? { desktopGeneration } : {}),
        assertCurrent: assertStartupCurrent,
        ownsIsolatedCodexHome,
      });
    } catch (error) {
      if (isCodexComputerUseCandidateArtifactsUnavailableError(error)) {
        if (index + 1 < startOptionsCandidates.length) {
          continue;
        }
        throw new AgentHarnessPreflightError(
          "Codex Computer Use artifacts are unavailable from the installed desktop apps.",
          { cause: error, scope: "harness" },
        );
      }
      throw error;
    }
    const runtimeArtifactModule = params.runtimeArtifactMode
      ? await import("./runtime-artifact.js")
      : undefined;
    const runtimeArtifactBeforeStart = runtimeArtifactModule
      ? await runtimeArtifactModule.captureCodexAppServerRuntimeArtifactBeforeStart({
          startOptions,
          spawnIdentity: resolveCodexAppServerSpawnIdentity(startOptions),
          signal: abandonSignal,
        })
      : undefined;
    if (
      runtimeArtifactModule &&
      runtimeArtifactBeforeStart &&
      params.expectedRuntimeArtifact &&
      !runtimeArtifactModule.validateCodexAppServerRuntimeArtifactCapture(
        params.expectedRuntimeArtifact,
        runtimeArtifactBeforeStart,
      )
    ) {
      if (index + 1 < startOptionsCandidates.length) {
        continue;
      }
      throw new Error("Codex app-server runtime artifact does not match verified inference");
    }
    assertStartupCurrent();
    let starting: Promise<CodexAppServerClient> | undefined;
    let client: CodexAppServerClient;
    try {
      observeAcquire(params, { boundary: "transport-registration" });
      client = await waitForStartup(() => {
        starting = CodexAppServerClient.start(startOptions, () => {
          assertStartupCurrent();
          resolveRemainingAcquireTimeout(timeoutMs, acquireStartedAt);
        });
        params.onStartingClient?.(starting);
        return starting;
      });
    } catch (error) {
      // A timed-out registration may settle later; it cannot publish a live
      // client after the acquisition owner has already released its claim.
      if (starting) {
        observeAcquire(params, { boundary: "cleanup" });
        await ownCodexStartup(
          params.lifetime,
          starting.then(
            (lateClient) => lateClient.closeAndWait(),
            () => {},
          ),
        );
      }
      if (yieldInstalledCodex(index, startOptions.command, error)) {
        continue;
      }
      throw error;
    }
    client.addCloseHandler((closedClient) => {
      // Retired transports leave liveClients on exit; their admitted local work
      // must still settle before this plugin generation releases its resources.
      void ownCodexStartup(params.lifetime, closedClient.waitForCloseWork());
    });
    let ready = false;
    try {
      const nativeCommandAtStart =
        startOptions.commandSource === "resolved-managed"
          ? resolveManagedCodexNativeCommand(startOptions.command)
          : undefined;
      getSharedCodexAppServerClientState().startMetadata.set(client, {
        requestedStartOptions: params.requestedStartOptions,
        startOptions,
        agentDir: params.agentDir,
        ...(nativeCommandAtStart ? { nativeCommand: nativeCommandAtStart } : {}),
        ...(desktopGeneration ? { desktopGeneration } : {}),
      });
      assertStartupCurrent();
      params.onStartedClient?.(client);
      observeAcquire(params, { boundary: "initialize" });
      try {
        await waitForStartup(
          () => client.initialize(),
          () => buildCodexAppServerInitializeTimeoutError(client),
          // A hanging installed Codex leaves time to start the bundled fallback.
          startOptions.commandSource === "resolved-managed" &&
            index + 1 < startOptionsCandidates.length &&
            readInstalledCodexAppServerStatus(startOptions.command) !== undefined
            ? INSTALLED_CODEX_START_TIMEOUT_MS
            : undefined,
        );
        if (startOptions.commandSource === "resolved-managed") {
          assertInstalledCodexAppServerVersion(startOptions.command, client.getServerVersion());
        }
      } catch (error) {
        // The installed check runs first so an unsupported version also drops it.
        if (
          yieldInstalledCodex(index, startOptions.command, error) ||
          (startOptions.commandSource === "resolved-managed" &&
            index < startOptionsCandidates.length - 1 &&
            isUnsupportedCodexAppServerVersionError(error))
        ) {
          continue;
        }
        throw error;
      }
      assertStartupCurrent();
      params.onInitializedClient?.();
      observeAcquire(params, { boundary: "catalog-observation" });
      await waitForStartup(() =>
        observeCodexCatalogClient(client, {
          startOptions: params.requestedStartOptions,
          agentDir: params.agentDir,
        }),
      );

      observeAcquire(params, { boundary: "runtime-binding" });
      let runtimeArtifact: AgentHarnessRuntimeArtifactBinding | undefined;
      if (runtimeArtifactModule && runtimeArtifactBeforeStart) {
        runtimeArtifact = await runtimeArtifactModule.finalizeCodexAppServerRuntimeArtifact({
          before: runtimeArtifactBeforeStart,
          startOptions,
          spawnIdentity: resolveCodexAppServerSpawnIdentity(startOptions),
          runtimeIdentity: client.getRuntimeIdentity(),
          signal: abandonSignal,
        });
        if (
          params.expectedRuntimeArtifact &&
          (runtimeArtifact.id !== params.expectedRuntimeArtifact.id ||
            runtimeArtifact.fingerprint !== params.expectedRuntimeArtifact.fingerprint)
        ) {
          throw new Error("Codex app-server runtime artifact does not match verified inference");
        }
      }
      ensureCodexAppServerClientRuntime(
        client,
        {
          agentDir: params.agentDir,
          authProfileId: params.authProfileId ?? undefined,
          authMode:
            params.preparedAuth?.kind === "api-key" || isCodexResponsesOAuth(params.preparedAuth)
              ? "prepared-api-key"
              : "profile",
          ...(params.authProfileStore ? { authProfileStore: params.authProfileStore } : {}),
          config: params.config,
          onAuthRefreshFailure: () => retireSharedCodexAppServerClientIfCurrent(client),
        },
        () => refreshSharedClientIdleRetirement(client),
      );

      assertStartupCurrent();
      observeAcquire(params, { boundary: "auth-handoff" });
      const authHandoff = await waitForStartup(() =>
        applyCodexAppServerAuthProfile({
          client,
          agentDir: params.agentDir,
          authProfileId: params.authProfileId,
          preparedAuth: params.preparedAuth,
          authRequirement: params.authRequirement,
          startOptions,
          config: params.config,
          assertCurrent: assertStartupCurrent,
          ...(params.authProfileStore ? { authProfileStore: params.authProfileStore } : {}),
        }),
      );
      const ownsInference =
        startOptions.transport === "stdio" &&
        nativeCommandAtStart &&
        !isCodexAppServerProxyLaunch(startOptions.args);
      // Desktop binaries launched as our direct stdio child share the same
      // request-local carrier; attachments and proxy launches are not owned.
      // Subscription sharing retains its separate managed-package restriction.
      if (
        isCodexResponsesOAuth(params.preparedAuth) &&
        (!ownsInference || desktopGeneration || desktopCommand)
      ) {
        throw new Error("ChatGPT subscription sharing requires a managed local Codex process.");
      }
      if (ownsInference) {
        const prepared = params.preparedAuth;
        ownCodexInferenceClient(
          client,
          startOptions,
          isCodexResponsesOAuth(prepared) && prepared?.kind === "profile"
            ? createCodexResponsesOAuth({
                profileId: prepared.profileId,
                store: prepared.store,
                fingerprint: prepared.snapshot.secretFreeCacheKey,
                agentDir: params.agentDir,
                config: params.config,
              })
            : undefined,
        );
      }
      recordCodexAppServerAuthHandoff(client, authHandoff);
      if (runtimeArtifactModule && runtimeArtifact) {
        runtimeArtifactModule.bindCodexAppServerRuntimeArtifact(client, runtimeArtifact);
      }
      assertStartupCurrent();
      ready = true;
      observeAcquire(params, { boundary: "ready" });
      return client;
    } finally {
      if (!ready) {
        observeAcquire(params, { boundary: "cleanup" });
        await ownCodexStartup(params.lifetime, client.closeAndWait());
      }
    }
  }
  throw new Error("Managed Codex app-server fallback candidates were exhausted.");
}

function detachCurrentSharedClient(
  client: CodexAppServerClient | undefined,
): client is CodexAppServerClient {
  const entry = client && getCurrentSharedClientEntry(client);
  return Boolean(entry && getSharedCodexAppServerClientState().clients.delete(entry.key));
}

/** Captures the physical client lifetime for passive catalog reads. */
export function captureSharedCodexAppServerCatalogLifetime(
  client: CodexAppServerClient,
): () => boolean {
  const isCurrent = captureSharedClientRegistration(client);
  const revision = client.getModelCatalogRevision();
  return () => isCurrent() && client.getModelCatalogRevision() === revision;
}

/** Registration ends on retirement even when sibling leases keep the process alive. */
export function captureSharedClientRegistration(client: CodexAppServerClient): () => boolean {
  const state = getSharedCodexAppServerClientState();
  const entry = getCurrentSharedClientEntry(client);
  return () =>
    entry !== undefined &&
    state.clients.get(entry.key) === entry &&
    entry.client === client &&
    !entry.closeWhenIdle &&
    !entry.closeError &&
    !client.getCloseError();
}

export function retainSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): (() => void) | undefined {
  const entry = getCurrentSharedClientEntry(client);
  return entry ? retainSharedClientEntry(entry) : undefined;
}

/** Captures physical ownership, independently of unrelated thread and reader leases. */
export function captureCodexAppServerClientLifetime(
  client: CodexAppServerClient,
  requiredOwnership: "connection" | "thread-configuration" | "native-process",
): () => void {
  const state = getSharedCodexAppServerClientState();
  // Manual adoption requires a local process. Ordinary configuration refresh can
  // use any owned connection; its caller separately verifies native thread unload.
  const start = state.startMetadata.get(client)?.startOptions;
  if (
    requiredOwnership === "native-process" &&
    (start?.transport !== "stdio" || isCodexAppServerProxyLaunch(start.args))
  ) {
    throw new AgentHarnessPreflightError(
      "Codex manual thread adoption requires an OpenClaw-managed local stdio process, not an external socket or app-server proxy. No turn was sent; reconnect through managed local stdio before continuing.",
    );
  }
  const isolated = requiredOwnership !== "connection" && state.isolatedClients.has(client);
  const isCurrent = isolated
    ? () => state.isolatedClients.has(client) && !client.getCloseError()
    : captureSharedClientRegistration(client);
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new CodexAdoptedThreadActiveError(
        "Codex app-server connection changed during thread preparation; reconnect before continuing",
      );
    }
  };
  assertCurrent();
  return assertCurrent;
}

export async function clearSharedCodexAppServerClientIfCurrentAndWait(
  client: CodexAppServerClient | undefined,
  options?: Parameters<CodexAppServerClient["closeAndWait"]>[0],
): Promise<boolean> {
  if (!detachCurrentSharedClient(client)) {
    return false;
  }
  await client.closeAndWait(options);
  return true;
}

export async function clearSharedCodexAppServerClientAndWait(
  options?: Parameters<CodexAppServerClient["closeAndWait"]>[0],
): Promise<void> {
  const state = getSharedCodexAppServerClientState();
  const lifetime = state.startup;
  lifetime.controller.abort();
  state.clients.clear();
  const closing = Promise.all(
    [...state.liveClients].map((client) => ownCodexStartup(lifetime, client.closeAndWait(options))),
  );
  void closing.catch(() => undefined);
  // Startup can add a late-registration close after its acquire is aborted.
  // Drain the producers as well as their published transports before reopening admission.
  try {
    while (lifetime.pending.size > 0) {
      await Promise.allSettled(lifetime.pending);
    }
    await closing;
    await nativeHookRelayUnregisterQueue.flush();
  } finally {
    if (state.startup === lifetime) {
      state.startup = createCodexAppServerStartupLifetime();
    }
  }
}

(
  globalThis as typeof globalThis & {
    [SHARED_CODEX_APP_SERVER_CLIENT_DISPOSER]?: () => Promise<void>;
  }
)[SHARED_CODEX_APP_SERVER_CLIENT_DISPOSER] = clearSharedCodexAppServerClientAndWait;

export function clearSharedCodexAppServerClientIfCurrentAndUnclaimed(
  client: CodexAppServerClient | undefined,
): { found: boolean; closed: boolean; activeLeases: number; pendingAcquires: number } {
  const entry = getCurrentSharedClientEntry(client);
  return {
    found: entry !== undefined,
    closed: entry ? closeSharedClientEntryIfUnclaimed(entry) : false,
    activeLeases: entry?.activeLeases ?? 0,
    pendingAcquires: entry?.pendingAcquires ?? 0,
  };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
