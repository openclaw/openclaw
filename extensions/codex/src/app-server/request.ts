/**
 * Sends typed JSON-RPC requests to the Codex app-server with sandbox guard
 * checks, shared-client leasing, and isolated-client shutdown handling.
 */
import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { prepareCodexAppServerAuthBinding } from "./auth-binding.js";
import {
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileStore,
  resolveCodexAppServerPreparedAuthHandoff,
  type resolveCodexAppServerAuthProfileIdForAgent,
} from "./auth-bridge.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import type {
  CodexAppServerRequestMethod,
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  JsonValue,
} from "./protocol.js";
import { readRecentCodexRateLimits, rememberCodexRateLimitsRead } from "./rate-limit-cache.js";
import { resolveCodexAppServerDirectSandboxBypassBlock } from "./sandbox-guard.js";
import {
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
  isCodexAppServerStartSelectionChangedError,
  releaseLeasedSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
  type CodexAppServerClientOptions,
} from "./shared-client.js";
import { withTimeout } from "./timeout.js";

type CodexAppServerClientRequestParams = {
  client: CodexAppServerClient;
  method: string;
  requestParams?: unknown;
  timeoutMs?: number;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sessionKey?: string;
  sessionId?: string;
};

type CodexAppServerJsonRequestParams = {
  method: string;
  requestParams?: unknown;
  timeoutMs?: number;
  pluginConfig?: unknown;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sessionKey?: string;
  sessionId?: string;
  isolated?: boolean;
};

type CodexAppServerJsonClientParams = Omit<
  CodexAppServerJsonRequestParams,
  "method" | "requestParams"
> & {
  timeoutMessage?: string;
  // Tight callers can cap isolated cleanup so it cannot consume their result deadline.
  isolatedShutdown?: { exitTimeoutMs?: number; forceKillDelayMs?: number };
};

type CodexAppServerJsonInternalClientParams = CodexAppServerJsonClientParams & {
  sharedClientAuth?: Pick<CodexAppServerClientOptions, "authBindingFingerprint" | "preparedAuth">;
};

type CodexAppServerRateLimitsParams = {
  timeoutMs?: number;
  timeoutMessage?: string;
  pluginConfig?: unknown;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentDir?: string;
  config?: CodexAppServerJsonRequestParams["config"];
};

/** Sends one guarded request over a client lease owned by the caller. */
export async function requestCodexAppServerClientJson<T = JsonValue | undefined>(
  params: CodexAppServerClientRequestParams,
): Promise<T> {
  const sandboxBlock = resolveCodexAppServerDirectSandboxBypassBlock({
    method: params.method,
    requestParams: params.requestParams,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  });
  if (sandboxBlock) {
    throw new Error(sandboxBlock);
  }
  const timeoutMs = params.timeoutMs ?? 60_000;
  return await withTimeout(
    params.client.request<T>(params.method, params.requestParams, { timeoutMs }),
    timeoutMs,
    `codex app-server ${params.method} timed out`,
  );
}

/** Sends a typed Codex app-server request and returns the method-specific response shape. */
export async function requestCodexAppServerJson<M extends CodexAppServerRequestMethod>(params: {
  method: M;
  requestParams: CodexAppServerRequestParams<M>;
  timeoutMs?: number;
  pluginConfig?: unknown;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sessionKey?: string;
  sessionId?: string;
  isolated?: boolean;
}): Promise<CodexAppServerRequestResult<M>>;
export async function requestCodexAppServerJson<T = JsonValue | undefined>(params: {
  method: string;
  requestParams?: unknown;
  timeoutMs?: number;
  pluginConfig?: unknown;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sessionKey?: string;
  sessionId?: string;
  isolated?: boolean;
}): Promise<T>;
export async function requestCodexAppServerJson<T = JsonValue | undefined>(
  params: CodexAppServerJsonRequestParams,
): Promise<T> {
  // Fail closed before spawning or leasing a client for a guard-blocked method.
  const sandboxBlock = resolveCodexAppServerDirectSandboxBypassBlock({
    method: params.method,
    requestParams: params.requestParams,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  });
  if (sandboxBlock) {
    throw new Error(sandboxBlock);
  }
  return await withCodexAppServerJsonClient(
    { ...params, timeoutMessage: `codex app-server ${params.method} timed out` },
    async (request) =>
      await request<T>({ method: params.method, requestParams: params.requestParams }),
  );
}

