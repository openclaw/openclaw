import type { StreamFn } from "@mariozechner/pi-agent-core";
import * as piAi from "@mariozechner/pi-ai";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { OpenAIWebSocketManager, type OpenAIWebSocketManagerOptions } from "./openai-ws-connection.js";
type OpenAIWsStreamDeps = {
    createManager: (options?: OpenAIWebSocketManagerOptions) => OpenAIWebSocketManager;
    createHttpFallbackStreamFn: (model: ProviderRuntimeModel) => StreamFn | undefined;
    streamSimple: typeof piAi.streamSimple;
};
type ReleaseWsSessionOptions = {
    allowPool?: boolean;
    env?: NodeJS.ProcessEnv;
};
/**
 * Release and close the WebSocket session for the given sessionId.
 * Call this after the agent run completes to free the connection.
 */
export declare function releaseWsSession(sessionId: string, options?: ReleaseWsSessionOptions): void;
/**
 * Returns true if a live WebSocket session exists for the given sessionId.
 */
export declare function hasWsSession(sessionId: string): boolean;
export { buildAssistantMessageFromResponse, convertMessagesToInputItems, convertTools, planTurnInput, } from "./openai-ws-message-conversion.js";
export interface OpenAIWebSocketStreamOptions {
    /** Manager options (url override, retry counts, etc.) */
    managerOptions?: OpenAIWebSocketManagerOptions;
    /** Abort signal forwarded from the run. */
    signal?: AbortSignal;
}
/**
 * Creates a `StreamFn` backed by a persistent WebSocket connection to the
 * OpenAI Responses API.  The first call for a given `sessionId` opens the
 * connection; subsequent calls reuse it, sending only incremental tool-result
 * inputs with `previous_response_id`.
 *
 * If the WebSocket connection is unavailable, the function falls back to an
 * OpenClaw HTTP transport when available, or the standard `streamSimple` path.
 *
 * @param apiKey     OpenAI API key
 * @param sessionId  Agent session ID (used as the registry key)
 * @param opts       Optional manager + abort signal overrides
 */
export declare function createOpenAIWebSocketStreamFn(apiKey: string, sessionId: string, opts?: OpenAIWebSocketStreamOptions): StreamFn;
export declare const __testing: {
    setDepsForTest(overrides?: Partial<OpenAIWsStreamDeps>): void;
    getDefaultHttpFallbackStreamFnForTest(model: ProviderRuntimeModel): StreamFn | undefined;
    setWsDegradeCooldownMsForTest(nextMs?: number): void;
};
