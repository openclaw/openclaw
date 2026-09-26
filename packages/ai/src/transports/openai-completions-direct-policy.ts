import type { resolveOpenAIRequestReasoning } from "../providers/openai-request-reasoning.js";
import type { ResolvedOpenAICompletionsCompat } from "./openai-completions-compat.js";
import {
  resolveQwenChatTemplateReasoningEffort,
  type OpenAIModeModel,
} from "./openai-transport-shared.js";

export function applyDirectCompletionsReasoningAndRouting(
  params: Record<string, unknown>,
  model: OpenAIModeModel,
  reasoning: ReturnType<typeof resolveOpenAIRequestReasoning>,
  compat: ResolvedOpenAICompletionsCompat,
): void {
  const nativeEffort = compat.thinkingFormat === "openrouter" ? undefined : reasoning.effort;
  const reasoningEnabled = reasoning.thinkingEnabled ?? false;

  if (compat.thinkingFormat === "zai" && model.reasoning) {
    params.thinking = reasoningEnabled
      ? { type: "enabled", clear_thinking: false }
      : { type: "disabled" };
  } else if (compat.thinkingFormat === "qwen" && model.reasoning) {
    params.enable_thinking = reasoningEnabled;
  } else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
    const chatTemplateReasoningEffort = resolveQwenChatTemplateReasoningEffort(reasoning.level);
    params.chat_template_kwargs = {
      enable_thinking: reasoningEnabled,
      preserve_thinking: true,
      ...(chatTemplateReasoningEffort ? { reasoning_effort: chatTemplateReasoningEffort } : {}),
    };
  } else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
    params.thinking = { type: reasoningEnabled ? "enabled" : "disabled" };
    if (reasoningEnabled && compat.supportsReasoningEffort && nativeEffort !== undefined) {
      params.reasoning_effort = nativeEffort;
    }
  } else if (compat.thinkingFormat === "together" && model.reasoning) {
    params.reasoning = { enabled: reasoningEnabled };
    if (reasoningEnabled && compat.supportsReasoningEffort && nativeEffort !== undefined) {
      params.reasoning_effort = nativeEffort;
    }
  } else if (model.reasoning && compat.supportsReasoningEffort && nativeEffort !== undefined) {
    // OpenAI-style reasoning_effort
    params.reasoning_effort = nativeEffort;
  }

  // OpenRouter provider routing preferences
  if (compat.openRouterRouting) {
    params.provider = compat.openRouterRouting;
  }

  // Vercel AI Gateway provider routing preferences
  if (model.baseUrl.includes("ai-gateway.vercel.sh") && model.compat?.vercelGatewayRouting) {
    const routing = model.compat.vercelGatewayRouting;
    if (routing.only || routing.order) {
      const gatewayOptions: Record<string, string[]> = {};
      if (routing.only) {
        gatewayOptions.only = routing.only;
      }
      if (routing.order) {
        gatewayOptions.order = routing.order;
      }
      params.providerOptions = { gateway: gatewayOptions };
    }
  }
}
