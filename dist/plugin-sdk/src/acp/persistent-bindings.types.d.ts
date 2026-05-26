import type { ChannelId } from "../channels/plugins/types.public.js";
import type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
import type { AcpRuntimeSessionMode } from "./runtime/types.js";
export { normalizeText } from "./normalize-text.js";
export type ConfiguredAcpBindingChannel = ChannelId;
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
type AcpBindingConfigShape = {
    mode?: string;
    cwd?: string;
    backend?: string;
    label?: string;
};
export declare function normalizeMode(value: unknown): AcpRuntimeSessionMode;
export declare function normalizeBindingConfig(raw: unknown): AcpBindingConfigShape;
export declare function buildConfiguredAcpSessionKey(spec: ConfiguredAcpBindingSpec): string;
export declare function toConfiguredAcpBindingRecord(spec: ConfiguredAcpBindingSpec): SessionBindingRecord;
export declare function parseConfiguredAcpSessionKey(sessionKey: string): {
    channel: ConfiguredAcpBindingChannel;
    accountId: string;
} | null;
export declare function resolveConfiguredAcpBindingSpecFromRecord(record: SessionBindingRecord): ConfiguredAcpBindingSpec | null;
export declare function toResolvedConfiguredAcpBinding(record: SessionBindingRecord): ResolvedConfiguredAcpBinding | null;
