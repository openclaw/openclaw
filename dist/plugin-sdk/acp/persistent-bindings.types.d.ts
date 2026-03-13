import type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
import type { AcpRuntimeSessionMode } from "./runtime/types.js";
export type ConfiguredAcpBindingChannel = "discord" | "telegram";
export type ConfiguredAcpBindingSpec = {
    channel: ConfiguredAcpBindingChannel;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
    /** Owning OpenClaw agent id (used for session identity/storage). */
    agentId: string;
    /** ACP harness agent id override (falls back to agentId when omitted). */
    acpAgentId?: string;
    mode: AcpRuntimeSessionMode;
    cwd?: string;
    backend?: string;
    label?: string;
};
export type ResolvedConfiguredAcpBinding = {
    spec: ConfiguredAcpBindingSpec;
    record: SessionBindingRecord;
};
export type AcpBindingConfigShape = {
    mode?: string;
    cwd?: string;
    backend?: string;
    label?: string;
};
export declare function normalizeText(value: unknown): string | undefined;
export declare function normalizeMode(value: unknown): AcpRuntimeSessionMode;
export declare function normalizeBindingConfig(raw: unknown): AcpBindingConfigShape;
export declare function buildConfiguredAcpSessionKey(spec: ConfiguredAcpBindingSpec): string;
export declare function toConfiguredAcpBindingRecord(spec: ConfiguredAcpBindingSpec): SessionBindingRecord;
