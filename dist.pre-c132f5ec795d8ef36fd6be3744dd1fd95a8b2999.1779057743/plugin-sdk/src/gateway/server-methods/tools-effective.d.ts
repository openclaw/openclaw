import type { GatewayRequestHandlers } from "./types.js";
export declare const toolsEffectiveHandlers: GatewayRequestHandlers;
export declare const __testing: {
    readonly resetToolsEffectiveCacheForTest: () => void;
    readonly setToolsEffectiveNowForTest: (now: () => number) => void;
    readonly resetToolsEffectiveNowForTest: () => void;
};
