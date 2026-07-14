/**
 * Best-effort cleanup helpers for Codex app-server startup attempts and turns.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import {
  clearSharedCodexAppServerClientIfCurrent,
  clearSharedCodexAppServerClientIfCurrentAndUnclaimed,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";

/** Timeout for best-effort app-server turn interruption during cleanup. */
export const CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS = 5_000;
/** Total budget for a hard-cancel turn fence plus confirmed terminal shutdown. */
export const CODEX_APP_SERVER_ABORT_CLEANUP_TIMEOUT_MS = 10_000;
const CODEX_APP_SERVER_BACKGROUND_TERMINAL_RETRY_INTERVAL_MS = 25;
const CODEX_APP_SERVER_BACKGROUND_TERMINAL_EMPTY_CONFIRMATIONS = 2;
/** Timeout for best-effort thread unsubscribe during cleanup. */
export const CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS = 5_000;

/** Raised when a thread subscription may be live on a client OpenClaw no longer controls. */
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

/** Asserts Codex resumed the exact thread this attempt subscribed to. */
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

async function closeClientAndWaitIfAvailable(client: CodexAppServerClient): Promise<void> {
  const closeable = client as {
    close?: CodexAppServerClient["close"];
    closeAndWait?: CodexAppServerClient["closeAndWait"];
  };
  if (typeof closeable.closeAndWait === "function") {
    await closeable.closeAndWait();
    return;
  }
  closeable.close?.();
}

