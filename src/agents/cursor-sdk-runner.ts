import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "./workspace-run.js";

const log = createSubsystemLogger("agent/cursor-sdk");

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
  const modelId = (params.model ?? "composer-2").trim() || "composer-2";

  let apiKey: string;
  try {
    const auth = await resolveApiKeyForProvider({
      provider: "cursor-sdk",
      cfg: params.config,
      agentDir: undefined,
    });
    apiKey = auth.apiKey;
  } catch {
    throw new FailoverError("No API key found for cursor-sdk provider.", {
      reason: "auth",
      provider: params.provider,
      model: modelId,
      status: resolveFailoverStatus("auth"),
    });
  }

  const cursorSdkConfig = params.config?.agents?.defaults?.cursorSdk;
  const runtime = cursorSdkConfig?.runtime ?? "local";

  const { Agent } = await import("@cursor/sdk");

  log.info(
    `cursor-sdk exec: runtime=${runtime} model=${modelId} promptChars=${params.prompt.length} run=${params.runId}`,
  );

  const agent =
    runtime === "cloud" && cursorSdkConfig?.cloud
      ? await Agent.create({
          apiKey,
          model: { id: modelId },
          cloud: {
            repos: cursorSdkConfig.cloud.repos ?? [],
            autoCreatePR: cursorSdkConfig.cloud.autoCreatePR,
          },
        })
      : await Agent.create({
          apiKey,
          model: { id: modelId },
          local: { cwd: cursorSdkConfig?.local?.cwd ?? workspaceDir },
        });

  try {
    const run = await agent.send(params.prompt);
    let text = "";

    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of (
          event as {
            type: "assistant";
            message: { content: Array<{ type: string; text?: string }> };
          }
        ).message.content) {
          if (block.type === "text" && block.text) {
            text += block.text;
          }
        }
      }
    }

    const result = await run.wait();
    const trimmedText = text.trim() || (result as { result?: string }).result?.trim() || "";
    const payloads = trimmedText ? [{ text: trimmedText }] : undefined;
    const durationMs = (result as { durationMs?: number }).durationMs ?? Date.now() - started;

    log.info(
      `cursor-sdk done: runtime=${runtime} model=${modelId} durationMs=${durationMs} textLen=${trimmedText.length} run=${params.runId}`,
    );

    return {
      payloads,
      meta: {
        durationMs,
        agentMeta: {
          sessionId: (run as { id?: string }).id ?? params.sessionId,
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
    const elapsed = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    log.error(`cursor-sdk error: ${message} run=${params.runId} elapsed=${elapsed}ms`);

    if (err instanceof FailoverError) {
      throw err;
    }

    const isTimeout = elapsed >= params.timeoutMs || /timeout/i.test(message);
    throw new FailoverError(`Cursor SDK agent failed: ${message}`, {
      reason: isTimeout ? "timeout" : "surface_error",
      provider: params.provider,
      model: modelId,
      status: resolveFailoverStatus(isTimeout ? "timeout" : "surface_error"),
    });
  } finally {
    try {
      await agent[Symbol.asyncDispose]();
    } catch {
      log.warn(`cursor-sdk dispose warning: agent cleanup failed run=${params.runId}`);
    }
  }
}
