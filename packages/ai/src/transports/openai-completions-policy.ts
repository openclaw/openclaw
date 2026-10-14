import type { resolveOpenAIRequestReasoning } from "../providers/openai-request-reasoning.js";
import type { ResolvedOpenAICompletionsCompat } from "./openai-completions-compat.js";
import type { OpenAIModeModel } from "./openai-transport-shared.js";

export function applyCompletionsReasoningAndRouting(
  params: Record<string, unknown>,
  model: OpenAIModeModel,
  reasoning: ReturnType<typeof resolveOpenAIRequestReasoning>,
  compat: ResolvedOpenAICompletionsCompat,
  mode: "direct" | "managed",
): void {
  const direct = mode === "direct";
  const nativeEffort = compat.thinkingFormat === "openrouter" ? undefined : reasoning.effort;
  const enabled = reasoning.thinkingEnabled ?? false;
  if (model.reasoning) {
    let allowScalarEffort = true;
    if (direct && compat.thinkingFormat === "zai") {
      params.thinking = enabled ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
      allowScalarEffort = false;
    } else if (compat.thinkingFormat === "qwen") {
      params.enable_thinking = enabled;
      allowScalarEffort = false;
    } else if (compat.thinkingFormat === "qwen-chat-template") {
      params.chat_template_kwargs = {
        enable_thinking: enabled,
        ...(direct ? { preserve_thinking: true } : {}),
      };
      allowScalarEffort = false;
    } else if (
      compat.thinkingFormat === "together" ||
      (direct && compat.thinkingFormat === "deepseek")
    ) {
      if (compat.thinkingFormat === "deepseek") {
        params.thinking = { type: enabled ? "enabled" : "disabled" };
      } else {
        params.reasoning = { enabled };
      }
      allowScalarEffort = enabled;
    }
    if (
      allowScalarEffort &&
      compat.supportsReasoningEffort &&
      (direct ? nativeEffort !== undefined : nativeEffort)
    ) {
      params.reasoning_effort = nativeEffort;
    }
  }
  if (!direct) {
    return;
  }

  if (compat.openRouterRouting) {
    params.provider = compat.openRouterRouting;
  }

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
