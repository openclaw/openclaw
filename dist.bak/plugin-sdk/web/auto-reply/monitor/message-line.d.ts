import { type EnvelopeFormatOptions } from "../../../auto-reply/envelope.js";
import type { loadConfig } from "../../../config/config.js";
import type { WebInboundMsg } from "../types.js";
export declare function formatReplyContext(msg: WebInboundMsg): string | null;
export declare function buildInboundLine(params: {
    cfg: ReturnType<typeof loadConfig>;
    msg: WebInboundMsg;
    agentId: string;
    previousTimestamp?: number;
    envelope?: EnvelopeFormatOptions;
}): string;
