import type { StreamFn } from "@mariozechner/pi-agent-core";
export declare function createAnthropicVertexStreamFnForModel(model: {
    baseUrl?: string;
}, env?: NodeJS.ProcessEnv): StreamFn;
