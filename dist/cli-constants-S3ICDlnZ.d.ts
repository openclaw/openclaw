//#region extensions/anthropic/cli-constants.d.ts
declare const CLAUDE_CLI_BACKEND_ID = "claude-cli";
declare const CLAUDE_CLI_DEFAULT_MODEL_REF = "claude-cli/claude-opus-4-7";
declare const CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS: readonly ["claude-cli/claude-opus-4-7", "claude-cli/claude-sonnet-4-6", "claude-cli/claude-opus-4-6", "claude-cli/claude-opus-4-5", "claude-cli/claude-sonnet-4-5", "claude-cli/claude-haiku-4-5"];
declare const CLAUDE_CLI_MODEL_ALIASES: Record<string, string>;
declare const CLAUDE_CLI_SESSION_ID_FIELDS: readonly ["session_id", "sessionId", "conversation_id", "conversationId"];
//#endregion
export { CLAUDE_CLI_SESSION_ID_FIELDS as a, CLAUDE_CLI_MODEL_ALIASES as i, CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS as n, CLAUDE_CLI_DEFAULT_MODEL_REF as r, CLAUDE_CLI_BACKEND_ID as t };