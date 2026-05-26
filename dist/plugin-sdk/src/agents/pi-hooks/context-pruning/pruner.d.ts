import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EffectiveContextPruningSettings } from "./settings.js";
export declare function pruneContextMessages(params: {
    messages: AgentMessage[];
    settings: EffectiveContextPruningSettings;
    ctx: Pick<ExtensionContext, "model">;
    isToolPrunable?: (toolName: string) => boolean;
    contextWindowTokensOverride?: number;
    dropThinkingBlocksForEstimate?: boolean;
}): AgentMessage[];
