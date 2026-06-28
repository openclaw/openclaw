/**
 * Claude CLI auth seam. Setup may prompt for keychain-backed credentials while
 * runtime paths stay non-interactive.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readClaudeCliCredentialsCached } from "openclaw/plugin-sdk/provider-auth";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type ClaudeCliSettingsFs = {
  existsSync: typeof existsSync;
  readFileSync: (path: string, encoding: "utf8") => string;
  homedir: typeof homedir;
};

const defaultSettingsFs: ClaudeCliSettingsFs = { existsSync, readFileSync, homedir };
let claudeCliSettingsFs: ClaudeCliSettingsFs = defaultSettingsFs;

/** Override the FS layer for tests; pass no argument to restore defaults. */
export function setClaudeCliSettingsFsForTest(overrides?: Partial<ClaudeCliSettingsFs>): void {
  claudeCliSettingsFs = overrides ? { ...defaultSettingsFs, ...overrides } : defaultSettingsFs;
}

/**
 * Sentinel apiKey marker for apiKeyHelper-backed Claude CLI auth.
 * The gate only needs to know auth exists; the actual key comes from the
 * helper script that Claude CLI runs at spawn time.
 */
export const CLAUDE_CLI_API_KEY_HELPER_MARKER = "claude-cli-api-key-helper";

/**
 * Returns true when ~/.claude/settings.json declares a non-empty apiKeyHelper.
 * apiKeyHelper is the Claude Code mechanism for dynamic/proxy auth where
 * the CLI runs a helper script to obtain the API key at spawn time.
 */
export function hasClaudeCliApiKeyHelper(): boolean {
  const settingsPath = join(claudeCliSettingsFs.homedir(), ".claude", "settings.json");
  if (!claudeCliSettingsFs.existsSync(settingsPath)) {
    return false;
  }
  try {
    const parsed = JSON.parse(claudeCliSettingsFs.readFileSync(settingsPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return false;
    }
    return typeof parsed["apiKeyHelper"] === "string" && parsed["apiKeyHelper"].trim().length > 0;
  } catch {
    return false;
  }
}

/** Read Claude CLI credentials for interactive setup paths. */
export function readClaudeCliCredentialsForSetup() {
  return readClaudeCliCredentialsCached();
}

/** Read Claude CLI credentials for setup checks that must not prompt. */
export function readClaudeCliCredentialsForSetupNonInteractive() {
  return readClaudeCliCredentialsCached({ allowKeychainPrompt: false });
}

/** Read Claude CLI credentials for runtime without keychain prompts. */
export function readClaudeCliCredentialsForRuntime() {
  return readClaudeCliCredentialsCached({ allowKeychainPrompt: false });
}
