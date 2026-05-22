export type WhatsAppOutboundTargetResolution = {
    ok: true;
    to: string;
} | {
    ok: false;
    error: Error;
};
export declare function resolveWhatsAppOutboundTarget(params: {
    to: string | null | undefined;
    allowFrom: Array<string | number> | null | undefined;
    mode: string | null | undefined;
}): WhatsAppOutboundTargetResolution;
