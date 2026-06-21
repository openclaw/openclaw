import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  CodexAppServerUnsafeSubscriptionError,
  settleCodexAppServerClientLease,
} from "./attempt-client-cleanup.js";
/**
 * Sends typed JSON-RPC requests to the Codex app-server with sandbox guard
 * checks, shared-client leasing, and isolated-client shutdown handling.
 */
import type { resolveCodexAppServerAuthProfileIdForAgent } from "./auth-bridge.js";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  isJsonObject,
  readCodexThreadCreationResponseId,
  type CodexAppServerRequestMethod,
  type CodexAppServerRequestParams,
  type CodexAppServerRequestResult,
  type CodexThreadResumeParams,
  type JsonValue,
} from "./protocol.js";
import { rememberCodexRateLimitsRead } from "./rate-limit-cache.js";
import { resolveCodexAppServerDirectSandboxBypassBlock } from "./sandbox-guard.js";
import {
  createIsolatedCodexAppServerClient,
  leaseSharedCodexAppServerClient,
} from "./shared-client.js";
import { resumeCodexAppServerThread } from "./thread-resume.js";
import { withTimeout } from "./timeout.js";

/** Sends a typed Codex app-server request and returns the method-specific response shape. */
export async function requestCodexAppServerJson<M extends CodexAppServerRequestMethod>(params: {
  method: M;
  requestParams: CodexAppServerRequestParams<M>;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentId?: string;
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
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentId?: string;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sessionKey?: string;
  sessionId?: string;
  isolated?: boolean;
}): Promise<T>;
export async function requestCodexAppServerJson<T = JsonValue | undefined>(params: {
  method: string;
  requestParams?: unknown;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentId?: string;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sessionKey?: string;
  sessionId?: string;
  isolated?: boolean;
}): Promise<T> {
  const sandboxBlock = resolveCodexAppServerDirectSandboxBypassBlock({
    method: params.method,
    requestParams: params.requestParams,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  });
  if (sandboxBlock) {
    throw new Error(sandboxBlock);
  }
  const timeoutMs = params.timeoutMs ?? 60_000;
  const timeoutMessage = `codex app-server ${params.method} timed out`;
  const abortController = new AbortController();
  const operation = (async () => {
    const startedAt = Date.now();
    const clientOptions = {
      startOptions: params.startOptions,
      timeoutMs,
      authProfileId: params.authProfileId,
      agentDir: params.agentDir,
      config: params.config,
      abandonSignal: abortController.signal,
    };
    const clientLease = params.isolated
      ? undefined
      : await leaseSharedCodexAppServerClient(clientOptions);
    const client = clientLease?.client ?? (await createIsolatedCodexAppServerClient(clientOptions));
    const requestedThreadId =
      params.method === "thread/resume" && isJsonObject(params.requestParams)
        ? typeof params.requestParams.threadId === "string"
          ? params.requestParams.threadId
          : undefined
        : undefined;
    let subscribedThreadId: string | undefined;
    let abandonClient = false;
    try {
      abortController.signal.throwIfAborted();
      const requestTimeoutMs = remainingRequestTimeoutMs(startedAt, timeoutMs, params.method);
      let response: T;
      if (params.method === "thread/resume" && requestedThreadId) {
        subscribedThreadId = requestedThreadId;
        response = (await resumeCodexAppServerThread({
          client,
          abandonClient: clientLease
            ? clientLease.abandon
            : async () =>
                await client.closeAndWait({ exitTimeoutMs: 2_000, forceKillDelayMs: 250 }),
          request: params.requestParams as CodexThreadResumeParams,
          timeoutMs: requestTimeoutMs,
          signal: abortController.signal,
        })) as T;
      } else {
        response = await client.request<T>(params.method, params.requestParams, {
          timeoutMs: requestTimeoutMs,
          signal: abortController.signal,
        });
      }
      if (params.method === "account/rateLimits/read") {
        rememberCodexRateLimitsRead(client, response as JsonValue | undefined);
      }
      if (isThreadSubscriptionMethod(params.method)) {
        const returnedThreadId = readCodexThreadCreationResponseId(response);
        if (!returnedThreadId) {
          abandonClient = true;
          throw new CodexAppServerUnsafeSubscriptionError(
            `Codex ${params.method} response omitted its thread id`,
          );
        }
        if (params.method === "thread/resume") {
          if (!requestedThreadId) {
            abandonClient = true;
            throw new CodexAppServerUnsafeSubscriptionError(
              "Codex thread/resume succeeded without a requested thread id",
            );
          }
        } else {
          subscribedThreadId = returnedThreadId;
        }
      }
      return response;
    } catch (error) {
      abandonClient ||= error instanceof CodexAppServerUnsafeSubscriptionError;
      throw error;
    } finally {
      if (params.isolated) {
        // Cleanup may outlive the caller's end-to-end deadline, but the outer
        // timeout aborts all work and returns without orphaning the child.
        await client.closeAndWait({ exitTimeoutMs: 2_000, forceKillDelayMs: 250 });
      } else if (clientLease) {
        await settleCodexAppServerClientLease(clientLease, {
          threadId: subscribedThreadId,
          timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
          abandon: abandonClient,
        });
      }
    }
  })();
  try {
    return await withTimeout(operation, timeoutMs, timeoutMessage);
  } catch (error) {
    abortController.abort(error);
    void operation.catch(() => undefined);
    throw error;
  }
}

function remainingRequestTimeoutMs(startedAt: number, timeoutMs: number, method: string): number {
  if (timeoutMs <= 0) {
    return timeoutMs;
  }
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) {
    throw new Error(`codex app-server ${method} timed out`);
  }
  return Math.max(1, remaining);
}

function isThreadSubscriptionMethod(method: string): boolean {
  return method === "thread/start" || method === "thread/fork" || method === "thread/resume";
}
