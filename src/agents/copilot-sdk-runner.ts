import path from "node:path";

import { CopilotClient } from "@github/copilot-sdk";
import type { ImageContent } from "@mariozechner/pi-ai";

import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { ClawdbotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { writeCliImages } from "./cli-runner/helpers.js";
import { buildSystemPrompt } from "./cli-runner/helpers.js";
import { resolveClawdbotDocsPath } from "./docs-path.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";

const log = createSubsystemLogger("agent/copilot-sdk");

export async function runCopilotSdkAgent(params: {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: ClawdbotConfig;
  prompt: string;
  provider: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  cliSessionId?: string;
  images?: ImageContent[];
}): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const workspaceDir = resolvedWorkspace;

  const modelId = (params.model ?? "gpt-4.1").trim() || "gpt-4.1";
  const modelDisplay = `${params.provider}/${modelId}`;

  const extraSystemPrompt = [
    params.extraSystemPrompt?.trim(),
    "Tools are disabled in this session. Do not call tools.",
  ]
    .filter(Boolean)
    .join("\n");

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
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
  const docsPath = await resolveClawdbotDocsPath({
    workspaceDir,
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  const systemPrompt = buildSystemPrompt({
    workspaceDir,
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

  let cleanupImages: (() => Promise<void>) | undefined;
  let attachments: Array<{ type: "file"; path: string; displayName?: string }> | undefined;
  if (params.images && params.images.length > 0) {
    const imagePayload = await writeCliImages(params.images);
    cleanupImages = imagePayload.cleanup;
    attachments = imagePayload.paths.map((imagePath) => ({
      type: "file",
      path: imagePath,
      displayName: path.basename(imagePath),
    }));
  }

  const client = new CopilotClient();

  try {
    await client.start();

    let session:
      | Awaited<ReturnType<CopilotClient["createSession"]>>
      | Awaited<ReturnType<CopilotClient["resumeSession"]>>;

    if (params.cliSessionId) {
      try {
        session = await client.resumeSession(params.cliSessionId);
      } catch (err) {
        log.warn(`copilot-sdk resume failed, starting new session: ${String(err)}`);
        session = await client.createSession({
          model: modelId,
          systemMessage: { content: systemPrompt },
        });
      }
    } else {
      session = await client.createSession({
        model: modelId,
        systemMessage: { content: systemPrompt },
      });
    }

    const messageOptions: { prompt: string; attachments?: typeof attachments } = {
      prompt: params.prompt,
    };
    if (attachments && attachments.length > 0) {
      messageOptions.attachments = attachments;
    }

    const response = await session.sendAndWait(messageOptions, params.timeoutMs);
    const text = response?.data?.content?.trim();
    if (!text) {
      throw new Error("Copilot SDK returned no response.");
    }

    return {
      payloads: [{ text }],
      meta: {
        durationMs: Date.now() - started,
        agentMeta: {
          sessionId: session.sessionId,
          provider: params.provider,
          model: modelId,
        },
      },
    } satisfies EmbeddedPiRunResult;
  } catch (err) {
    if (err instanceof FailoverError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (isFailoverErrorMessage(message)) {
      const reason = classifyFailoverReason(message) ?? "unknown";
      const status = resolveFailoverStatus(reason);
      throw new FailoverError(message, {
        reason,
        provider: params.provider,
        model: modelId,
        status,
      });
    }
    throw err;
  } finally {
    if (cleanupImages) {
      await cleanupImages();
    }
    await client.stop();
  }
}
