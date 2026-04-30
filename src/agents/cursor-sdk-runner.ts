import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import type { FailoverReason } from "./failover-error.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
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
    if (err instanceof sdkModule.AuthenticationError) return "auth";
    if (err instanceof sdkModule.RateLimitError) return "rate_limit";
  }

  if (elapsed >= timeoutMs || /timeout/i.test(message)) return "timeout";
  if (/rate.?limit|429|too many requests/i.test(message)) return "rate_limit";
  if (/auth|401|unauthorized|forbidden|403/i.test(message)) return "auth";
  if (/billing|payment|quota|insufficient/i.test(message)) return "billing";

  return "surface_error";
}

function collectAssistantText(event: { type: string }): string {
  if (event.type !== "assistant") return "";
  const msg = (event as { message?: { content?: Array<{ type: string; text?: string }> } }).message;
  if (!msg?.content) return "";
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
  const modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;

  const apiKey = await resolveAgentApiKey({
    config: params.config,
    provider: params.provider,
    model: modelId,
  });

  const sdk = await import("@cursor/sdk");
  loadedSdkModule = sdk;
  const { Agent } = sdk;

  const cursorSdkConfig = params.config?.agents?.defaults?.cursorSdk;
  const runtime = cursorSdkConfig?.runtime ?? "local";

  log.info(
    `cursor-sdk exec: runtime=${runtime} model=${modelId} promptChars=${params.prompt.length} run=${params.runId}`,
  );

  const agentOptions =
    runtime === "cloud" && cursorSdkConfig?.cloud
      ? {
          apiKey,
          model: { id: modelId } as const,
          cloud: {
            repos: cursorSdkConfig.cloud.repos ?? [],
            autoCreatePR: cursorSdkConfig.cloud.autoCreatePR,
          },
        }
      : {
          apiKey,
          model: { id: modelId } as const,
          local: { cwd: cursorSdkConfig?.local?.cwd ?? workspaceDir },
        };

  const agent = await Agent.create(agentOptions);

  try {
    const run = await agent.send(params.prompt);
    let text = "";

    for await (const event of run.stream()) {
      text += collectAssistantText(event);
    }

    const result = await run.wait();
    const trimmedText = text.trim() || result.result?.trim() || "";
    const payloads = trimmedText ? [{ text: trimmedText }] : undefined;
    const durationMs = run.durationMs ?? Date.now() - started;

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
    if (err instanceof FailoverError) throw err;

    const elapsed = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
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