type CodexAppServerScopedRequest = <T = JsonValue | undefined>(request: {
  method: string;
  requestParams?: unknown;
}) => Promise<T>;

type CodexAppServerRateLimitsClientContext = {
  rateLimits: JsonValue | undefined;
  request: CodexAppServerScopedRequest;
};

/**
 * Runs several guarded requests over one acquired client (shared lease or
 * isolated child) so related reads see the same app-server session. The whole
 * callback re-runs once when the client's start selection changed underneath it.
 */
export async function withCodexAppServerJsonClient<T>(
  params: CodexAppServerJsonClientParams,
  run: (request: CodexAppServerScopedRequest) => Promise<T>,
): Promise<T> {
  return await withCodexAppServerJsonClientInternal(params, async ({ request }) => run(request));
}

/** Reads rate limits through the session-scoped shared client with a recent-cache fallback. */
export async function requestCodexAppServerRateLimits(
  params: CodexAppServerRateLimitsParams,
): Promise<JsonValue | undefined> {
  return await withCodexAppServerRateLimitsClient(params, async ({ rateLimits }) => rateLimits);
}

/** Runs follow-up reads on the same authenticated client that owns the rate-limit snapshot. */
export async function withCodexAppServerRateLimitsClient<T>(
  params: CodexAppServerRateLimitsParams,
  run: (context: CodexAppServerRateLimitsClientContext) => Promise<T>,
): Promise<T> {
  const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.config ?? {});
  const sharedClientAuth = await resolveCodexRateLimitsSharedClientAuth({ ...params, agentDir });
  return await withCodexAppServerJsonClientInternal(
    {
      ...params,
      agentDir,
      timeoutMessage: params.timeoutMessage ?? "codex app-server account/rateLimits/read timed out",
      isolated: false,
      ...(sharedClientAuth ? { sharedClientAuth } : {}),
    },
    async ({ client, request }) => {
      let rateLimits: JsonValue | undefined;
      try {
        rateLimits = await request<JsonValue | undefined>({ method: "account/rateLimits/read" });
        rememberCodexRateLimitsRead(client, rateLimits);
      } catch (error) {
        if (isCodexAppServerStartSelectionChangedError(error)) {
          throw error;
        }
        // Shared-client identity includes agent/auth selection. Falling back on
        // this exact physical client prevents quota from crossing accounts.
        const cachedRateLimits = readRecentCodexRateLimits(client);
        if (cachedRateLimits === undefined) {
          throw error;
        }
        rateLimits = cachedRateLimits;
      }
      return await run({ rateLimits, request });
    },
  );
}

async function resolveCodexRateLimitsSharedClientAuth(params: {
  authProfileId?: string | null;
  agentDir: string;
  config?: CodexAppServerJsonRequestParams["config"];
  startOptions?: CodexAppServerStartOptions;
}): Promise<
  Pick<CodexAppServerClientOptions, "authBindingFingerprint" | "preparedAuth"> | undefined
