import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { PluginTextReplacement, PluginTextTransforms } from "../plugins/cli-backend.types.js";
export declare function mergePluginTextTransforms(...transforms: Array<PluginTextTransforms | undefined>): PluginTextTransforms | undefined;
export declare function applyPluginTextReplacements(text: string, replacements?: PluginTextReplacement[]): string;
export declare function transformStreamContextText(context: Parameters<StreamFn>[1], replacements?: PluginTextReplacement[], options?: {
    systemPrompt?: boolean;
}): Parameters<StreamFn>[1];
export declare function wrapStreamFnTextTransforms(params: {
    streamFn: StreamFn;
    input?: PluginTextReplacement[];
    output?: PluginTextReplacement[];
    transformSystemPrompt?: boolean;
}): StreamFn;
