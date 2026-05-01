import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  classifyAgentHarnessTerminalOutcome,
  embeddedAgentLog as log,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { classifyCursorSdkError, type CursorSdkModule } from "./error-classification.js";

const DEFAULT_MODEL = "composer-2";

type CursorSdkPluginConfig = {
  runtime?: "local" | "cloud";
  model?: string;
  cloud?: {
    repos?: Array<{ url: string; startingRef?: string }>;
    autoCreatePR?: boolean;
  };
  local?: {
    cwd?: string;
  };
};

function resolvePluginConfig(raw: unknown): CursorSdkPluginConfig {
  if (raw && typeof raw === "object") {
    return raw as CursorSdkPluginConfig;
  }
  return {};
}

// Only captures final assistant text — tool calls (file edits, terminal,
// subagents) are intentionally excluded, consistent with the Codex harness.
function collectAssistantText(event: { type: string }): string {
  if (event.type !== "assistant") {
    return "";
  }
  const msg = (event as { message?: { content?: Array<{ type: string; text?: string }> } }).message;
  if (!msg?.content) {
    return "";
  }
  let text = "";
  for (const block of msg.content) {
    if (block.type === "text" && block.text) {
      text += block.text;
    }
  }
  return text;
}

let loadedSdkModule: CursorSdkModule | undefined;

export async function runCursorSdkAttempt(
  params: AgentHarnessAttemptParams,
  options: { pluginConfig?: unknown },
): Promise<AgentHarnessAttemptResult> {
  const started = Date.now();
  const config = resolvePluginConfig(options.pluginConfig);
  const modelId = (params.modelId ?? config.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const runtime = config.runtime ?? "local";
  const apiKey = params.resolvedApiKey;

  if (!apiKey) {
    return buildErrorResult(params, {
      error: "No API key found for cursor-sdk provider. Set CURSOR_API_KEY.",
      started,
    });
  }

  const sdk = await import("@cursor/sdk");
  loadedSdkModule = {
    AuthenticationError: sdk.AuthenticationError,
    RateLimitError: sdk.RateLimitError,
  };
  const { Agent } = sdk;

  log.info(
    `cursor-sdk exec: runtime=${runtime} model=${modelId} promptChars=${params.prompt.length} session=${params.sessionId}`,
  );

  const agentOptions =
    runtime === "cloud"
      ? {
          apiKey,
          model: { id: modelId },
          cloud: {
            repos: config.cloud?.repos ?? [],
            autoCreatePR: config.cloud?.autoCreatePR,
          },
        }
      : {
          apiKey,
          model: { id: modelId },
          local: { cwd: config.local?.cwd ?? params.workspaceDir },
        };

  const runAbortController = new AbortController();
  let timedOut = false;

  const abortFromUpstream = () => {
    runAbortController.abort(params.abortSignal?.reason ?? "upstream_abort");
  };
  if (params.abortSignal?.aborted) {
    abortFromUpstream();
  } else {
    params.abortSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    runAbortController.abort("timeout");
  }, params.timeoutMs);

  const agent = await Promise.resolve(Agent.create(agentOptions));

  try {
    if (runAbortController.signal.aborted) {
      return buildErrorResult(params, {
        error: "Cursor SDK run aborted before send",
        started,
        aborted: true,
      });
    }

    const run = await agent.send(params.prompt);

    const cancelOnAbort = () => {
      run.cancel().catch(() => {});
    };
    if (runAbortController.signal.aborted) {
      cancelOnAbort();
    } else {
      runAbortController.signal.addEventListener("abort", cancelOnAbort, { once: true });
    }

    let text = "";
    try {
      for await (const event of run.stream()) {
        text += collectAssistantText(event);
      }
    } finally {
      runAbortController.signal.removeEventListener("abort", cancelOnAbort);
    }

    if (timedOut) {
      return buildErrorResult(params, {
        error: `Cursor SDK agent timed out after ${params.timeoutMs}ms`,
        started,
        timedOut: true,
      });
    }
    if (runAbortController.signal.aborted && !timedOut) {
      return buildErrorResult(params, {
        error: "Cursor SDK run was aborted by upstream",
        started,
        aborted: true,
      });
    }

    const result = await run.wait();
    const durationMs = run.durationMs ?? Date.now() - started;

    if (result.status === "error") {
      return buildErrorResult(params, {
        error: "Cursor SDK run finished with status: error",
        started,
      });
    }
    if (result.status === "cancelled") {
      return buildErrorResult(params, {
        error: "Cursor SDK run was cancelled",
        started,
        aborted: true,
      });
    }

    const trimmedText = text.trim() || result.result?.trim() || "";

    log.info(
      `cursor-sdk done: runtime=${runtime} model=${modelId} durationMs=${durationMs} textLen=${trimmedText.length} session=${params.sessionId}`,
    );

    return buildSuccessResult(params, { text: trimmedText, started });
  } catch (err: unknown) {
    const elapsed = Date.now() - started;
    let message = "Unknown error";
    if (err instanceof Error) {
      message = err.message;
    } else if (typeof err === "string") {
      message = err;
    }
    log.error(`cursor-sdk error: ${message} session=${params.sessionId} elapsed=${elapsed}ms`);

    const reason = classifyCursorSdkError(err, elapsed, params.timeoutMs, loadedSdkModule);
    const isTimeout = reason === "timeout";
    return buildErrorResult(params, {
      error: `Cursor SDK agent failed: ${message}`,
      started,
      timedOut: isTimeout,
    });
  } finally {
    clearTimeout(timeoutHandle);
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    try {
      await agent[Symbol.asyncDispose]();
    } catch {
      log.warn(`cursor-sdk dispose warning: agent cleanup failed session=${params.sessionId}`);
    }
  }
}

function buildUserMessage(prompt: string, timestamp: number): AgentMessage {
  return { role: "user", content: prompt, timestamp } as AgentMessage;
}

function buildSuccessResult(
  params: AgentHarnessAttemptParams,
  ctx: { text: string; started: number },
): AgentHarnessAttemptResult {
  const assistantTexts = ctx.text ? [ctx.text] : [];
  const messagesSnapshot: AgentMessage[] = [buildUserMessage(params.prompt, ctx.started)];

  const agentHarnessResultClassification = classifyAgentHarnessTerminalOutcome({
    assistantTexts,
    turnCompleted: true,
  });

  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: params.sessionId,
    agentHarnessId: "cursor-sdk",
    ...(agentHarnessResultClassification ? { agentHarnessResultClassification } : {}),
    messagesSnapshot,
    assistantTexts,
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  };
}

function buildErrorResult(
  params: AgentHarnessAttemptParams,
  ctx: { error: string; started: number; timedOut?: boolean; aborted?: boolean },
): AgentHarnessAttemptResult {
  return {
    aborted: ctx.aborted ?? false,
    externalAbort: false,
    timedOut: ctx.timedOut ?? false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: ctx.error,
    promptErrorSource: "prompt",
    sessionIdUsed: params.sessionId,
    agentHarnessId: "cursor-sdk",
    messagesSnapshot: [buildUserMessage(params.prompt, ctx.started)],
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  };
}
