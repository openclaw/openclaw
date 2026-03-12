import type { SubagentRunRecord } from "../../../agents/subagent-registry.js";
import { extractAssistantText, stripToolMessages } from "../../../agents/tools/sessions-helpers.js";
import type { SessionEntry, loadSessionStore as loadSessionStoreFn, resolveStorePath as resolveStorePathFn } from "../../../config/sessions.js";
import type { CommandHandler, CommandHandlerResult } from "../commands-types.js";
import { type SubagentTargetResolution } from "../subagents-utils.js";
export { extractAssistantText, stripToolMessages };
export declare const COMMAND = "/subagents";
export declare const COMMAND_KILL = "/kill";
export declare const COMMAND_STEER = "/steer";
export declare const COMMAND_TELL = "/tell";
export declare const COMMAND_FOCUS = "/focus";
export declare const COMMAND_UNFOCUS = "/unfocus";
export declare const COMMAND_AGENTS = "/agents";
export declare const ACTIONS: Set<string>;
export declare const RECENT_WINDOW_MINUTES = 30;
export declare const STEER_ABORT_SETTLE_TIMEOUT_MS = 5000;
export declare function resolveDisplayStatus(entry: SubagentRunRecord): "timeout" | "failed" | "unknown" | "done" | "running";
export declare function formatSubagentListLine(params: {
    entry: SubagentRunRecord;
    index: number;
    runtimeMs: number;
    sessionEntry?: SessionEntry;
}): string;
export declare function formatTimestampWithAge(valueMs?: number): string;
export type SubagentsAction = "list" | "kill" | "log" | "send" | "steer" | "info" | "spawn" | "focus" | "unfocus" | "agents" | "help";
export type SubagentsCommandParams = Parameters<CommandHandler>[0];
export type SubagentsCommandContext = {
    params: SubagentsCommandParams;
    handledPrefix: string;
    requesterKey: string;
    runs: SubagentRunRecord[];
    restTokens: string[];
};
export declare function stopWithText(text: string): CommandHandlerResult;
export declare function stopWithUnknownTargetError(error?: string): CommandHandlerResult;
export declare function resolveSubagentTarget(runs: SubagentRunRecord[], token: string | undefined): SubagentTargetResolution;
export declare function resolveSubagentEntryForToken(runs: SubagentRunRecord[], token: string | undefined): {
    entry: SubagentRunRecord;
} | {
    reply: CommandHandlerResult;
};
export declare function resolveRequesterSessionKey(params: SubagentsCommandParams, opts?: {
    preferCommandTarget?: boolean;
}): string | undefined;
export declare function resolveHandledPrefix(normalized: string): string | null;
export declare function resolveSubagentsAction(params: {
    handledPrefix: string;
    restTokens: string[];
}): SubagentsAction | null;
export type FocusTargetResolution = {
    targetKind: "subagent" | "acp";
    targetSessionKey: string;
    agentId: string;
    label?: string;
};
export declare function isDiscordSurface(params: SubagentsCommandParams): boolean;
export declare function resolveDiscordAccountId(params: SubagentsCommandParams): string;
export declare function resolveDiscordChannelIdForFocus(params: SubagentsCommandParams): string | undefined;
export declare function resolveFocusTargetSession(params: {
    runs: SubagentRunRecord[];
    token: string;
}): Promise<FocusTargetResolution | null>;
export declare function buildSubagentsHelp(): string;
export type ChatMessage = {
    role?: unknown;
    content?: unknown;
};
export declare function extractMessageText(message: ChatMessage): {
    role: string;
    text: string;
} | null;
export declare function formatLogLines(messages: ChatMessage[]): string[];
export type SessionStoreCache = Map<string, Record<string, SessionEntry>>;
export declare function loadSubagentSessionEntry(params: SubagentsCommandParams, childKey: string, loaders: {
    loadSessionStore: typeof loadSessionStoreFn;
    resolveStorePath: typeof resolveStorePathFn;
}, storeCache?: SessionStoreCache): {
    storePath: string;
    store: Record<string, SessionEntry>;
    entry: SessionEntry;
};
