import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import { buildSystemPrompt, normalizeCliModel } from "./cli-runner/helpers.js";
import { checkCopilotAvailable, runCopilotAgent } from "./copilot-sdk.js";
import { resolveOpenClawDocsPath } from "./docs-path.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "./workspace-run.js";

const log = createSubsystemLogger("agent/copilot-cli");

/**
 * Run a prompt through the Copilot SDK CLI backend.
 * Matches the same parameter shape as `runCliAgent` so it slots into the routing.
 */
export async function runCopilotCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  cliSessionId?: string;
}): Promise<EmbeddedPiRunResult> {
  const started = Date.now();

  // Check availability before doing anything expensive
  const availability = checkCopilotAvailable();
  if (!availability.available) {
    throw new FailoverError(`copilot-cli not available: ${availability.reason}`, {
      reason: "auth",
      provider: "copilot-cli",
      model: params.model ?? "default",
      status: 401,
    });
  }

  const workspaceResolution = resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const resolvedWorkspace = workspaceResolution.workspaceDir;
  if (workspaceResolution.usedFallback) {
    const redacted = redactRunIdentifier(params.sessionId);
    log.warn(
      `[workspace-fallback] caller=runCopilotCliAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redacted}`,
    );
  }

  const rawModelId = (params.model ?? "default").trim() || "default";
  const backendConfig = resolveCliBackendConfig("copilot-cli", params.config);
  const modelId = backendConfig ? normalizeCliModel(rawModelId, backendConfig.config) : rawModelId;
  const modelDisplay = `copilot-cli/${modelId}`;

  const extraSystemPrompt = [
    params.extraSystemPrompt?.trim(),
    "Tools are disabled in this session. Do not call tools.",
  ]
    .filter(Boolean)
    .join("\n");

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir: resolvedWorkspace,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
  });
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
  });
  const heartbeatPrompt =
    sessionAgentId === defaultAgentId
      ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
      : undefined;
  const docsPath = await resolveOpenClawDocsPath({
    workspaceDir: resolvedWorkspace,
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  const systemPrompt = buildSystemPrompt({
    workspaceDir: resolvedWorkspace,
    config: params.config,
    defaultThinkLevel: params.thinkLevel,
    extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    heartbeatPrompt,
    docsPath: docsPath ?? undefined,
    tools: [],
    contextFiles,
    modelDisplay,
    agentId: sessionAgentId,
  });

  try {
    log.info(`copilot-cli exec: model=${modelId} promptChars=${params.prompt.length}`);

    const result = await runCopilotAgent({
      prompt: params.prompt,
      model: modelId === "default" ? undefined : modelId,
      workspaceDir: resolvedWorkspace,
      systemPrompt,
      timeoutMs: params.timeoutMs,
      sessionId: params.cliSessionId,
    });

    const text = result.text?.trim();
    const payloads = text ? [{ text }] : undefined;

    return {
      payloads,
      meta: {
        durationMs: Date.now() - started,
        agentMeta: {
          sessionId: result.sessionId ?? params.sessionId ?? "",
          provider: "copilot-cli",
          model: modelId,
        },
      },
    };
  } catch (err) {
    if (err instanceof FailoverError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (isFailoverErrorMessage(message)) {
      const reason = classifyFailoverReason(message) ?? "unknown";
      const status = resolveFailoverStatus(reason);
      throw new FailoverError(message, {
        reason,
        provider: "copilot-cli",
        model: modelId,
        status,
      });
    }
    throw err;
  }
}
