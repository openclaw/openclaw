import { isPlainObject } from "./infra/plain-object.js";
export declare function ensureDir(dir: string): Promise<void>;
/**
 * Check if a file or directory exists at the given path.
 */
export declare function pathExists(targetPath: string): Promise<boolean>;
export declare function clampNumber(value: number, min: number, max: number): number;
export declare function clampInt(value: number, min: number, max: number): number;
/** Alias for clampNumber (shorter, more common name) */
export declare const clamp: typeof clampNumber;
/**
 * Escapes special regex characters in a string so it can be used in a RegExp constructor.
 */
export declare function escapeRegExp(value: string): string;
/**
 * Safely parse JSON, returning null on error instead of throwing.
 */
export declare function safeParseJson<T>(raw: string): T | null;
export { isPlainObject };
/**
 * Type guard for Record<string, unknown> (less strict than isPlainObject).
 * Accepts any non-null object that isn't an array.
 */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export type WebChannel = "web";
export declare function assertWebChannel(input: string): asserts input is WebChannel;
export declare function normalizePath(p: string): string;
export declare function withWhatsAppPrefix(number: string): string;
export declare function normalizeE164(number: string): string;
/**
 * "Self-chat mode" heuristic (single phone): the gateway is logged in as the owner's own WhatsApp account,
 * and `channels.whatsapp.allowFrom` includes that same number. Used to avoid side-effects that make no sense when the
 * "bot" and the human are the same WhatsApp identity (e.g. auto read receipts, @mention JID triggers).
 */
export declare function isSelfChatMode(selfE164: string | null | undefined, allowFrom?: Array<string | number> | null): boolean;
export declare function toWhatsappJid(number: string): string;
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
export declare function sleep(ms: number): Promise<unknown>;
export declare function sliceUtf16Safe(input: string, start: number, end?: number): string;
export declare function truncateUtf16Safe(input: string, maxLen: number): string;
export declare function resolveUserPath(input: string): string;
export declare function resolveConfigDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
export declare function resolveHomeDir(): string | undefined;
export declare function shortenHomePath(input: string): string;
export declare function shortenHomeInString(input: string): string;
export declare function displayPath(input: string): string;
export declare function displayString(input: string): string;
export declare function formatTerminalLink(label: string, url: string, opts?: {
    fallback?: string;
    force?: boolean;
}): string;
export declare const CONFIG_DIR: string;