export async function closeCodexStartupClientBestEffort(
  client: CodexAppServerClient | undefined,
): Promise<void> {
  if (!client) {
    return;
  }
  const unclaimedSharedClient = clearSharedCodexAppServerClientIfCurrentAndUnclaimed(client);
  if (unclaimedSharedClient.closed) {
    await closeClientAndWaitIfAvailable(client);
    return;
  }
  if (unclaimedSharedClient.found) {
    const retired = retireSharedCodexAppServerClientIfCurrent(client);
    if (retired?.closed) {
      await closeClientAndWaitIfAvailable(client);
    }
    return;
  }
  const retiredSharedClient = retireSharedCodexAppServerClientIfCurrent(client);
  if (retiredSharedClient) {
    if (retiredSharedClient.closed) {
      await closeClientAndWaitIfAvailable(client);
    }
    return;
  }
  if (clearSharedCodexAppServerClientIfCurrent(client)) {
    await closeClientAndWaitIfAvailable(client);
    return;
  }
  await closeClientAndWaitIfAvailable(client);
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

/** Interrupts a turn and proves that its owned thread has no live background terminals. */
async function interruptAndTerminateCodexTurn(
  client: CodexAppServerClient,
  params: {
    threadId: string;
    turnId: string;
    timeoutMs: number;
    turnCompletion: Promise<boolean>;
  },
): Promise<void> {
  const timeoutMs = Math.max(1, params.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => {
    deadlineController.abort(new Error("codex app-server abort cleanup deadline exceeded"));
  }, timeoutMs);
  deadlineTimer.unref?.();

  try {
    await interruptAndTerminateCodexTurnBeforeDeadline(client, params, {
      deadline,
      signal: deadlineController.signal,
    });
  } finally {
    clearTimeout(deadlineTimer);
  }
}

/**
 * Hard-cancels one Codex turn, using the owned local app-server process group
 * as the final fence when protocol inventory can race native process exit.
 */
export async function hardCancelCodexTurn(
  client: CodexAppServerClient,
  params: {
    threadId: string;
    turnId: string;
    timeoutMs: number;
    turnCompletion: Promise<boolean>;
  },
): Promise<void> {
  const deadline = Date.now() + Math.max(1, params.timeoutMs);
  let protocolError: unknown;
  try {
    await interruptAndTerminateCodexTurn(client, {
      ...params,
      timeoutMs: remainingAbortCleanupTime(deadline),
    });
  } catch (error) {
    protocolError = error;
  }

  if (protocolError === undefined) {
    return;
  }

  const transportPid = Reflect.has(client, "getTransportPid")
    ? client.getTransportPid()
    : undefined;
  let localProcessTreeFenced = false;
  if (transportPid !== undefined) {
    retireSharedCodexAppServerClientIfCurrent(client, { failActiveLeases: true });
    if (!Reflect.has(client, "closeAndWait")) {
      throw buildAbortCleanupError(params, "local app-server process-tree fence is unavailable");
    }
    if (Date.now() >= deadline) {
      throw buildAbortCleanupError(params, "total abort cleanup deadline exceeded", protocolError);
    }
    localProcessTreeFenced = await client.closeAndWait({
      processTreeTimeoutMs: remainingAbortCleanupTime(deadline),
    });
    if (!localProcessTreeFenced) {
      throw buildAbortCleanupError(params, "local app-server process tree remained alive");
    }
  }

  if (protocolError !== undefined && !localProcessTreeFenced) {
    if (protocolError instanceof Error) {
      throw protocolError;
    }
    throw buildAbortCleanupError(params, "protocol cleanup failed", protocolError);
  }
  if (protocolError !== undefined) {
    embeddedAgentLog.warn("codex app-server protocol cleanup required a local process-tree fence", {
      threadId: params.threadId,
      turnId: params.turnId,
      error: protocolError,
    });
  }
}

async function interruptAndTerminateCodexTurnBeforeDeadline(
  client: CodexAppServerClient,
  params: {
    threadId: string;
    turnId: string;
    turnCompletion: Promise<boolean>;
  },
  deadline: { deadline: number; signal: AbortSignal },
): Promise<void> {
  let interruptError: unknown;
  try {
    await client.request(
      "turn/interrupt",
      { threadId: params.threadId, turnId: params.turnId },
      abortCleanupRequestOptions(deadline),
    );
  } catch (error) {
    interruptError = error;
  }

  let turnCompleted: boolean;
  try {
    turnCompleted = await waitForTurnCompletionWithinAbortCleanupDeadline(
      params.turnCompletion,
      deadline.deadline,
    );
  } catch (error) {
    throw buildAbortCleanupError(params, "turn/completed wait failed", error);
  }
  if (!turnCompleted) {
    throw buildAbortCleanupError(params, "turn/completed was not observed", interruptError);
  }

  let lastFailure = interruptError;
  let lastListedProcessIds: string[] = [];
  let consecutiveEmptyListings = 0;
  while (Date.now() < deadline.deadline && !deadline.signal.aborted) {
    try {
      const terminals = await listAllCodexBackgroundTerminals(client, {
        threadId: params.threadId,
        deadline,
      });
      lastListedProcessIds = terminals.map((terminal) => terminal.processId);
      for (const terminal of terminals) {
        const response = await client.request(
          "thread/backgroundTerminals/terminate",
          { threadId: params.threadId, processId: terminal.processId },
          abortCleanupRequestOptions(deadline),
        );
        if (!response.terminated) {
          throw new Error(`terminal ${terminal.processId} was not terminated`);
        }
      }
      if (terminals.length === 0) {
        consecutiveEmptyListings += 1;
        if (consecutiveEmptyListings >= CODEX_APP_SERVER_BACKGROUND_TERMINAL_EMPTY_CONFIRMATIONS) {
          return;
        }
      } else {
        consecutiveEmptyListings = 0;
      }
      lastFailure = undefined;
    } catch (error) {
      consecutiveEmptyListings = 0;
      lastFailure = error;
    }
    const remainingMs = deadline.deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await new Promise<void>((resolve) => {
      setTimeout(
        resolve,
        Math.min(CODEX_APP_SERVER_BACKGROUND_TERMINAL_RETRY_INTERVAL_MS, remainingMs),
      );
    });
  }

  const processSummary =
    lastListedProcessIds.length > 0 ? lastListedProcessIds.join(", ") : "unknown";
  throw buildAbortCleanupError(
    params,
    `could not confirm background terminal termination (processes: ${processSummary})`,
    lastFailure,
  );
}

async function listAllCodexBackgroundTerminals(
  client: CodexAppServerClient,
  params: { threadId: string; deadline: { deadline: number; signal: AbortSignal } },
) {
  const terminals = [];
  let cursor: string | undefined;
  do {
    const response = await client.request(
      "thread/backgroundTerminals/list",
      cursor ? { threadId: params.threadId, cursor } : { threadId: params.threadId },
      abortCleanupRequestOptions(params.deadline),
    );
    terminals.push(...response.data);
    cursor = response.nextCursor ?? undefined;
  } while (cursor);
  return terminals;
}

function abortCleanupRequestOptions(deadline: { deadline: number; signal: AbortSignal }): {
  timeoutMs: number;
  signal: AbortSignal;
} {
  return {
    timeoutMs: remainingAbortCleanupTime(deadline.deadline),
    signal: deadline.signal,
  };
}

function remainingAbortCleanupTime(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function waitForTurnCompletionWithinAbortCleanupDeadline(
  turnCompletion: Promise<boolean>,
  deadline: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      turnCompletion,
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), remainingAbortCleanupTime(deadline));
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function buildAbortCleanupError(
  params: { threadId: string; turnId: string },
  message: string,
  cause?: unknown,
): Error {
  const error = new Error(
    `codex app-server abort cleanup failed for thread ${params.threadId}, turn ${params.turnId}: ${message}`,
    cause === undefined ? undefined : { cause },
  );
  if (cause !== undefined) {
    embeddedAgentLog.warn(error.message, { cause });
  }
  return error;
}

/** Unsubscribes from a thread while swallowing cleanup-only failures. */
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
    /**
     * Only the terminal-idle watch proves the physical client is dead (zero
     * notifications for the whole window). Completion/assistant/budget
     * timeouts are per-turn conditions on a possibly healthy shared process —
     * failing co-leases for those would abort innocent sibling turns.
     */
    suspectPhysicalClient: boolean;
  },
): Promise<void> {
  const retiredSharedClient = retireSharedCodexAppServerClientIfCurrent(client, {
    failActiveLeases: params.suspectPhysicalClient,
  });
  const detachedSharedClient = Boolean(retiredSharedClient);
  const clientAlreadyClosed =
    params.suspectPhysicalClient && (retiredSharedClient?.closed ?? false);
  // Best-effort interrupt/unsubscribe only make sense while the transport is
  // still open; a suspect client was just closed (child gets SIGKILLed).
  if (!clientAlreadyClosed) {
    interruptCodexTurnBestEffort(client, {
      threadId: params.threadId,
      turnId: params.turnId,
      timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
    });
    await unsubscribeCodexThreadBestEffort(client, {
      threadId: params.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    });
  }
  let closedClient = retiredSharedClient?.closed ?? false;
  if (!detachedSharedClient) {
    const close = (client as { close?: () => void }).close;
    if (typeof close === "function") {
      try {
        close.call(client);
        closedClient = true;
      } catch (error) {
        embeddedAgentLog.debug("codex app-server client close failed during timeout cleanup", {
          threadId: params.threadId,
          turnId: params.turnId,
          error,
        });
      }
    }
  }
  embeddedAgentLog.warn("codex app-server client retired after timed-out turn", {
    threadId: params.threadId,
    turnId: params.turnId,
    reason: params.reason,
    detachedSharedClient,
    closedClient,
    activeSharedClientLeases: retiredSharedClient?.activeLeases ?? 0,
  });
}
