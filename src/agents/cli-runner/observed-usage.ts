import { CLAUDE_SELECTED_AUTH_ENV_KEYS } from "./execute-logging.js";
import type { NodeClaudePlacement } from "./types.js";

// Credentials or endpoints handed to Claude Code through its environment can
// select an account other than the host login, just like an OpenClaw-selected
// profile. Configured backend env and preserved Gateway env both reach the
// child, so the check fails closed: every ANTHROPIC_* variable counts except the
// ones below, which never change the account Claude Code runs under.
const CLAUDE_RUN_ACCOUNT_ENV_KEYS = new Set<string>([
  ...CLAUDE_SELECTED_AUTH_ENV_KEYS,
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_GATEWAY_TOKEN",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  // Provider switches; other CLAUDE_CODE_USE_* names toggle features.
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
]);
const CLAUDE_ACCOUNT_NEUTRAL_ANTHROPIC_ENV_KEYS = new Set([
  // OpenClaw's Anthropic Admin API usage credentials; Claude Code ignores them.
  "ANTHROPIC_ADMIN_API_KEY",
  "ANTHROPIC_ADMIN_KEY",
  // OpenClaw's own API-key rotation list; Claude Code reads only ANTHROPIC_API_KEY.
  "ANTHROPIC_API_KEYS",
  // Vertex settings take effect only with CLAUDE_CODE_USE_VERTEX, which counts.
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_VERTEX_USE_GCP_METADATA",
  // Model selectors.
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
]);
// Numbered keys of OpenClaw's API-key rotation, such as ANTHROPIC_API_KEY_2.
const ANTHROPIC_ROTATION_KEY = /^ANTHROPIC_API_KEY_\d+$/u;

// OpenClaw never passes these; a configured one can carry its own env or
// apiKeyHelper, which select the account Claude Code signs in with.
const CLAUDE_SETTINGS_FLAGS = ["--settings", "--managed-settings"];

function passesClaudeSettings(args: readonly string[]): boolean {
  return args.some((arg) =>
    CLAUDE_SETTINGS_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
}

function selectsClaudeAccountOrEndpoint(runEnv: Record<string, string | undefined>): boolean {
  return Object.entries(runEnv).some(([key, value]) => {
    // Windows environment names are case-insensitive.
    const name = key.toUpperCase();
    return (
      Boolean(value) &&
      (CLAUDE_RUN_ACCOUNT_ENV_KEYS.has(name) ||
        (name.startsWith("ANTHROPIC_") &&
          !CLAUDE_ACCOUNT_NEUTRAL_ANTHROPIC_ENV_KEYS.has(name) &&
          !ANTHROPIC_ROTATION_KEY.test(name)))
    );
  });
}

/**
 * Claude Code streams the subscription windows of whatever login it runs
 * under. Only record them when that is the Gateway host's own Claude login: an
 * OpenClaw-selected profile, credentials or an API endpoint in the run
 * environment, configured Claude settings, a paired node, or a per-run config
 * directory can each belong to another account.
 */
export function shouldRecordObservedClaudeUsage(params: {
  backendId: string;
  effectiveAuthProfileId: string | undefined;
  nodePlacement: NodeClaudePlacement | null;
  runEnv: Record<string, string | undefined>;
  gatewayClaudeConfigDir: string | undefined;
  /** Env keys skills injected into the Gateway process for this run. */
  skillEnvKeys: ReadonlySet<string>;
  /** Configured backend arguments, including resume arguments. */
  backendArgs: readonly string[];
}): boolean {
  return (
    params.backendId === "claude-cli" &&
    params.effectiveAuthProfileId === undefined &&
    params.nodePlacement === null &&
    !selectsClaudeAccountOrEndpoint(params.runEnv) &&
    !passesClaudeSettings(params.backendArgs) &&
    // A skill-injected config directory also changes the Gateway's own env for
    // the run, so comparing the two would not notice it.
    ![...params.skillEnvKeys].some((key) => key.toUpperCase() === CLAUDE_CONFIG_DIR) &&
    usesGatewayClaudeConfigDir(params.runEnv, params.gatewayClaudeConfigDir)
  );
}

const CLAUDE_CONFIG_DIR = "CLAUDE_CONFIG_DIR";

function usesGatewayClaudeConfigDir(
  runEnv: Record<string, string | undefined>,
  gatewayClaudeConfigDir: string | undefined,
): boolean {
  const expected = gatewayClaudeConfigDir ?? "";
  // Windows environment names are case-insensitive, so every spelling counts.
  const configDirs = Object.entries(runEnv)
    .filter(([key]) => key.toUpperCase() === CLAUDE_CONFIG_DIR)
    .map(([, value]) => value ?? "");
  return configDirs.length === 0 ? expected === "" : configDirs.every((dir) => dir === expected);
}
