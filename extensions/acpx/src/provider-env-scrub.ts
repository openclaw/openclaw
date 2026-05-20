/**
 * Provider-credential env scrubbing for ACP harness spawns.
 *
 * OpenClaw operators put a provider credential (commonly `ANTHROPIC_API_KEY`)
 * in `~/.openclaw/.env` so the gateway can authenticate its own model calls.
 * That value may be a real API key OR an OAuth access token — Anthropic's
 * `/v1/messages` API accepts both, so the gateway works either way.
 *
 * ACP harnesses are separate programs with their OWN auth systems:
 *   - Claude Code authenticates through its own OAuth flow (tokens stored in
 *     the macOS Keychain under "Claude Code-credentials") and REJECTS an OAuth
 *     token supplied via `ANTHROPIC_API_KEY` — it refuses to confuse the two
 *     auth paths and exits with "Invalid API key".
 *   - codex, gemini, cursor, opencode, copilot, droid each authenticate via
 *     their own login/credentials.
 *
 * A spawned harness inherits the gateway's environment, so it sees the
 * gateway's provider creds and tries to use them — breaking its own auth. We
 * therefore strip provider-credential env vars from the harness environment so
 * each harness falls back to its native auth. The harness is launched through
 * a shell `env ...` prefix (see {@link withScrubbedProviderEnv} /
 * `withAcpxLeaseEnvironment`), so we scrub by adding `env -u <NAME>` flags —
 * exactly the user-confirmed workaround `env -u ANTHROPIC_API_KEY claude`.
 *
 * The mapping is table-driven and additive: each ACP harness id maps to the
 * provider-credential vars that would collide with its native auth. An
 * unrecognized harness gets every known provider credential stripped (no
 * external harness should inherit the gateway's creds); the `openclaw` bridge
 * is our own runtime and keeps the full environment. Operators can disable the
 * whole behavior with `acp.scrubProviderEnv: false`.
 */
export const ACP_HARNESS_PROVIDER_AUTH_ENV_VARS: Record<string, readonly string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["OPENAI_API_KEY", "OPENAI_AUTH_TOKEN"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_AUTH_TOKEN"],
  cursor: ["CURSOR_API_KEY"],
  opencode: ["OPENROUTER_API_KEY"],
  // GitHub Copilot and Factory's droid authenticate through their own logins;
  // they never need the gateway's model-provider creds.
  copilot: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "OPENAI_AUTH_TOKEN"],
  droid: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "OPENAI_AUTH_TOKEN"],
  // Our own runtime — the OpenClaw ACP bridge legitimately uses the gateway's
  // environment, so never strip anything for it.
  openclaw: [],
};

export type AcpProviderEnvScrubOptions = {
  /**
   * When `false`, disables scrubbing entirely (maps to `acp.scrubProviderEnv:
   * false`). Defaults to enabled.
   */
  scrubProviderEnv?: boolean;
};

function normalizeAcpAgentId(agentName: string | undefined): string | undefined {
  const normalized = agentName?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function allKnownProviderAuthEnvVars(): string[] {
  const seen = new Set<string>();
  for (const [agentId, vars] of Object.entries(ACP_HARNESS_PROVIDER_AUTH_ENV_VARS)) {
    if (agentId === "openclaw") {
      continue;
    }
    for (const name of vars) {
      seen.add(name);
    }
  }
  return [...seen];
}

/**
 * Returns the provider-credential env var names to strip for an ACP harness.
 *
 * - scrubbing disabled -> `[]`
 * - `openclaw` bridge -> `[]` (our own runtime)
 * - known harness -> its mapped credential vars
 * - unknown / unspecified harness -> the union of every known provider
 *   credential (defense in depth: no external harness should inherit the
 *   gateway's creds)
 *
 * Always returns a fresh array so callers may mutate the result safely.
 */
export function resolveAcpProviderEnvScrubKeys(
  agentName: string | undefined,
  options: AcpProviderEnvScrubOptions = {},
): string[] {
  if (options.scrubProviderEnv === false) {
    return [];
  }
  const agentId = normalizeAcpAgentId(agentName);
  if (agentId && Object.hasOwn(ACP_HARNESS_PROVIDER_AUTH_ENV_VARS, agentId)) {
    return [...ACP_HARNESS_PROVIDER_AUTH_ENV_VARS[agentId]];
  }
  return allKnownProviderAuthEnvVars();
}
