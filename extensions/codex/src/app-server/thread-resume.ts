import {
  assertCodexThreadResumeSubscription,
  CodexAppServerUnsafeSubscriptionError,
} from "./attempt-client-cleanup.js";
/** Owns Codex thread/resume subscription safety. */
import { CodexAppServerRpcError, type CodexAppServerClient } from "./client.js";
import { assertCodexThreadResumeResponse } from "./protocol-validators.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type CodexThreadResumeParams,
  type CodexThreadResumeResponse,
  type JsonValue,
} from "./protocol.js";

export type CodexNativeContextUsageUpdate = {
  currentTokens: number;
  modelContextWindow?: number;
};

/** Resumes one thread and retires the physical client when acceptance is indeterminate. */
export async function resumeCodexAppServerThread(params: {
  client: CodexAppServerClient;
  abandonClient: () => Promise<void>;
  request: CodexThreadResumeParams;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexThreadResumeResponse> {
  const threadId = params.request.threadId;
  let response: CodexThreadResumeResponse;
  try {
    response = assertCodexThreadResumeResponse(
      await params.client.request("thread/resume", params.request, {
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      }),
    );
    assertCodexThreadResumeSubscription(threadId, response.thread.id);
  } catch (error) {
    if (error instanceof CodexAppServerRpcError) {
      throw error;
    }
    try {
      await params.abandonClient();
    } catch (abandonError) {
      throw new CodexAppServerUnsafeSubscriptionError(
        `Codex thread/resume client could not be retired for ${threadId}`,
        { cause: abandonError },
      );
    }
    if (error instanceof CodexAppServerUnsafeSubscriptionError) {
      throw error;
    }
    throw new CodexAppServerUnsafeSubscriptionError(
      error instanceof Error
        ? error.message
        : `Codex thread/resume outcome is indeterminate for ${threadId}`,
      { cause: error },
    );
  }
  return response;
}

/** Reads the authoritative per-context usage carried by Codex notifications. */
export function readCodexNativeContextUsage(
  notification: CodexServerNotification,
): CodexNativeContextUsageUpdate | undefined {
  const params = isJsonObject(notification.params) ? notification.params : undefined;
  const tokenUsage = params && isJsonObject(params.tokenUsage) ? params.tokenUsage : undefined;
  const current = tokenUsage && isJsonObject(tokenUsage.last) ? tokenUsage.last : undefined;
  const currentTokens = current ? readNonNegativeFiniteNumber(current.totalTokens) : undefined;
  if (currentTokens === undefined) {
    return undefined;
  }
  const modelContextWindow = readPositiveFiniteNumber(tokenUsage?.modelContextWindow);
  return {
    currentTokens,
    ...(modelContextWindow !== undefined ? { modelContextWindow } : {}),
  };
}

function readNonNegativeFiniteNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function readPositiveFiniteNumber(value: JsonValue | undefined): number | undefined {
  const number = readNonNegativeFiniteNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}
