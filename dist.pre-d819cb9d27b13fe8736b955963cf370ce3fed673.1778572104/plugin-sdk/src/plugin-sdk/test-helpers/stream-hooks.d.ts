import type { StreamFn } from "@earendil-works/pi-agent-core";
export declare function createCapturedThinkingConfigStream(): {
    streamFn: StreamFn;
    getCapturedPayload: () => Record<string, unknown> | undefined;
};
