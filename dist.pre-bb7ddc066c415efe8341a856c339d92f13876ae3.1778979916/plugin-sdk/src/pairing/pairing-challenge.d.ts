type PairingMeta = Record<string, string | undefined>;
export type PairingChallengeParams = {
    channel: string;
    senderId: string;
    senderIdLine: string;
    meta?: PairingMeta;
    upsertPairingRequest: (params: {
        id: string;
        meta?: PairingMeta;
    }) => Promise<{
        code: string;
        created: boolean;
    }>;
    sendPairingReply: (text: string) => Promise<void>;
    buildReplyText?: (params: {
        code: string;
        senderIdLine: string;
    }) => string;
    onCreated?: (params: {
        code: string;
    }) => void;
    onReplyError?: (err: unknown) => void;
};
/**
 * Shared pairing challenge issuance for DM pairing policy pathways.
 * Ensures every channel follows the same create-if-missing + reply flow.
 */
export declare function issuePairingChallenge(params: PairingChallengeParams): Promise<{
    created: boolean;
    code?: string;
}>;
export {};
