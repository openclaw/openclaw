import type { Model } from "openclaw/plugin-sdk/llm";
import { resolveThinkingProfile } from "../auto-reply/thinking.js";
import { projectModelThinkingCompat } from "./model-catalog-lookup.js";

export function resolveLiveTestReasoning(
  model: Model,
): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (!model.reasoning) {
    return undefined;
  }
  const id = model.id.toLowerCase();
  if (id.includes("deep-research")) {
    return "medium";
  }
  if (model.provider === "openrouter" && id.startsWith("qwq")) {
    return undefined;
  }
  if (model.provider === "xai" && id.startsWith("grok-4")) {
    return undefined;
  }
  let preferred: "low" | "medium" | "high" = "low";
  if (model.provider === "openai") {
    preferred = id.includes("pro") ? "high" : "medium";
  }
  const profile = resolveThinkingProfile({
    provider: model.provider,
    model: model.id,
    catalog: [
      {
        provider: model.provider,
        id: model.id,
        api: model.api,
        reasoning: model.reasoning,
        compat: projectModelThinkingCompat(model.compat),
      },
    ],
    agentRuntime: "openclaw",
  });
  if (profile.levels.some((level) => level.id === preferred)) {
    return preferred;
  }
  return profile.defaultLevel === "minimal" ||
    profile.defaultLevel === "low" ||
    profile.defaultLevel === "medium" ||
    profile.defaultLevel === "high" ||
    profile.defaultLevel === "xhigh"
    ? profile.defaultLevel
    : undefined;
}
