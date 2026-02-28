// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip undefined values from process.env so the spread is type-safe. */
function parentEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

const CLAUDE_CODE_TRAFFIC_GUARDRAILS = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "0",
  DISABLE_TELEMETRY: "1",
  DISABLE_BUG_COMMAND: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
} as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the env record to pass to query() options.env.
 *
 * The subprocess uses the Claude CLI's own OAuth credentials from ~/.claude/.
 * Strip any API key / auth token / OAuth token so credentials injected by the
 * Pi auth resolver do not leak into the subprocess and cause 401s.
 */
export function buildProviderEnv(): Record<string, string> {
  const env = parentEnv();
  delete env["ANTHROPIC_API_KEY"];
  delete env["ANTHROPIC_AUTH_TOKEN"];
  delete env["ANTHROPIC_OAUTH_TOKEN"];
  Object.assign(env, CLAUDE_CODE_TRAFFIC_GUARDRAILS);
  return env;
}
