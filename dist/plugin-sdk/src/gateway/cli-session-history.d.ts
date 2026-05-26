import type { SessionEntry } from "../config/sessions.js";
import { type ClaudeCliFallbackSeed, readClaudeCliFallbackSeed, readClaudeCliSessionMessages, resolveClaudeCliBindingSessionId, resolveClaudeCliSessionFilePath } from "./cli-session-history.claude.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";
export { mergeImportedChatHistoryMessages, readClaudeCliFallbackSeed, readClaudeCliSessionMessages, resolveClaudeCliBindingSessionId, resolveClaudeCliSessionFilePath, };
export type { ClaudeCliFallbackSeed };
export declare function augmentChatHistoryWithCliSessionImports(params: {
    entry: SessionEntry | undefined;
    provider?: string;
    localMessages: unknown[];
    homeDir?: string;
}): unknown[];
