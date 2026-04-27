import type { StreamFn } from "@mariozechner/pi-agent-core";
export declare function createAnthropicVertexStreamFn(projectId: string | undefined, region: string, baseURL?: string): StreamFn;
export declare function createAnthropicVertexStreamFnForModel(model: {
    baseUrl?: string;
}, env?: NodeJS.ProcessEnv): StreamFn;
