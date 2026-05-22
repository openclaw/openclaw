import { type SessionEntry } from "../../config/sessions/types.js";
import type { AgentCommandOpts } from "./types.js";
export type PersistSessionEntryParams = {
    sessionStore: Record<string, SessionEntry>;
    sessionKey: string;
    storePath: string;
    entry: SessionEntry;
    clearedFields?: string[];
};
export declare function persistSessionEntry(params: PersistSessionEntryParams): Promise<void>;
export declare function prependInternalEventContext(body: string, events: AgentCommandOpts["internalEvents"]): string;
export declare function resolveAcpPromptBody(body: string, events: AgentCommandOpts["internalEvents"]): string;
export declare function resolveInternalEventTranscriptBody(body: string, events: AgentCommandOpts["internalEvents"]): string;
