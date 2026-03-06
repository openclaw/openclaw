import { type VerboseLevel } from "../auto-reply/thinking.js";
import type { SessionEntry } from "../config/sessions.js";
export declare function parseVerboseOverride(raw: unknown): {
    ok: true;
    value: VerboseLevel | null | undefined;
} | {
    ok: false;
    error: string;
};
export declare function applyVerboseOverride(entry: SessionEntry, level: VerboseLevel | null | undefined): void;
