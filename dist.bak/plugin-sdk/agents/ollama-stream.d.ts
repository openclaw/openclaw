import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
export declare const OLLAMA_NATIVE_BASE_URL = "http://127.0.0.1:11434";
interface OllamaChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    images?: string[];
    tool_calls?: OllamaToolCall[];
    tool_name?: string;
}
interface OllamaToolCall {
    function: {
        name: string;
        arguments: Record<string, unknown>;
    };
}
interface OllamaChatResponse {
    model: string;
    created_at: string;
    message: {
        role: "assistant";
        content: string;
        reasoning?: string;
        tool_calls?: OllamaToolCall[];
    };
    done: boolean;
    done_reason?: string;
    total_duration?: number;
    load_duration?: number;
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
    eval_count?: number;
    eval_duration?: number;
}
export declare function convertToOllamaMessages(messages: Array<{
    role: string;
    content: unknown;
}>, system?: string): OllamaChatMessage[];
export declare function buildAssistantMessage(response: OllamaChatResponse, modelInfo: {
    api: string;
    provider: string;
    id: string;
}): AssistantMessage;
export declare function parseNdjsonStream(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<OllamaChatResponse>;
export declare function createOllamaStreamFn(baseUrl: string): StreamFn;
export {};
