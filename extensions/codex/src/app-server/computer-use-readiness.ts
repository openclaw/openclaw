/** Computer Use readiness probes and their native subscription lifecycle. */
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  CodexAppServerUnsafeSubscriptionError,
  retireUnsafeCodexTurnClientBestEffort,
} from "./attempt-client-cleanup.js";
import { describeControlFailure } from "./capabilities.js";
import type { CodexAppServerClient } from "./client.js";
import type { ResolvedCodexComputerUseConfig } from "./config.js";
import type { ToolCallResult as CodexMcpToolCallResult } from "./protocol-mcp.js";
import type { CodexThreadStartResponse, JsonValue } from "./protocol.js";
import { isCodexAppServerStartSelectionChangedError } from "./shared-client.js";

/** Minimal app-server request function needed by Computer Use setup. */
export type CodexComputerUseRequest = <T = JsonValue | undefined>(
  method: string,
  params?: unknown,
  options?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<T>;

export function createComputerUseRequest(params: {
  request?: CodexComputerUseRequest;
  client?: CodexAppServerClient;
  timeoutMs?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): CodexComputerUseRequest {
  const assertCurrent = params.assertCurrent;
  if (params.request) {
    const request = params.request;
    if (!assertCurrent) {
      return request;
    }
    return async <T>(
      method: string,
      requestParams?: unknown,
      options?: { timeoutMs?: number; signal?: AbortSignal },
    ) => {
      if (method !== "thread/unsubscribe") {
        assertCurrent();
      }
      return await request<T>(method, requestParams, options);
    };
  }
  const client = params.client;
  if (!client) {
    throw new Error("Computer Use setup requires an acquired app-server client");
  }
  return async <T = JsonValue | undefined>(
    method: string,
    requestParams?: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) =>
    await client.request<T>(method, requestParams, {
      timeoutMs: options?.timeoutMs ?? params.timeoutMs,
      signal: options?.signal ?? params.signal,
      // The readiness probe must release an accepted native subscription after revocation.
      ...(method === "thread/unsubscribe" ? {} : { assertCurrent }),
    });
}

type CodexComputerUseLiveTestState = "skipped" | "passed" | "failed";

export type CodexComputerUseRepairStatus = {
  attempted: boolean;
  killedPids: number[];
  message: string;
  warnings: string[];
};

export type CodexComputerUseLiveTestStatus = {
  status: CodexComputerUseLiveTestState;
  ok: boolean;
  attempted: boolean;
  attempts: number;
  timeoutMs: number;
  retried: boolean;
  repaired: boolean;
  message: string;
  error?: string;
  durationMs?: number;
};

const COMPUTER_USE_LIVE_TEST_RETRY_COUNT = 1;
const COMPUTER_USE_LIVE_TEST_THREAD_NAME = "OpenClaw Computer Use readiness probe";
const COMPUTER_USE_LIST_APPS_TOOL = "list_apps";
const COMPUTER_USE_UNIFIED_JS_TOOL = "js";
const COMPUTER_USE_UNIFIED_JS_PROBE = "await cua.getState();";

export async function runCodexComputerUseLiveTest(params: {
  request: CodexComputerUseRequest;
  client?: CodexAppServerClient;
  signal?: AbortSignal;
  config: ResolvedCodexComputerUseConfig;
  tools?: readonly string[];
}): Promise<{ liveTest: CodexComputerUseLiveTestStatus; repair?: CodexComputerUseRepairStatus }> {
  const startedAt = Date.now();
  let lastError: unknown;
  let repair: CodexComputerUseRepairStatus | undefined;
  const probe = resolveComputerUseLiveTestProbe(params.tools);
  for (let attempt = 0; attempt <= COMPUTER_USE_LIVE_TEST_RETRY_COUNT; attempt += 1) {
    let threadId: string | undefined;
    let outcome:
      | { ok: true; liveTest: CodexComputerUseLiveTestStatus }
      | { ok: false; error: unknown };
    try {
      const thread = await params.request<CodexThreadStartResponse>(
        "thread/start",
        {
          input: [],
          developerInstructions: COMPUTER_USE_LIVE_TEST_THREAD_NAME,
          ephemeral: true,
        },
        {
          timeoutMs: params.config.liveTestTimeoutMs,
        },
      );
      threadId = thread.thread.id;
      const toolResult = await params.request<CodexMcpToolCallResult>(
        "mcpServer/tool/call",
        {
          threadId,
          server: params.config.mcpServerName,
          tool: probe.tool,
          arguments: probe.arguments,
        },
        {
          timeoutMs: params.config.toolCallTimeoutMs,
        },
      );
      if (toolResult.isError === true) {
        throw new Error(
          `Computer Use readiness tool ${params.config.mcpServerName}.${probe.tool} returned an error result`,
        );
      }
      outcome = {
        ok: true,
        liveTest: {
          status: "passed",
          ok: true,
          attempted: true,
          attempts: attempt + 1,
          timeoutMs: params.config.liveTestTimeoutMs,
          retried: attempt > 0,
          repaired: Boolean(repair?.attempted && repair.warnings.length === 0),
          durationMs: Math.max(0, Date.now() - startedAt),
          message: "Computer Use live test passed.",
        },
      };
    } catch (error) {
      outcome = { ok: false, error };
    }
    let cleanupError: Error | undefined;
    if (threadId) {
      try {
        await cleanupComputerUseProbeThread(params, threadId);
      } catch (error) {
        cleanupError = toErrorObject(error, "Computer Use readiness cleanup failed");
      }
    }
    if (
      !outcome.ok &&
      (params.signal?.aborted || isCodexAppServerStartSelectionChangedError(outcome.error))
    ) {
      throw toErrorObject(outcome.error, "Computer Use live test failed");
    }
    if (cleanupError) {
      throw cleanupError;
    }
    if (outcome.ok) {
      return { liveTest: outcome.liveTest, ...(repair ? { repair } : {}) };
    }
    lastError = outcome.error;
    if (attempt < COMPUTER_USE_LIVE_TEST_RETRY_COUNT && params.config.autoRepair) {
      repair = await repairComputerUseMcpRuntime(params.request, params.config);
    }
  }
  const errorMessage = describeControlFailure(lastError);
  return {
    liveTest: {
      status: "failed",
      ok: false,
      attempted: true,
      attempts: COMPUTER_USE_LIVE_TEST_RETRY_COUNT + 1,
      timeoutMs: params.config.liveTestTimeoutMs,
      retried: COMPUTER_USE_LIVE_TEST_RETRY_COUNT > 0,
      repaired: Boolean(repair?.attempted && repair.warnings.length === 0),
      durationMs: Math.max(0, Date.now() - startedAt),
      message: `Computer Use live test failed after ${COMPUTER_USE_LIVE_TEST_RETRY_COUNT + 1} attempts: ${errorMessage}`,
      error: errorMessage,
    },
    ...(repair ? { repair } : {}),
  };
}

function resolveComputerUseLiveTestProbe(tools: readonly string[] | undefined): {
  tool: string;
  arguments: Record<string, JsonValue>;
} {
  if (
    tools?.includes(COMPUTER_USE_UNIFIED_JS_TOOL) &&
    !tools.includes(COMPUTER_USE_LIST_APPS_TOOL)
  ) {
    return {
      tool: COMPUTER_USE_UNIFIED_JS_TOOL,
      arguments: { code: COMPUTER_USE_UNIFIED_JS_PROBE },
    };
  }
  return { tool: COMPUTER_USE_LIST_APPS_TOOL, arguments: {} };
}

async function repairComputerUseMcpRuntime(
  request: CodexComputerUseRequest,
  config: ResolvedCodexComputerUseConfig,
): Promise<CodexComputerUseRepairStatus> {
  try {
    // Codex owns MCP process lifetimes; signaling descendants can kill an active sibling.
    await request("config/mcpServer/reload", undefined, { timeoutMs: config.liveTestTimeoutMs });
    return {
      attempted: true,
      killedPids: [],
      warnings: [],
      message: "Reloaded Computer Use MCP servers through Codex app-server.",
    };
  } catch (error) {
    const message = `Could not reload Computer Use MCP servers: ${describeControlFailure(error)}`;
    return { attempted: true, killedPids: [], warnings: [message], message };
  }
}

async function cleanupComputerUseProbeThread(
  params: {
    request: CodexComputerUseRequest;
    client?: CodexAppServerClient;
    config: ResolvedCodexComputerUseConfig;
  },
  threadId: string,
): Promise<void> {
  try {
    // Ephemeral probes have no stored thread to archive. Release their subscription
    // with a cleanup deadline that remains live after the caller is cancelled.
    await params.request(
      "thread/unsubscribe",
      { threadId },
      {
        timeoutMs: params.config.liveTestTimeoutMs,
        signal: AbortSignal.timeout(params.config.liveTestTimeoutMs),
      },
    );
  } catch (error) {
    if (params.client) {
      await retireUnsafeCodexTurnClientBestEffort(params.client, "Computer Use readiness cleanup");
    }
    throw new CodexAppServerUnsafeSubscriptionError("Computer Use readiness cleanup failed", {
      cause: error,
    });
  }
}

export function skippedLiveTestStatus(
  config: ResolvedCodexComputerUseConfig,
  message: string,
): CodexComputerUseLiveTestStatus {
  return {
    status: "skipped",
    ok: false,
    attempted: false,
    attempts: 0,
    timeoutMs: config.liveTestTimeoutMs,
    retried: false,
    repaired: false,
    message,
  };
}
