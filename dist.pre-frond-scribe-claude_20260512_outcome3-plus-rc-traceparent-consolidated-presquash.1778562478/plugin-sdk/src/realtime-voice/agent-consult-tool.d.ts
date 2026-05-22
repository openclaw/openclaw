import type { RealtimeVoiceTool } from "./provider-types.js";
export declare const REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME = "openclaw_agent_consult";
export declare const REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES: readonly ["safe-read-only", "owner", "none"];
export type RealtimeVoiceAgentConsultToolPolicy = (typeof REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES)[number];
export type RealtimeVoiceAgentConsultArgs = {
    question: string;
    context?: string;
    responseStyle?: string;
};
export type RealtimeVoiceAgentConsultTranscriptEntry = {
    role: "user" | "assistant";
    text: string;
};
export declare const REALTIME_VOICE_AGENT_CONSULT_TOOL: RealtimeVoiceTool;
export declare function buildRealtimeVoiceAgentConsultWorkingResponse(audienceLabel?: string): Record<string, unknown>;
export declare function isRealtimeVoiceAgentConsultToolPolicy(value: unknown): value is RealtimeVoiceAgentConsultToolPolicy;
export declare function resolveRealtimeVoiceAgentConsultToolPolicy(value: unknown, fallback: RealtimeVoiceAgentConsultToolPolicy): RealtimeVoiceAgentConsultToolPolicy;
export declare function resolveRealtimeVoiceAgentConsultTools(policy: RealtimeVoiceAgentConsultToolPolicy, customTools?: RealtimeVoiceTool[]): RealtimeVoiceTool[];
export declare function resolveRealtimeVoiceAgentConsultToolsAllow(policy: RealtimeVoiceAgentConsultToolPolicy): string[] | undefined;
export declare function parseRealtimeVoiceAgentConsultArgs(args: unknown): RealtimeVoiceAgentConsultArgs;
export declare function buildRealtimeVoiceAgentConsultChatMessage(args: unknown): string;
export declare function buildRealtimeVoiceAgentConsultPrompt(params: {
    args: unknown;
    transcript: RealtimeVoiceAgentConsultTranscriptEntry[];
    surface: string;
    userLabel: string;
    assistantLabel?: string;
    questionSourceLabel?: string;
}): string;
export declare function collectRealtimeVoiceAgentConsultVisibleText(payloads: Array<{
    text?: unknown;
    isError?: boolean;
    isReasoning?: boolean;
}>): string | null;
