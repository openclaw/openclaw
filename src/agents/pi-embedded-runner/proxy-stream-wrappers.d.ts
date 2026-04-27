import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
export declare function createOpenRouterSystemCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
export declare function createOpenRouterWrapper(baseStreamFn: StreamFn | undefined, thinkingLevel?: ThinkLevel): StreamFn;
export declare function isProxyReasoningUnsupported(modelId: string): boolean;
export declare function createKilocodeWrapper(baseStreamFn: StreamFn | undefined, thinkingLevel?: ThinkLevel): StreamFn;
