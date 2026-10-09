import { createHash } from "node:crypto";
import path from "node:path";
import {
  AgentHarnessPreflightError,
  resolveDefaultAgentDir,
} from "openclaw/plugin-sdk/agent-harness-registration";
import type { AgentHarnessRuntimeArtifactBinding } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { codexBuildSymbol } from "../build-state.js";
import { observeCodexCatalogClient } from "../session-catalog-events.js";
import { CodexAppServerStartupError } from "./attempt-timeouts.js";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerPreparedAuthProfileSnapshot,
  reconcileCodexComputerUseStartArtifacts,
} from "./auth-bridge.js";
import {
  resolveCodexAppServerFallbackApiKeyCacheKey,
  resolveCodexAppServerPreparedApiKeyCacheKey,
} from "./auth-cache-key.js";
import {
  CodexAppServerAuthProfileUnavailableError,
  formatCodexAuthProfileUnavailableMessage,
} from "./auth-profile-recovery.js";
import {
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerAuthProfileStore,
} from "./auth-profile.js";
import { resolveCodexAppServerUserHomeDir } from "./auth-start-options.js";
import type * as codexAuth from "./auth-types.js";
import {
  ensureCodexAppServerClientRuntime,
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
  codexAppServerStartOptionsKey,
  resolveCodexComputerUseConfig,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexAppServerStartOptionsForAgent,
} from "./config-runtime.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";
import {
  isCodexDesktopGenerationCurrent,
  waitForCodexDesktopGeneration,
} from "./desktop-generation.js";
import { ownCodexInferenceClient } from "./inference-routing.js";
import { isCodexAppServerProxyLaunch } from "./launch-args.js";
import {
  isManagedCodexDesktopCommand,
  resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand,
} from "./managed-binary.js";
import { acquireCodexNativeConfigFence } from "./native-config-fence.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { createCodexResponsesOAuth, isCodexResponsesOAuth } from "./responses-oauth.js";
import { codexPrewriteRejectionCause } from "./rpc-error.js";
import {
  notifyDesktopGenerationDrainChecks,
  retainSharedClientEntry,
  releaseSharedClientEntry,
  createCodexAppServerStartupLifetime,
  getCurrentSharedClientEntry,
  getOrCreateSharedClientEntry,
  closeSharedClientEntryIfUnclaimed,
  getSharedCodexAppServerClientState,
  observeAcquire,
  observeSharedClientAcquire,
  recordSharedClientAcquireBoundary,
  ownCodexStartup,
  retireSharedCodexAppServerClientIfCurrent,
  retirePendingSharedClientEntryIfUnclaimed,
  waitForUnclaimedSharedClientStartup,
  type CodexAppServerAcquireObservation,
  type CodexAppServerStartupLifetime,
  type SharedCodexAppServerClientEntry,
  type SharedCodexAppServerClientStartup,
  type SharedCodexAppServerClientState,
} from "./shared-client-lifecycle.js";
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
  };

const CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE = "codex app-server initialize timed out";

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
    ownCodexStartup(lifetime, resolveCodexAppServerClientStartContext(options)),
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

