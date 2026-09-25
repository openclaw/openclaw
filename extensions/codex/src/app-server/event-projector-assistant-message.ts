import { createAgentHarnessAssistantMessage } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import type {
  NormalizedUsage,
  AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import type { CodexAsyncQuestion } from "./async-questions.js";
import {
  codexProviderRefusalDetails,
  type CodexProviderRefusal,
} from "./event-projector-values.js";
import {
  resolveCodexLocalRuntimeAttribution,
  type CodexLocalRuntimeAttributionParams,
} from "./local-runtime-attribution.js";

type CodexAssistantMessageParams = CodexLocalRuntimeAttributionParams &
  Pick<AgentHarnessAttemptParamsV2, "modelId">;
type CodexAssistantAttribution = {
  provider: string;
  modelId: string;
  api?: AssistantMessage["api"];
};

export type AssistantMessageOptions = {
  tokenUsage: NormalizedUsage | undefined;
  aborted: boolean;
  promptError: unknown;
  providerRefusal?: CodexProviderRefusal;
};

export type CodexAsyncAssistantMessage = AssistantMessage & {
  openclawAsyncDelivery: { itemId: string; questions?: CodexAsyncQuestion[] };
};

export function createAssistantMessage(
  params: CodexAssistantMessageParams,
  text: string,
  options: AssistantMessageOptions,
): AssistantMessage {
  const attribution = resolveCodexLocalRuntimeAttribution(params);
  return createAttributedCodexAssistantMessage(
    { ...attribution, modelId: params.modelId },
    text,
    options,
  );
}

/** Creates a Codex assistant row when a bounded call already owns attribution. */
export function createAttributedCodexAssistantMessage(
  attribution: CodexAssistantAttribution,
  text: string,
  options: AssistantMessageOptions,
): AssistantMessage {
  const refusal = options.providerRefusal;
  return createAgentHarnessAssistantMessage(
    { ...attribution, api: attribution.api ?? "openai-chatgpt-responses" },
    text,
    {
      tokenUsage: options.tokenUsage,
      aborted: options.aborted,
      promptError: options.promptError,
      errorMessage: refusal?.message,
      ...(refusal
        ? {
            diagnostics: [
              {
                type: "provider_refusal",
                timestamp: Date.now(),
                details: codexProviderRefusalDetails(refusal),
              },
            ],
          }
        : {}),
    },
  );
}

export function createAssistantCommentaryMessage(
  params: CodexAssistantMessageParams,
  text: string,
  itemId: string,
  timestamp: number,
): AssistantMessage {
  const message: AssistantMessage & {
    openclawStreamFallback: { replacementText: string; source: "segment"; itemId: string };
  } = {
    ...createNonterminalAssistantMessage(params, [{ type: "text", text }], timestamp),
    // Keep this unphased: gateway history hides commentary-phase assistant rows.
    // The keyed fallback persists Control UI narration without channel delivery.
    openclawStreamFallback: {
      replacementText: text,
      source: "segment",
      itemId,
    },
  };
  return message;
}

export function createAssistantAsyncMessage(
  params: CodexAssistantMessageParams,
  text: string,
  itemId: string,
  timestamp: number,
  questions?: CodexAsyncQuestion[],
): CodexAsyncAssistantMessage {
  return {
    ...createNonterminalAssistantMessage(params, [{ type: "text", text }], timestamp),
    openclawAsyncDelivery: { itemId, ...(questions ? { questions } : {}) },
  };
}

export function createAssistantReasoningMessage(
  params: CodexAssistantMessageParams,
  text: string,
): AssistantMessage {
  // Shared history and visibility controls need reasoning, not final-answer text.
  return createNonterminalAssistantMessage(params, [{ type: "thinking", thinking: text }]);
}

function createNonterminalAssistantMessage(
  params: CodexAssistantMessageParams,
  content: AssistantMessage["content"],
  timestamp?: number,
): AssistantMessage {
  const attribution = resolveCodexLocalRuntimeAttribution(params);
  return createAgentHarnessAssistantMessage(
    {
      ...attribution,
      api: attribution.api ?? "openai-chatgpt-responses",
      modelId: params.modelId,
    },
    "",
    { content, aborted: false, timestamp },
  );
}
