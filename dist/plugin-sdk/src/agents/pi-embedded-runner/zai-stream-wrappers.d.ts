import type { StreamFn } from "@earendil-works/pi-agent-core";
/**
 * Inject `tool_stream=true` so tool-call deltas stream in real time.
 * Providers can disable this by setting `params.tool_stream=false`.
 *
 * @deprecated Provider-owned stream helper; do not use from third-party plugins.
 */
export declare function createToolStreamWrapper(baseStreamFn: StreamFn | undefined, enabled: boolean): StreamFn;
/** @deprecated Z.ai provider-owned stream helper; do not use from third-party plugins. */
export declare const createZaiToolStreamWrapper: typeof createToolStreamWrapper;
