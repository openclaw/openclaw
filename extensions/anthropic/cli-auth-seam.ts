import { readClaudeCliCredentialsCached } from "openclaw/plugin-sdk/provider-auth";
import { CLAUDE_CLI_USE_BEDROCK_ENV } from "./cli-constants.js";

export function readClaudeCliCredentialsForSetup() {
  return readClaudeCliCredentialsCached();
}

export function readClaudeCliCredentialsForSetupNonInteractive() {
  return readClaudeCliCredentialsCached({ allowKeychainPrompt: false });
}

export function readClaudeCliCredentialsForRuntime() {
  return readClaudeCliCredentialsCached({ allowKeychainPrompt: false });
}

// Claude CLI does not write Anthropic OAuth credentials when configured to
// authenticate through Bedrock (CLAUDE_CODE_USE_BEDROCK=1); the AWS SDK chain
// owns auth at runtime. Surface this as a separate synthetic-auth signal so
// the Anthropic provider hook can satisfy core auth resolution without
// requiring an Anthropic OAuth profile that will never exist.
export function isClaudeCliBedrockAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CLAUDE_CLI_USE_BEDROCK_ENV]?.trim() === "1";
}
