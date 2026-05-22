import type { StreamFn } from "@mariozechner/pi-agent-core";
export declare function createMinimaxFastModeWrapper(baseStreamFn: StreamFn | undefined, fastMode: boolean): StreamFn;
/**
 * MiniMax's Anthropic-compatible streaming endpoint returns reasoning_content
 * in OpenAI-style delta chunks ({delta: {content: "", reasoning_content: "..."}})
 * rather than the native Anthropic thinking block format. Pi-ai's Anthropic
 * provider cannot process this format and leaks the reasoning text as visible
 * content. Disable thinking in the outgoing payload so MiniMax does not produce
 * reasoning_content deltas during streaming.
 */
export declare function createMinimaxThinkingDisabledWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
