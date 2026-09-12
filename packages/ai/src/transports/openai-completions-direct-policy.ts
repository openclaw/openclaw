import type { OpenAICompletionsOptions } from "../provider-options.js";
import {
  resolveOpenAIModelReasoningEfforts,
  resolveOpenAIReasoningEffortForModel,
  supportsOpenAIReasoningEffort,
} from "../providers/openai-reasoning-effort.js";
import type { ResolvedOpenAICompletionsCompat } from "./openai-completions-compat.js";
import { resolveOpenAIReasoningEffortMap } from "./openai-reasoning-compat.js";
import {
  isOpenAICompletionsThinkingEnabled,
  type OpenAIModeModel,
} from "./openai-transport-shared.js";

export function applyDirectCompletionsReasoningAndRouting(
  params: Record<string, unknown>,
  model: OpenAIModeModel,
  options: OpenAICompletionsOptions | undefined,
  compat: ResolvedOpenAICompletionsCompat,
): void {
  // Provider compat is authoritative; keep model-level and literal values as fallbacks
  // for catalogs that have not adopted reasoningEffortMap.
  const reasoningEffortMap = resolveOpenAIReasoningEffortMap(model);
  const thinkingLevelMap: Record<string, string | null | undefined> | undefined =
    model.thinkingLevelMap;
  const offReasoningEffort = reasoningEffortMap.off ?? model.thinkingLevelMap?.off;
  const declaredEfforts = resolveOpenAIModelReasoningEfforts(model);
  const hasReasoningContract =
    compat.supportsReasoningEffort && declaredEfforts !== undefined && declaredEfforts.length > 0;
  let reasoningEffort: string | undefined;
  if (options?.reasoningEffort === undefined) {
    reasoningEffort = offReasoningEffort ?? undefined;
  } else if (reasoningEffortMap[options.reasoningEffort] !== undefined) {
    reasoningEffort = reasoningEffortMap[options.reasoningEffort];
  } else if (thinkingLevelMap && options.reasoningEffort in thinkingLevelMap) {
    reasoningEffort = thinkingLevelMap[options.reasoningEffort] ?? undefined;
  } else if (hasReasoningContract) {
    reasoningEffort = resolveOpenAIReasoningEffortForModel({
      model,
      effort: options.reasoningEffort,
      fallbackMap: reasoningEffortMap,
    });
  } else {
    reasoningEffort = options.reasoningEffort;
  }
  const reasoningEnabled =
    reasoningEffort !== undefined && isOpenAICompletionsThinkingEnabled(reasoningEffort);

  if (compat.thinkingFormat === "zai" && model.reasoning) {
    params.thinking = reasoningEnabled
      ? { type: "enabled", clear_thinking: false }
      : { type: "disabled" };
  } else if (compat.thinkingFormat === "qwen" && model.reasoning) {
    params.enable_thinking = reasoningEnabled;
  } else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
    params.chat_template_kwargs = {
      enable_thinking: reasoningEnabled,
      preserve_thinking: true,
    };
  } else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
    params.thinking = { type: reasoningEnabled ? "enabled" : "disabled" };
    if (reasoningEnabled && compat.supportsReasoningEffort) {
      params.reasoning_effort = reasoningEffort;
    }
  } else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
    // OpenRouter normalizes reasoning across providers via a nested reasoning object.
    if (reasoningEnabled) {
      params.reasoning = { effort: reasoningEffort };
    } else if (offReasoningEffort !== null) {
      params.reasoning = { effort: offReasoningEffort ?? "none" };
    }
  } else if (compat.thinkingFormat === "together" && model.reasoning) {
    params.reasoning = { enabled: reasoningEnabled };
    if (reasoningEnabled && compat.supportsReasoningEffort) {
      params.reasoning_effort = reasoningEffort;
    }
  } else if (model.reasoning && compat.supportsReasoningEffort) {
    const isNoneSupported = supportsOpenAIReasoningEffort(model, "none");
    const isReasoningEffortDisabled =
      typeof reasoningEffort === "string" &&
      (reasoningEffort.trim().toLowerCase() === "none" ||
        reasoningEffort.trim().toLowerCase() === "off");

    if (reasoningEnabled && reasoningEffort) {
      // OpenAI-style reasoning_effort
      params.reasoning_effort = reasoningEffort;
    } else if (typeof offReasoningEffort === "string") {
      params.reasoning_effort = offReasoningEffort;
    } else if (
      options?.reasoningEffort !== undefined &&
      (reasoningEffortMap[options.reasoningEffort] !== undefined ||
        (thinkingLevelMap && options.reasoningEffort in thinkingLevelMap))
    ) {
      if (reasoningEffort) {
        params.reasoning_effort = reasoningEffort;
      }
    } else if (
      (isReasoningEffortDisabled || options?.reasoningEffort === "none") &&
      isNoneSupported
    ) {
      params.reasoning_effort = "none";
    }
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
