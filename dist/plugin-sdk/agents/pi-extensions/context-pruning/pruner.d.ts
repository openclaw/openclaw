import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { EffectiveContextPruningSettings } from "./settings.js";
export declare function pruneContextMessages(params: {
    messages: AgentMessage[];
    settings: EffectiveContextPruningSettings;
    ctx: Pick<ExtensionContext, "model">;
    isToolPrunable?: (toolName: string) => boolean;
    contextWindowTokensOverride?: number;
}): AgentMessage[];
