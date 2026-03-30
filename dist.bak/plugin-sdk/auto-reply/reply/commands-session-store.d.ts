import type { SessionEntry } from "../../config/sessions.js";
import { type AbortCutoff } from "./abort-cutoff.js";
import type { CommandHandler } from "./commands-types.js";
type CommandParams = Parameters<CommandHandler>[0];
export declare function persistSessionEntry(params: CommandParams): Promise<boolean>;
export declare function persistAbortTargetEntry(params: {
    entry?: SessionEntry;
    key?: string;
    sessionStore?: Record<string, SessionEntry>;
    storePath?: string;
    abortCutoff?: AbortCutoff;
}): Promise<boolean>;
export {};
