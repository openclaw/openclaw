import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function resolveInboundSessionEnvelopeContext(params: {
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
}): {
    storePath: string;
    envelopeOptions: import("../auto-reply/envelope.js").EnvelopeFormatOptions;
    previousTimestamp: number | undefined;
};
