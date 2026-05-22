import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
import { resolveWebSearchProviderId } from "../../web-search/runtime.js";
import type { AnyAgentTool } from "./common.js";
export declare function createWebSearchTool(options?: {
    config?: OpenClawConfig;
    agentDir?: string;
    sandboxed?: boolean;
    runtimeWebSearch?: RuntimeWebSearchMetadata;
    lateBindRuntimeConfig?: boolean;
}): AnyAgentTool | null;
export declare const testing: {
    SEARCH_CACHE: Map<string, import("openclaw/plugin-sdk/agent-runtime").CacheEntry<Record<string, unknown>>>;
    resolveSearchProvider: (search?: Parameters<typeof resolveWebSearchProviderId>[0]["search"]) => string;
};
export { testing as __testing };