/** Waits until older physical desktop clients for this client's Codex home exit. */
export async function waitForCodexAppServerClientDesktopGenerationDrain(params: {
  client: CodexAppServerClient;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  const metadata = getSharedCodexAppServerClientState().startMetadata.get(params.client);
  if (!metadata?.desktopGeneration) {
    return;
  }
  const drain = createOlderDesktopGenerationDrainWait({
    generation: metadata.desktopGeneration,
    startOptions: metadata.startOptions,
    agentDir: metadata.agentDir,
  });
  try {
    await withCodexAppServerAcquireDeadline(
      params.timeoutMs ?? 0,
      drain.promise,
      params.signal,
      "Codex Computer Use install timed out waiting for older desktop clients",
    );
  } finally {
    drain.cancel();
  }
}

class CodexAppServerStartSelectionChangedError extends Error {
  readonly code = "CODEX_APP_SERVER_START_SELECTION_CHANGED";

  constructor() {
    super("Codex app-server managed executable selection changed during startup");
    this.name = "CodexAppServerStartSelectionChangedError";
  }
}

/** Cross-bundle-safe check for a managed executable selection retry. */
export function isCodexAppServerStartSelectionChangedError(error: unknown): boolean {
  const cause = codexPrewriteRejectionCause(error);
  return (
    cause instanceof Error &&
    "code" in cause &&
    cause.code === "CODEX_APP_SERVER_START_SELECTION_CHANGED"
  );
}

/**
 * Rechecks mutable Codex-owned plugin state immediately before thread start/resume.
 * The synchronous check prevents another gateway task from installing Computer
 * Use between the check and the JSON-RPC write on the same event loop turn.
 */
export function assertCodexAppServerClientStartSelectionCurrent(params: {
  client: CodexAppServerClient;
  startOptions?: CodexAppServerStartOptions;
  agentDir?: string;
}): void {
  const metadata = getSharedCodexAppServerClientState().startMetadata.get(params.client);
  if (!metadata) {
    return;
  }
  if (metadata.desktopGeneration && !isCodexDesktopGenerationCurrent(metadata.desktopGeneration)) {
    throw new CodexAppServerStartSelectionChangedError();
  }
  const requestedStartOptions = params.startOptions ?? metadata.requestedStartOptions;
  if (requestedStartOptions.commandSource !== "managed") {
    return;
  }
  const current = resolveCodexAppServerStartOptionsForAgent({
    startOptions: requestedStartOptions,
    agentDir: params.agentDir ?? metadata.agentDir,
  });
  const actualOrder = metadata.startOptions.managedCommandOrder ?? "package-first";
  const currentOrder = current.managedCommandOrder ?? "package-first";
  if (actualOrder !== currentOrder) {
    throw new CodexAppServerStartSelectionChangedError();
  }
}

export function resolveCodexNativeConfigFenceKey(params: {
  client?: CodexAppServerClient;
  startOptions?: CodexAppServerStartOptions;
  agentDir?: string;
  config?: CodexAppServerClientOptions["config"];
}): string | undefined {
  const metadata = params.client
    ? getSharedCodexAppServerClientState().startMetadata.get(params.client)
    : undefined;
  const startOptions = metadata?.startOptions ?? params.startOptions;
  if (!startOptions || startOptions.transport !== "stdio") {
    return undefined;
  }
  const configuredHome = startOptions.codexHome ?? startOptions.env?.CODEX_HOME?.trim();
  const codexHome = configuredHome
    ? configuredHome
    : startOptions.homeScope === "user"
      ? resolveCodexAppServerUserHomeDir()
      : resolveCodexAppServerHomeDir(
          params.agentDir ?? metadata?.agentDir ?? resolveDefaultAgentDir(params.config ?? {}),
        );
  return codexHome ? `codex-home:${path.resolve(codexHome)}` : undefined;
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

async function resolveCodexAppServerClientStartContext(options?: CodexAppServerClientOptions) {
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
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(agentStartOptions);
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

function shouldTrackDesktopGeneration(
  startOptions: CodexAppServerStartOptions,
  pluginConfig: unknown,
): boolean {
  if (startOptions.transport !== "stdio") {
    return false;
  }
  // A managed package process can publish desktop-owned Computer Use artifacts,
  // so both share one generation. Custom operator commands remain independent.
  if (
    resolveCodexComputerUseConfig({ pluginConfig }).enabled &&
    (startOptions.commandSource === "managed" || startOptions.commandSource === "resolved-managed")
  ) {
    return true;
  }
  return (
    startOptions.commandSource === "managed" &&
    (startOptions.managedCommandOrder ?? "package-first") === "desktop-first"
  );
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

/** Retries one config-loading operation with a shared deadline and current client lease. */
export async function withLeasedCodexAppServerClientStartSelectionRetry<T>(params: {
  lease: CodexAppServerClientLease;
  options?: CodexAppServerClientOptions;
  signal?: AbortSignal;
  run: (
    client: CodexAppServerClient,
    requestOptions: () => CodexAppServerLeasedRequestOptions,
  ) => Promise<T>;
  onClientChange?: (client: CodexAppServerClient) => void;
}): Promise<T> {
  let client = params.lease.client;
  if (!client) {
    throw new Error("Codex app-server selection retry requires an active client lease");
  }
  const timeoutMs = params.options?.timeoutMs ?? 60_000;
  const deadline = performance.now() + timeoutMs;
  const signal = params.signal ?? params.options?.abandonSignal;
  const requestOptions = () => {
    if (signal?.aborted) {
      throw new CodexAppServerStartupError("aborted", "Codex app-server selection retry aborted");
    }
    const remainingTimeoutMs = deadline - performance.now();
    if (remainingTimeoutMs <= 0) {
      throw new CodexAppServerStartupError(
        "timed_out",
        "Codex app-server selection retry timed out",
      );
    }
    return {
      timeoutMs: remainingTimeoutMs,
      ...(signal ? { signal } : {}),
    };
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptClient = client;
    let scopeActive = true;
    const assertCurrent = () => {
      if (!scopeActive || params.lease.client !== attemptClient) {
        throw new CodexAppServerStartupError("aborted", "Codex app-server request scope is closed");
      }
    };
    try {
      requestOptions();
      return await params.run(client, () => {
        assertCurrent();
        // Sample the deadline before each request or commit. Cleanup keeps the
        // lease-only assertion so an accepted native operation can finish safely.
        return { ...requestOptions(), assertCurrent };
      });
    } catch (error) {
      if (!isCodexAppServerStartSelectionChangedError(error) || attempt > 0) {
        throw error;
      }
      // Existing loaded threads can drain safely; only future acquisitions must
      // move to the newly selected desktop-first owner.
      retireSharedCodexAppServerClientIfCurrent(client);
      params.lease.client = undefined;
      if (!releaseLeasedSharedCodexAppServerClient(client)) {
        client.close();
        throw new Error("Codex app-server selection retry requires a leased shared client", {
          cause: error,
        });
      }
      const replacementOptions = requestOptions();
      client = await getLeasedSharedCodexAppServerClient({
        ...params.options,
        timeoutMs: replacementOptions.timeoutMs,
        ...(signal ? { abandonSignal: signal } : {}),
      });
      params.lease.client = client;
      params.onClientChange?.(client);
    } finally {
      scopeActive = false;
    }
  }
  throw new Error("Codex app-server selection retry loop exited unexpectedly");
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
  const authIdentityCacheKey =
    preparedAuth?.kind === "api-key"
      ? resolveCodexAppServerPreparedApiKeyCacheKey(preparedAuth.apiKey)
      : (preparedAuth?.snapshot.secretFreeCacheKey ??
        (authRequirement === "api-key" && !authProfileId
          ? resolveCodexAppServerFallbackApiKeyCacheKey({ startOptions })
          : undefined));
  const baseKey = `${codexAppServerStartOptionsKey(startOptions, {
    authProfileId,
    authBindingFingerprint: options?.authBindingFingerprint,
    agentDir: usesNativeAuth ? undefined : agentDir,
    fallbackApiKeyCacheKey: authIdentityCacheKey,
  })}\0auth-requirement:${authRequirement ?? "native"}${
    desktopGeneration ? `\0desktop-generation:${desktopGeneration.epoch}` : ""
  }`;
  // Capture turns cannot inherit a normal client whose loaded bytes predate the
  // filesystem snapshot. Keep their physical process generation separate.
  const runtimeArtifactMode =
    options?.runtimeArtifactMode ?? (options?.expectedRuntimeArtifact ? "capture" : undefined);
  const expectedRuntimeArtifactKey = options?.expectedRuntimeArtifact
    ? createHash("sha256")
        .update(options.expectedRuntimeArtifact.id)
        .update("\0")
        .update(options.expectedRuntimeArtifact.fingerprint)
        .digest("hex")
    : "mint";
  const key = runtimeArtifactMode
    ? `${baseKey}\0runtime-artifact:capture-v1:${expectedRuntimeArtifactKey}`
    : baseKey;
  let entry = getOrCreateSharedClientEntry(state, key);
  const existingClient = entry.client;
  const existingGeneration = existingClient
    ? state.startMetadata.get(existingClient)?.desktopGeneration
    : undefined;
  if (
    existingClient &&
    existingGeneration &&
    !isCodexDesktopGenerationCurrent(existingGeneration)
  ) {
    retireSharedCodexAppServerClientIfCurrent(existingClient);
    entry = getOrCreateSharedClientEntry(state, key);
  }
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
    throw error;
  } finally {
    cleanupAbandonSignal?.();
    stopStartedClientNotifications();
    releasePendingAcquire();
  }
}

function buildCodexAppServerInitializeTimeoutError(
  client: CodexAppServerClient | undefined,
): CodexAppServerStartupError {
  const stderr = client?.getStderrDiagnostic();
  return new CodexAppServerStartupError(
    "timed_out",
    stderr
      ? `${CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE}; stderr=${JSON.stringify(stderr)}`
      : CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE,
  );
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
          notifyDesktopGenerationDrainChecks(state);
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
        // Unsupported managed candidates close before fallback starts. Only the
        // ready client's closure may remove the shared acquisition entry.
        client.addCloseHandler((closedClient) => {
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
          notifyDesktopGenerationDrainChecks(state);
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
  ) => {
    if (abandonSignal.aborted) {
      throw new CodexAppServerStartupError("aborted", "codex app-server initialize aborted");
    }
    return withCodexAppServerAcquireDeadline(
      resolveRemainingAcquireTimeout(timeoutMs, acquireStartedAt),
      ownCodexStartup(params.lifetime, operation()),
      abandonSignal,
      CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MESSAGE,
      timeoutErrorFactory,
    );
  };
  const startOptionsCandidates = resolveManagedFallbackStartOptions(params.startOptions);
  for (const [index, startOptions] of startOptionsCandidates.entries()) {
    params.assertCurrent?.();
    observeAcquire(params, { boundary: "prestart-artifact-drain" });
    const desktopCommand = isManagedCodexDesktopCommand(startOptions.command);
    const desktopGeneration =
      params.desktopGeneration ??
      (desktopCommand ? await waitForStartup(waitForCodexDesktopGeneration) : undefined);
    const assertStartupCurrent = () => {
      params.assertCurrent?.();
      if (abandonSignal.aborted) {
        throw new CodexAppServerStartupError("aborted", "codex app-server initialize aborted");
      }
      if (desktopGeneration && !isCodexDesktopGenerationCurrent(desktopGeneration)) {
        throw new CodexAppServerStartSelectionChangedError();
      }
    };
    const computerUseConfig = resolveCodexComputerUseConfig({ pluginConfig: params.pluginConfig });
    const ownsIsolatedCodexHome =
      params.requestedStartOptions.homeScope !== "user" &&
      !params.requestedStartOptions.env?.CODEX_HOME?.trim();
    const needsComputerUseArtifactDrain =
      desktopGeneration &&
      ownsIsolatedCodexHome &&
      computerUseConfig.enabled &&
      (computerUseConfig.autoInstall || computerUseConfig.pluginCacheMode === "shared");
    const artifactDrain = needsComputerUseArtifactDrain
      ? createOlderDesktopGenerationDrainWait({
          generation: desktopGeneration,
          startOptions,
          agentDir: params.agentDir,
        })
      : undefined;
    try {
      if (artifactDrain) {
        // These artifacts have stable paths per CODEX_HOME. Publish Y only after
        // every X claimant has stopped reading X, or an active turn can mix both.
        await waitForStartup(() => artifactDrain.promise);
      }
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
    } finally {
      artifactDrain?.cancel();
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
        );
      } catch (error) {
        if (
          startOptions.commandSource === "resolved-managed" &&
          index < startOptionsCandidates.length - 1 &&
          isUnsupportedCodexAppServerVersionError(error)
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
      ensureCodexAppServerClientRuntime(client, {
        agentDir: params.agentDir,
        authProfileId: params.authProfileId ?? undefined,
        authMode:
          params.preparedAuth?.kind === "api-key" || isCodexResponsesOAuth(params.preparedAuth)
            ? "prepared-api-key"
            : "profile",
        ...(params.authProfileStore ? { authProfileStore: params.authProfileStore } : {}),
        config: params.config,
        onAuthRefreshFailure: () => retireSharedCodexAppServerClientIfCurrent(client),
      });

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
      const fenceKey = resolveCodexNativeConfigFenceKey({ client });
      if (fenceKey) {
        client.setThreadSessionRequestGuard(
          async (options) => {
            const release = await acquireCodexNativeConfigFence(fenceKey, options);
            try {
              assertCodexAppServerClientStartSelectionCurrent({ client });
              return release;
            } catch (error) {
              release();
              throw error;
            }
          },
          () => Boolean(retireSharedCodexAppServerClientIfCurrent(client)),
        );
      }
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

function isCodexComputerUseCandidateArtifactsUnavailableError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "CODEX_COMPUTER_USE_CANDIDATE_ARTIFACTS_UNAVAILABLE"
  );
}

function resolveManagedFallbackStartOptions(
  startOptions: CodexAppServerStartOptions,
): CodexAppServerStartOptions[] {
  const commands = [startOptions.command, ...(startOptions.managedFallbackCommandPaths ?? [])];
  const candidates: CodexAppServerStartOptions[] = [];
  for (const [index, command] of commands.entries()) {
    const managedFallbackCommandPaths = commands.slice(index + 1);
    const candidate = {
      ...startOptions,
      command,
    };
    if (managedFallbackCommandPaths.length === 0) {
      delete candidate.managedFallbackCommandPaths;
    } else {
      candidate.managedFallbackCommandPaths = managedFallbackCommandPaths;
    }
    candidates.push(candidate);
  }
  return candidates;
}

function detachCurrentSharedClient(
  client: CodexAppServerClient | undefined,
): client is CodexAppServerClient {
  const entry = client && getCurrentSharedClientEntry(client);
  return Boolean(entry && getSharedCodexAppServerClientState().clients.delete(entry.key));
}

export function clearSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): boolean {
  if (!detachCurrentSharedClient(client)) {
    return false;
  }
  client.close();
  return true;
}

/** Captures a revocable observation of the exact shared client and native account/config. */
export function captureSharedCodexAppServerCatalogLifetime(
  client: CodexAppServerClient,
): () => boolean {
  const isCurrent = captureSharedClientRegistration(client);
  const revision = client.getModelCatalogRevision();
  return () => isCurrent() && client.getModelCatalogRevision() === revision;
}

/** Registration ends on retirement even when sibling leases keep the process alive. */
function captureSharedClientRegistration(client: CodexAppServerClient): () => boolean {
  const state = getSharedCodexAppServerClientState();
  const entry = getCurrentSharedClientEntry(client);
  const generation = readCodexAppServerClientDesktopGeneration(client);
  return () =>
    entry !== undefined &&
    state.clients.get(entry.key) === entry &&
    entry.client === client &&
    !entry.closeWhenIdle &&
    !entry.closeError &&
    !client.getCloseError() &&
    (!generation || isCodexDesktopGenerationCurrent(generation));
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
    assertCodexAppServerClientStartSelectionCurrent({ client });
  };
  assertCurrent();
  return assertCurrent;
}

function createOlderDesktopGenerationDrainWait(params: {
  generation: CodexDesktopGeneration;
  startOptions: CodexAppServerStartOptions;
  agentDir?: string;
}): { promise: Promise<void>; cancel: () => void } {
  const targetHome = resolveCodexNativeConfigFenceKey({
    startOptions: params.startOptions,
    agentDir: params.agentDir,
  });
  if (!targetHome) {
    return { promise: Promise.resolve(), cancel: () => undefined };
  }
  const state = getSharedCodexAppServerClientState();
  const { promise, resolve: resolveWait } = createDeferred<void>();
  const cancel = () => {
    state.desktopGenerationDrainChecks.delete(check);
    resolveWait();
  };
  const check = () => {
    if (
      !hasLiveOlderDesktopGenerationClient({
        state,
        generation: params.generation,
        targetHome,
      })
    ) {
      cancel();
    }
  };
  state.desktopGenerationDrainChecks.add(check);
  check();
  return { promise, cancel };
}

function hasLiveOlderDesktopGenerationClient(params: {
  state: SharedCodexAppServerClientState;
  generation: CodexDesktopGeneration;
  targetHome: string;
}): boolean {
  for (const clients of [params.state.liveClients, params.state.isolatedClients]) {
    for (const client of clients) {
      const metadata = params.state.startMetadata.get(client);
      if (
        metadata?.desktopGeneration &&
        metadata.desktopGeneration.epoch < params.generation.epoch &&
        resolveCodexNativeConfigFenceKey({ client }) === params.targetHome
      ) {
        return true;
      }
    }
  }
  return false;
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
