import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
import type { FailoverReason } from "./pi-embedded-helpers/types.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "./workspace-run.js";

const log = createSubsystemLogger("agent/cursor-sdk");

const DEFAULT_MODEL = "composer-2";

export type RunCursorSdkAgentParams = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  provider: string;
  model?: string;
  timeoutMs: number;
  runId: string;
  cursorRunId?: string;
};

async function resolveAgentApiKey(params: {
  config?: OpenClawConfig;
  provider: string;
  model: string;
}): Promise<string> {
  try {
    const auth = await resolveApiKeyForProvider({
      provider: "cursor-sdk",
      cfg: params.config,
      agentDir: undefined,
    });
    if (!auth.apiKey) {
      throw new Error("Resolved auth has no apiKey");
    }
    return auth.apiKey;
  } catch {
    throw new FailoverError("No API key found for cursor-sdk provider.", {
      reason: "auth",
      provider: params.provider,
      model: params.model,
      status: resolveFailoverStatus("auth"),
    });
  }
}

function classifyCursorSdkError(err: unknown, elapsed: number, timeoutMs: number): FailoverReason {
  const message = err instanceof Error ? err.message : "";

  const sdkModule = loadedSdkModule;
  if (sdkModule) {
    if (err instanceof sdkModule.AuthenticationError) {
      return "auth";
    }
    if (err instanceof sdkModule.RateLimitError) {
      return "rate_limit";
    }
  }

  if (elapsed >= timeoutMs || /timeout/i.test(message)) {
    return "timeout";
  }
  if (/rate.?limit|429|too many requests/i.test(message)) {
    return "rate_limit";
  }
  if (/auth|401|unauthorized|forbidden|403/i.test(message)) {
    return "auth";
  }
  if (/billing|payment|quota|insufficient/i.test(message)) {
    return "billing";
  }

  return "unclassified";
}

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

let loadedSdkModule: typeof import("@cursor/sdk") | undefined;

export async function runCursorSdkAgent(
  params: RunCursorSdkAgentParams,
): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const workspaceResolution = resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  if (workspaceResolution.usedFallback) {
    log.warn(
      `[workspace-fallback] caller=runCursorSdkAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactRunIdentifier(params.sessionId)}`,
    );
  }
  const workspaceDir = workspaceResolution.workspaceDir;
  const cursorSdkConfig = params.config?.agents?.defaults?.cursorSdk;
  const modelId = (params.model ?? cursorSdkConfig?.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;

  const apiKey = await resolveAgentApiKey({
    config: params.config,
    provider: params.provider,
    model: modelId,
  });

  const sdk = await import("@cursor/sdk");
  loadedSdkModule = sdk;
  const { Agent } = sdk;

  const runtime = cursorSdkConfig?.runtime ?? "local";

  log.info(
    `cursor-sdk exec: runtime=${runtime} model=${modelId} promptChars=${params.prompt.length} run=${params.runId}`,
  );

  const agentOptions =
    runtime === "cloud"
      ? {
          apiKey,
          model: { id: modelId },
          cloud: {
            repos: cursorSdkConfig?.cloud?.repos ?? [],
            autoCreatePR: cursorSdkConfig?.cloud?.autoCreatePR,
          },
        }
      : {
          apiKey,
          model: { id: modelId },
          local: { cwd: cursorSdkConfig?.local?.cwd ?? workspaceDir },
        };

  // eslint-disable-next-line @typescript-eslint/await-thenable -- Agent.create returns a Promise via dynamic import
  const agent = await Agent.create(agentOptions);

  try {
    const run = await agent.send(params.prompt);
    let text = "";
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      run.cancel().catch(() => {});
    }, params.timeoutMs);

    try {
      for await (const event of run.stream()) {
        text += collectAssistantText(event);
      }
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (timedOut) {
      throw new FailoverError(`Cursor SDK agent timed out after ${params.timeoutMs}ms`, {
        reason: "timeout",
        provider: params.provider,
        model: modelId,
        status: resolveFailoverStatus("timeout"),
      });
    }

    const result = await run.wait();
    const durationMs = run.durationMs ?? Date.now() - started;

    if (result.status === "error") {
      throw new FailoverError(`Cursor SDK run finished with status: ${result.status}`, {
        reason: "unclassified",
        provider: params.provider,
        model: modelId,
        status: resolveFailoverStatus("unclassified"),
      });
    }
    if (result.status === "cancelled") {
      throw new FailoverError("Cursor SDK run was cancelled", {
        reason: "unclassified",
        provider: params.provider,
        model: modelId,
        status: resolveFailoverStatus("unclassified"),
      });
    }

    const trimmedText = text.trim() || result.result?.trim() || "";
    const payloads = trimmedText ? [{ text: trimmedText }] : undefined;

    log.info(
      `cursor-sdk done: runtime=${runtime} model=${modelId} durationMs=${durationMs} textLen=${trimmedText.length} run=${params.runId}`,
    );

    return {
      payloads,
      meta: {
        durationMs,
        agentMeta: {
          sessionId: run.id ?? params.sessionId,
          provider: params.provider,
          model: modelId,
        },
        executionTrace: {
          runner: "cli",
          winnerProvider: params.provider,
          winnerModel: modelId,
        },
      },
    };
  } catch (err: unknown) {
    if (err instanceof FailoverError) {
      throw err;
    }

    const elapsed = Date.now() - started;
    let message = "Unknown error";
    if (err instanceof Error) {
      message = err.message;
    } else if (typeof err === "string") {
      message = err;
    }
    log.error(`cursor-sdk error: ${message} run=${params.runId} elapsed=${elapsed}ms`);

    const reason = classifyCursorSdkError(err, elapsed, params.timeoutMs);
    throw new FailoverError(`Cursor SDK agent failed: ${message}`, {
      reason,
      provider: params.provider,
      model: modelId,
      status: resolveFailoverStatus(reason),
    });
  } finally {
    try {
      await agent[Symbol.asyncDispose]();
    } catch {
      log.warn(`cursor-sdk dispose warning: agent cleanup failed run=${params.runId}`);
    }
  }
}