> {
  if (params.authProfileId === null || params.startOptions?.homeScope === "user") {
    return undefined;
  }
  const authProfileStore = resolveCodexAppServerAuthProfileStore({
    authProfileId: params.authProfileId,
    agentDir: params.agentDir,
    config: params.config,
  });
  const authProfileId = resolveCodexAppServerAuthProfileId({
    authProfileId: params.authProfileId,
    store: authProfileStore,
    config: params.config,
  });
  if (!authProfileId) {
    return undefined;
  }
  // Status must reproduce the turn's prepared-auth key. A legacy profile-only
  // acquisition would start a second client and miss the active client's cache.
  const authHandoff = await resolveCodexAppServerPreparedAuthHandoff({
    authRequirement: "subscription",
    authProfileId,
    authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
    subscriptionProfileRequiredError: "Codex usage requires an OpenAI OAuth or token profile.",
    subscriptionProfileUnusableError: `Codex usage auth profile "${authProfileId}" is unusable.`,
  });
  if (!authHandoff.preparedAuth) {
    return undefined;
  }
  const authBinding = await prepareCodexAppServerAuthBinding({
    authProfileId,
    authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  return {
    preparedAuth: authHandoff.preparedAuth,
    ...(authBinding ? { authBindingFingerprint: authBinding.fingerprint } : {}),
  };
}

async function withCodexAppServerJsonClientInternal<T>(
  params: CodexAppServerJsonInternalClientParams,
  run: (context: {
    client: CodexAppServerClient;
    request: CodexAppServerScopedRequest;
  }) => Promise<T>,
): Promise<T> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const timeoutMessage = params.timeoutMessage ?? "codex app-server request timed out";
  const timeoutController = new AbortController();
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
  const isPastDeadline = () => deadline !== undefined && Date.now() >= deadline;
  const throwIfAbandoned = () => {
    if (timeoutController.signal.aborted || isPastDeadline()) {
      throw new Error(timeoutMessage);
    }
  };
  const remainingTimeoutMs = () => {
    throwIfAbandoned();
    return deadline === undefined ? timeoutMs : Math.max(1, deadline - Date.now());
  };

  try {
    return await withTimeout(
      (async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          throwIfAbandoned();
          const acquireClient = params.isolated
            ? createIsolatedCodexAppServerClient
            : getLeasedSharedCodexAppServerClient;
          const client = await acquireClient({
            startOptions: params.startOptions,
            pluginConfig: params.pluginConfig,
            timeoutMs: remainingTimeoutMs(),
            ...params.sharedClientAuth,
            ...(!params.sharedClientAuth?.preparedAuth && {
              authProfileId: params.authProfileId,
            }),
            agentDir: params.agentDir,
            config: params.config,
            abandonSignal: timeoutController.signal,
          });
          try {
            throwIfAbandoned();
            const scopedRequest: CodexAppServerScopedRequest = async <R>(request: {
              method: string;
              requestParams?: unknown;
            }) => {
              const sandboxBlock = resolveCodexAppServerDirectSandboxBypassBlock({
                method: request.method,
                requestParams: request.requestParams,
                config: params.config,
                sessionKey: params.sessionKey,
                sessionId: params.sessionId,
              });
              if (sandboxBlock) {
                throw new Error(sandboxBlock);
              }
              throwIfAbandoned();
              return await client.request<R>(request.method, request.requestParams, {
                timeoutMs: remainingTimeoutMs(),
                signal: timeoutController.signal,
              });
            };
            return await run({ client, request: scopedRequest });
          } catch (error) {
            if (!isCodexAppServerStartSelectionChangedError(error) || attempt > 0) {
              throw error;
            }
            if (!params.isolated) {
              retireSharedCodexAppServerClientIfCurrent(client);
            }
            throwIfAbandoned();
          } finally {
            if (params.isolated) {
              // Wait for the child to actually exit (with a SIGKILL fallback) so
              // the parent process doesn't hang on an orphaned codex app-server.
              // The stdio bin shim does not always propagate stdin EOF to the
              // underlying codex binary, so the unref'd close() path can leave
              // the child running and keep the parent's event loop alive.
              await client.closeAndWait({
                exitTimeoutMs: params.isolatedShutdown?.exitTimeoutMs ?? 2_000,
                forceKillDelayMs: params.isolatedShutdown?.forceKillDelayMs ?? 250,
              });
            } else {
              releaseLeasedSharedCodexAppServerClient(client);
            }
          }
        }
        throw new Error("Codex app-server selection retry loop exited unexpectedly");
      })(),
      timeoutMs,
      timeoutMessage,
    );
  } catch (error) {
    if (isPastDeadline()) {
      throw new Error(timeoutMessage, { cause: error });
    }
    throw error;
  } finally {
    // `withTimeout` only stops awaiting. Abort the shared operation before its
    // timeout becomes observable so no delayed acquire can issue a request or retry.
    timeoutController.abort();
  }
}
