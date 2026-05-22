import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { WebInboundMsg } from "../types.js";
import { type EnvelopeFormatOptions } from "./message-line.runtime.js";
export declare function formatReplyContext(msg: WebInboundMsg): string | null;
export declare function buildInboundLine(params: {
    cfg: OpenClawConfig;
    msg: WebInboundMsg;
    agentId: string;
    previousTimestamp?: number;
    envelope?: EnvelopeFormatOptions;
}): string;
