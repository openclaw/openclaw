import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
/** @deprecated OpenRouter provider-owned stream helper; do not use from third-party plugins. */
export declare function createOpenRouterSystemCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
/** @deprecated OpenRouter provider-owned stream helper; do not use from third-party plugins. */
export declare function createOpenRouterWrapper(baseStreamFn: StreamFn | undefined, thinkingLevel?: ThinkLevel, extraParams?: Record<string, unknown>): StreamFn;
/** @deprecated Proxy provider-owned stream helper; do not use from third-party plugins. */
export declare function isProxyReasoningUnsupported(modelId: string): boolean;
/** @deprecated Kilocode provider-owned stream helper; do not use from third-party plugins. */
export declare function createKilocodeWrapper(baseStreamFn: StreamFn | undefined, thinkingLevel?: ThinkLevel): StreamFn;
