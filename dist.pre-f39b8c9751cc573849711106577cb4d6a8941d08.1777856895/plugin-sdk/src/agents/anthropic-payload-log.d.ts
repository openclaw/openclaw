import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import { type QueuedFileWriter } from "./queued-file-writer.js";
type PayloadLogWriter = QueuedFileWriter;
type AnthropicPayloadLogger = {
    enabled: true;
    wrapStreamFn: (streamFn: StreamFn) => StreamFn;
    recordUsage: (messages: AgentMessage[], error?: unknown) => void;
};
export declare function createAnthropicPayloadLogger(params: {
    env?: NodeJS.ProcessEnv;
    runId?: string;
    sessionId?: string;
    sessionKey?: string;
    provider?: string;
    modelId?: string;
    modelApi?: string | null;
    workspaceDir?: string;
    writer?: PayloadLogWriter;
}): AnthropicPayloadLogger | null;
export {};
