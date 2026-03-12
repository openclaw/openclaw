export type SignalSender = {
    kind: "phone";
    raw: string;
    e164: string;
} | {
    kind: "uuid";
    raw: string;
};
export declare function looksLikeUuid(value: string): boolean;
export declare function resolveSignalSender(params: {
    sourceNumber?: string | null;
    sourceUuid?: string | null;
}): SignalSender | null;
export declare function formatSignalSenderId(sender: SignalSender): string;
export declare function formatSignalSenderDisplay(sender: SignalSender): string;
export declare function formatSignalPairingIdLine(sender: SignalSender): string;
export declare function resolveSignalRecipient(sender: SignalSender): string;
export declare function resolveSignalPeerId(sender: SignalSender): string;
export declare function isSignalSenderAllowed(sender: SignalSender, allowFrom: string[]): boolean;
export declare function isSignalGroupAllowed(params: {
    groupPolicy: "open" | "disabled" | "allowlist";
    allowFrom: string[];
    sender: SignalSender;
}): boolean;
