import { resolveProviderThinkingLevel } from "../../../auto-reply/thinking.js";
import { projectModelThinkingCompat } from "../../model-catalog-lookup.js";
import type { AgentSessionConfig } from "../../sessions/agent-session-types.js";
import { resolveEmbeddedCompactionThinkingLevel } from "../compaction-runtime-context.js";
import { mapThinkingLevel } from "../utils.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Keep summary policy bound to the run's config while rechecking the active model and session level. */
export function createAttemptCompactionThinkingResolver(
  attempt: Pick<EmbeddedRunAttemptParams, "config" | "sessionKey" | "sandboxSessionKey">,
  agentId: string,
): NonNullable<AgentSessionConfig["resolveCompactionThinkingLevel"]> {
  return (model, inheritedLevel) => {
    const compat = projectModelThinkingCompat(model.compat);
    const catalog = [
      {
        provider: model.provider,
        id: model.id,
        api: model.api,
        reasoning: model.reasoning,
        ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
        // Deployment aliases name their backing model here (params.canonicalModelId).
        ...(model.params ? { params: model.params } : {}),
        ...(compat ? { compat } : {}),
      },
    ];
    const route = { provider: model.provider, catalog, agentRuntime: "openclaw" } as const;
    const level = resolveEmbeddedCompactionThinkingLevel({
      ...route,
      config: attempt.config,
      modelId: model.id,
      inheritedLevel,
      compactionThinkingDefault: model.compactionThinkingDefault,
      agentId,
      sessionKey: attempt.sessionKey ?? attempt.sandboxSessionKey,
    });
    const providerLevel = resolveProviderThinkingLevel({
      ...route,
      model: model.id,
      level,
    });
    // Summaries take the chat turn's concrete conversion, so provider-native Adaptive runs as high.
    return mapThinkingLevel(providerLevel);
  };
}
