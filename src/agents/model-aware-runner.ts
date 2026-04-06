import { runCliAgent } from "./cli-runner.js";
import { createAcpVisibleTextAccumulator } from "./command/attempt-execution.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { isCliProvider } from "./model-selection.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";
import { runEmbeddedPiAgent } from "./pi-embedded.js";

function resolveDecisionLikeSystemPrompt(params: {
  extraSystemPrompt?: string;
  disableTools?: boolean;
}): string | undefined {
  const base = params.extraSystemPrompt?.trim();
  if (!params.disableTools) {
    return base || undefined;
  }
  return [base, "Tools are disabled in this session. Do not call tools."]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n");
}

function emitAgentEvent(
  cb: RunEmbeddedPiAgentParams["onAgentEvent"],
  event: { stream: string; data: Record<string, unknown> },
): void {
  if (!cb) {
    return;
  }
  cb(event);
}

export async function runModelAwareAgent(
  params: RunEmbeddedPiAgentParams & { cliSessionId?: string },
): Promise<EmbeddedPiRunResult> {
  const provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
  if (!isCliProvider(provider, params.config)) {
    return runEmbeddedPiAgent(params);
  }

  const messageChannel = params.messageChannel ?? params.messageProvider;
  const extraSystemPrompt = resolveDecisionLikeSystemPrompt({
    extraSystemPrompt: params.extraSystemPrompt,
    disableTools: params.disableTools,
  });
  const visibleTextAccumulator = createAcpVisibleTextAccumulator();

  return runCliAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.config,
    prompt: params.prompt,
    provider,
    model: params.model,
    thinkLevel: params.thinkLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    extraSystemPrompt,
    skillsSnapshot: params.skillsSnapshot,
    disableTools: params.disableTools,
    ownerNumbers: params.ownerNumbers,
    cliSessionId: params.cliSessionId,
    images: params.images,
    abortSignal: params.abortSignal,
    trigger: params.trigger,
    messageChannel,
    onAssistantTurn: (text) => {
      const visibleUpdate = visibleTextAccumulator.consume(text);
      if (!visibleUpdate) {
        return;
      }
      if (visibleUpdate.delta) {
        void params.onPartialReply?.({ text: visibleUpdate.delta });
      }
      emitAgentEvent(params.onAgentEvent, {
        stream: "assistant",
        data: { text: visibleUpdate.text, delta: visibleUpdate.delta },
      });
    },
    onThinkingTurn: (payload) => {
      if (payload.text.trim()) {
        void params.onReasoningStream?.({ text: payload.text });
      }
      emitAgentEvent(params.onAgentEvent, {
        stream: "thinking",
        data: payload.delta ? { text: payload.text, delta: payload.delta } : { text: payload.text },
      });
    },
    onToolUseEvent: (payload) => {
      emitAgentEvent(params.onAgentEvent, {
        stream: "tool",
        data: {
          phase: "start",
          name: payload.name,
          ...(payload.toolUseId ? { toolUseId: payload.toolUseId } : {}),
          ...(payload.input !== undefined ? { input: payload.input } : {}),
        },
      });
    },
    onToolResult: (payload) => {
      if (payload.text || payload.isError) {
        void params.onToolResult?.({
          text: payload.text,
          ...(payload.toolUseId ? { toolCallId: payload.toolUseId } : {}),
        });
      }
      emitAgentEvent(params.onAgentEvent, {
        stream: "tool",
        data: {
          phase: "result",
          ...(payload.toolUseId ? { toolUseId: payload.toolUseId } : {}),
          ...(payload.text ? { result: payload.text, partialResult: payload.text } : {}),
          ...(payload.isError ? { isError: true } : {}),
        },
      });
    },
  });
}
