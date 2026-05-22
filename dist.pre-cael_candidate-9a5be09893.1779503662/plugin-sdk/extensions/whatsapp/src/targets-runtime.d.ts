export type WebChannel = "web";
export declare function assertWebChannel(input: string): asserts input is WebChannel;
export declare function isSelfChatMode(selfE164: string | null | undefined, allowFrom?: Array<string | number> | null): boolean;
export declare function toWhatsappJid(number: string): string;
export declare function toWhatsappJidWithLid(number: string, opts?: JidToE164Options): string;
export type JidToE164Options = {
    authDir?: string;
    lidMappingDirs?: string[];
    logMissing?: boolean;
};
type LidLookup = {
    getPNForLID?: (jid: string) => Promise<string | null>;
};
export declare function jidToE164(jid: string, opts?: JidToE164Options): string | null;
export declare function resolveJidToE164(jid: string | null | undefined, opts?: JidToE164Options & {
    lidLookup?: LidLookup;
}): Promise<string | null>;
export declare function markdownToWhatsApp(text: string): string;
export {};
