import { n as CLI_RESUME_WATCHDOG_DEFAULTS, t as CLI_FRESH_WATCHDOG_DEFAULTS } from "./cli-watchdog-defaults-CzmnkdzO.js";
import { a as CLAUDE_CLI_SESSION_ID_FIELDS, i as CLAUDE_CLI_MODEL_ALIASES, r as CLAUDE_CLI_DEFAULT_MODEL_REF, t as CLAUDE_CLI_BACKEND_ID } from "./cli-constants-8udILsOP.js";
import { i as normalizeClaudeBackendConfig, s as resolveClaudeCliExecutionArgs, t as CLAUDE_CLI_CLEAR_ENV } from "./cli-shared-B3UhuiRU.js";
//#region extensions/anthropic/cli-backend.ts
function buildAnthropicCliBackend() {
	return {
		id: CLAUDE_CLI_BACKEND_ID,
		liveTest: {
			defaultModelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
			defaultImageProbe: true,
			defaultMcpProbe: true,
			docker: {
				npmPackage: "@anthropic-ai/claude-code",
				binaryName: "claude"
			}
		},
		bundleMcp: true,
		bundleMcpMode: "claude-config-file",
		nativeToolMode: "always-on",
		config: {
			command: "claude",
			args: [
				"-p",
				"--output-format",
				"stream-json",
				"--include-partial-messages",
				"--verbose",
				"--setting-sources",
				"user",
				"--allowedTools",
				"mcp__openclaw__*"
			],
			resumeArgs: [
				"-p",
				"--output-format",
				"stream-json",
				"--include-partial-messages",
				"--verbose",
				"--setting-sources",
				"user",
				"--allowedTools",
				"mcp__openclaw__*",
				"--resume",
				"{sessionId}"
			],
			output: "jsonl",
			liveSession: "claude-stdio",
			input: "stdin",
			modelArg: "--model",
			modelAliases: CLAUDE_CLI_MODEL_ALIASES,
			imageArg: "@",
			imagePathScope: "workspace",
			sessionArg: "--session-id",
			sessionMode: "always",
			reseedFromRawTranscriptWhenUncompacted: true,
			sessionIdFields: [...CLAUDE_CLI_SESSION_ID_FIELDS],
			systemPromptFileArg: "--append-system-prompt-file",
			systemPromptMode: "append",
			systemPromptWhen: "first",
			clearEnv: [...CLAUDE_CLI_CLEAR_ENV],
			reliability: { watchdog: {
				fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
				resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS }
			} },
			serialize: true
		},
		normalizeConfig: normalizeClaudeBackendConfig,
		resolveExecutionArgs: resolveClaudeCliExecutionArgs
	};
}
//#endregion
export { buildAnthropicCliBackend as t };
