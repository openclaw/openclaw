import { type SenderLabelParams } from "../channels/sender-label.js";
import type { OpenClawConfig } from "../config/config.js";
export type AgentEnvelopeParams = {
    channel: string;
    from?: string;
    timestamp?: number | Date;
    host?: string;
    ip?: string;
    body: string;
    previousTimestamp?: number | Date;
    envelope?: EnvelopeFormatOptions;
};
export type EnvelopeFormatOptions = {
    /**
     * "local" (default), "utc", "user", or an explicit IANA timezone string.
     */
    timezone?: string;
    /**
     * Include absolute timestamps in the envelope (default: true).
     */
    includeTimestamp?: boolean;
    /**
     * Include elapsed time suffix when previousTimestamp is provided (default: true).
     */
    includeElapsed?: boolean;
    /**
     * Optional user timezone used when timezone="user".
     */
    userTimezone?: string;
};
export declare function resolveEnvelopeFormatOptions(cfg?: OpenClawConfig): EnvelopeFormatOptions;
export declare function formatAgentEnvelope(params: AgentEnvelopeParams): string;
export declare function formatInboundEnvelope(params: {
    channel: string;
    from: string;
    body: string;
    timestamp?: number | Date;
    chatType?: string;
    senderLabel?: string;
    sender?: SenderLabelParams;
    previousTimestamp?: number | Date;
    envelope?: EnvelopeFormatOptions;
}): string;
export declare function formatInboundFromLabel(params: {
    isGroup: boolean;
    groupLabel?: string;
    groupId?: string;
    directLabel: string;
    directId?: string;
    groupFallback?: string;
}): string;
export declare function formatThreadStarterEnvelope(params: {
    channel: string;
    author?: string;
    timestamp?: number | Date;
    body: string;
    envelope?: EnvelopeFormatOptions;
}): string;
