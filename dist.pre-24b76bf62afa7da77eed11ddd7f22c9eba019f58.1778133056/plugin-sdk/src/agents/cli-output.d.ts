import type { CliBackendConfig } from "../config/types.js";
type CliUsage = {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
};
export type CliOutput = {
    text: string;
    rawText?: string;
    sessionId?: string;
    usage?: CliUsage;
    finalPromptText?: string;
};
export type CliStreamingDelta = {
    text: string;
    delta: string;
    sessionId?: string;
    usage?: CliUsage;
};
export declare function parseCliJson(raw: string, backend: CliBackendConfig, providerId?: string): CliOutput | null;
export declare function createCliJsonlStreamingParser(params: {
    backend: CliBackendConfig;
    providerId: string;
    onAssistantDelta: (delta: CliStreamingDelta) => void;
}): {
    push(chunk: string): void;
    finish(): void;
};
export declare function parseCliJsonl(raw: string, backend: CliBackendConfig, providerId: string): CliOutput | null;
export declare function parseCliOutput(params: {
    raw: string;
    backend: CliBackendConfig;
    providerId: string;
    outputMode?: "json" | "jsonl" | "text";
    fallbackSessionId?: string;
}): CliOutput;
export declare function extractCliErrorMessage(raw: string): string | null;
export {};
