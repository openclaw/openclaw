import type { GatewayRequestHandlers } from "./types.js";
export declare const toolsEffectiveHandlers: GatewayRequestHandlers;
export declare const testing: {
    readonly resetToolsEffectiveCacheForTest: () => void;
    readonly setToolsEffectiveNowForTest: (now: () => number) => void;
    readonly resetToolsEffectiveNowForTest: () => void;
};
export { testing as __testing };
