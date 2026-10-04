import {
  awaitAgentEndSideEffects,
  buildAgentHookContextChannelFields,
  buildEmbeddedForegroundPromptContext,
  formatErrorMessage,
  resolveAgentDir,
  runAgentEndSideEffects,
  runAgentHarnessLlmOutputHook,
  type AgentHarnessAttemptParamsV2,
  type EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";

export function createAgentsApiAttemptHooks(
  params: AgentHarnessAttemptParamsV2,
  agentId: string,
  startedAtMs: number,
) {
  const contextWindow = {
    contextTokenBudget: params.contextWindowInfo?.tokens ?? params.contextTokenBudget,
    contextWindowSource: params.contextWindowInfo?.source,
    contextWindowReferenceTokens: params.contextWindowInfo?.referenceTokens,
  };
  const hookContext = {
    runId: params.runId,
    agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    modelProviderId: params.provider,
    modelId: params.model.id,
    trigger: params.trigger,
    inputProvenance: params.inputProvenance,
    ...buildAgentHookContextChannelFields(params),
    channelContext: params.channelContext,
    ...contextWindow,
  };
  return { hookContext, complete };

  async function complete(result: EmbeddedRunAttemptResult) {
    const terminal = result.terminal;
    runAgentHarnessLlmOutputHook({
      event: {
        runId: params.runId,
        sessionId: params.sessionId,
        provider: params.provider,
        model: params.model.id,
        resolvedRef: `${params.provider}/${params.model.id}`,
        harnessId: "agentsapi",
        prompt: params.prompt,
        ...contextWindow,
        assistantTexts: result.assistantTexts,
        lastAssistant: result.lastAssistant,
        usage: result.attemptUsage,
      },
      ctx: hookContext,
    });
    const agentEnd = {
      event: {
        runId: params.runId,
        messages: result.messagesSnapshot,
        success: terminal.kind === "ok",
        error: terminal.kind === "failed" ? formatErrorMessage(terminal.error) : undefined,
        durationMs: Date.now() - startedAtMs,
      },
      ctx: {
        ...hookContext,
        config: params.config,
        foregroundPromptContext: buildEmbeddedForegroundPromptContext(
          { ...params, agentId },
          params.agentDir ?? resolveAgentDir(params.config ?? {}, agentId),
        ),
        skillWorkshopAvailable: false,
        compacted: false,
      },
    };
    if (!params.messageChannel && !params.messageProvider) {
      await awaitAgentEndSideEffects(agentEnd);
    } else {
      runAgentEndSideEffects(agentEnd);
    }
  }
}
