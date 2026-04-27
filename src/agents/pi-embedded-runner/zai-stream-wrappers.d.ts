import type { StreamFn } from "@mariozechner/pi-agent-core";
/**
 * Inject `tool_stream=true` so tool-call deltas stream in real time.
 * Providers can disable this by setting `params.tool_stream=false`.
 */
export declare function createToolStreamWrapper(baseStreamFn: StreamFn | undefined, enabled: boolean): StreamFn;
export declare const createZaiToolStreamWrapper: typeof createToolStreamWrapper;
