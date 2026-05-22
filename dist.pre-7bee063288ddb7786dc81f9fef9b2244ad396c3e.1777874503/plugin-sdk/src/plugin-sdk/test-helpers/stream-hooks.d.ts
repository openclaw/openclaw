import type { StreamFn } from "@mariozechner/pi-agent-core";
export declare function createCapturedThinkingConfigStream(): {
    streamFn: StreamFn;
    getCapturedPayload: () => Record<string, unknown> | undefined;
};
