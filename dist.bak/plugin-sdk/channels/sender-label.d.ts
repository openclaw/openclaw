export type SenderLabelParams = {
    name?: string;
    username?: string;
    tag?: string;
    e164?: string;
    id?: string;
};
export declare function resolveSenderLabel(params: SenderLabelParams): string | null;
export declare function listSenderLabelCandidates(params: SenderLabelParams): string[];
