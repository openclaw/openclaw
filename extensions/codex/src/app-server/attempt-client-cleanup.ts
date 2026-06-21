/**
 * Best-effort cleanup helpers for Codex app-server startup attempts and turns.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./client.js";
import { isJsonObject, readCodexThreadCreationResponseId } from "./protocol.js";
import type { CodexAppServerClientLease } from "./shared-client.js";

/** Timeout for best-effort app-server turn interruption during cleanup. */
export const CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS = 5_000;
/** Timeout for best-effort thread unsubscribe during cleanup. */
export const CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS = 5_000;

/** The connection's thread-subscription ownership can no longer be proven. */
export class CodexAppServerUnsafeSubscriptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAppServerUnsafeSubscriptionError";
  }
}

export function isCodexAppServerUnsafeSubscriptionError(
  error: unknown,
): error is CodexAppServerUnsafeSubscriptionError {
  return error instanceof CodexAppServerUnsafeSubscriptionError;
}

/** A resume response may only describe the thread this connection retained. */
export function assertCodexThreadResumeSubscription(
  requestedThreadId: string,
  returnedThreadId: string,
): void {
  if (returnedThreadId !== requestedThreadId) {
    throw new CodexAppServerUnsafeSubscriptionError(
      `Codex thread/resume returned ${returnedThreadId} for ${requestedThreadId}`,
    );
  }
}

/** Retires the exact client lease when turn acceptance is ambiguous. */
export async function runCodexTurnStartWithLease<T>(
  lease: CodexAppServerClientLease,
  startTurn: () => Promise<T>,
): Promise<T> {
  try {
    return await startTurn();
  } catch (error) {
    // Structured RPC rejection happens before Codex accepts the turn. Transport,
    // timeout, and abort failures may hide an accepted turn with an unknown id.
    if (!(error instanceof CodexAppServerRpcError)) {
      await lease.abandon();
    }
    throw error;
  }
}

/** Retries once when native work wins the race immediately before turn/start. */
export async function runCodexTurnStartWithNativeTurnRetry<T>(params: {
  startTurn: () => Promise<T>;
  waitForActiveTurnCompletion: () => Promise<boolean>;
  afterActiveTurnCompletion?: () => Promise<void>;
  onRetry?: () => void;
}): Promise<T> {
  try {
    return await params.startTurn();
  } catch (error) {
    if (!isCodexActiveTurnNotSteerableError(error)) {
      throw error;
    }
    params.onRetry?.();
    if (!(await params.waitForActiveTurnCompletion())) {
      throw error;
    }
    await params.afterActiveTurnCompletion?.();
    return await params.startTurn();
  }
}

/** True for Codex's structured rejection when native work already owns the thread. */
export function isCodexActiveTurnNotSteerableError(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRpcError) || !isJsonObject(error.data)) {
    return false;
  }
  const info = error.data.codexErrorInfo;
  return isJsonObject(info) && isJsonObject(info.activeTurnNotSteerable);
}

/** Validates a create response and retires the client unless cleanup is confirmed. */
export async function validateCodexThreadCreationResponse<T>(
  owner: {
    client: CodexAppServerClient;
    abandon: () => Promise<void>;
  },
  response: unknown,
  validate: (value: unknown) => T,
): Promise<T> {
  try {
    return validate(response);
  } catch (error) {
    const threadId = readCodexThreadCreationResponseId(response);
    const released = threadId
      ? await unsubscribeCodexThreadBestEffort(owner.client, {
          threadId,
          timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        })
      : false;
    if (released) {
      throw error;
    }
    try {
      await owner.abandon();
    } catch (abandonError) {
      throw new CodexAppServerUnsafeSubscriptionError(
        "Codex thread creation response was invalid and its client could not be retired",
        { cause: abandonError },
      );
    }
    throw new CodexAppServerUnsafeSubscriptionError(
      "Codex thread creation response was invalid and its subscription could not be released",
      { cause: error },
    );
  }
}

/** Sends a turn interrupt without blocking abort cleanup on app-server errors. */
export function interruptCodexTurnBestEffort(
  client: CodexAppServerClient,
  params: {
    threadId: string;
    turnId: string;
    timeoutMs?: number;
  },
): void {
  const requestOptions =
    params.timeoutMs && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? { timeoutMs: params.timeoutMs }
      : undefined;
  const requestParams = { threadId: params.threadId, turnId: params.turnId };
  try {
    const interrupt = requestOptions
      ? client.request("turn/interrupt", requestParams, requestOptions)
      : client.request("turn/interrupt", requestParams);
    void Promise.resolve(interrupt).catch((error: unknown) => {
      embeddedAgentLog.debug("codex app-server turn interrupt failed during abort", { error });
    });
  } catch (error) {
    embeddedAgentLog.debug("codex app-server turn interrupt failed during abort", { error });
  }
}

/** Unsubscribes from a thread and reports whether wire cleanup was confirmed. */
export async function unsubscribeCodexThreadBestEffort(
  client: CodexAppServerClient,
  params: {
    threadId: string;
    timeoutMs: number;
  },
): Promise<boolean> {
  try {
    await client.request(
      "thread/unsubscribe",
      { threadId: params.threadId },
      { timeoutMs: params.timeoutMs },
    );
    return true;
  } catch (error) {
    embeddedAgentLog.debug("codex app-server thread unsubscribe cleanup failed", {
      threadId: params.threadId,
      error,
    });
    return false;
  }
}

/** Returns one exact client lease to the pool only after subscription cleanup succeeds. */
export async function settleCodexAppServerClientLease(
  lease: CodexAppServerClientLease,
  params: {
    threadId?: string;
    timeoutMs: number;
    abandon?: boolean;
  },
): Promise<void> {
  if (params.abandon) {
    await lease.abandon();
    return;
  }
  if (
    params.threadId &&
    !(await unsubscribeCodexThreadBestEffort(lease.client, {
      threadId: params.threadId,
      timeoutMs: params.timeoutMs,
    }))
  ) {
    await lease.abandon();
    return;
  }
  lease.release();
}

/**
 * Retires the shared client after a timed-out turn so later runs do not reuse a
 * potentially wedged app-server connection.
 */
export async function retireCodexAppServerClientAfterTimedOutTurn(
  client: CodexAppServerClient,
  params: {
    threadId: string;
    turnId: string;
    reason: string;
    abandonClientLease: () => Promise<void>;
  },
): Promise<void> {
  interruptCodexTurnBestEffort(client, {
    threadId: params.threadId,
    turnId: params.turnId,
    timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
  });
  await unsubscribeCodexThreadBestEffort(client, {
    threadId: params.threadId,
    timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  });
  await params.abandonClientLease();
  embeddedAgentLog.warn("codex app-server client retired after timed-out turn", {
    threadId: params.threadId,
    turnId: params.turnId,
    reason: params.reason,
  });
}
