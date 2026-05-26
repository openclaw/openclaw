import type { OpenClawConfig } from "../config/types.openclaw.js";
export { buildCodexNativeWebSearchTool, patchCodexNativeWebSearchPayload, resolveCodexNativeSearchActivation, shouldSuppressManagedWebSearchTool, } from "./codex-native-web-search-core.js";
export { describeCodexNativeWebSearch, resolveCodexNativeWebSearchConfig, } from "./codex-native-web-search.shared.js";
export declare function isCodexNativeWebSearchRelevant(params: {
    config: OpenClawConfig;
    agentId?: string;
    agentDir?: string;
}): boolean;
