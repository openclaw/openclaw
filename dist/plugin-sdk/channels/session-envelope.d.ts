import type { OpenClawConfig } from "../config/config.js";
export declare function resolveInboundSessionEnvelopeContext(params: {
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
}): {
    storePath: string;
    envelopeOptions: import("../auto-reply/envelope.js").EnvelopeFormatOptions;
    previousTimestamp: number | undefined;
};
