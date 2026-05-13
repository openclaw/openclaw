import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { readClaudeCliCredentialsForRuntime } from "./cli-auth-seam.js";
import { buildClaudeCliProviderCatalog } from "./cli-catalog.js";
import { CLAUDE_CLI_BACKEND_ID } from "./cli-constants.js";

function resolveClaudeCliSyntheticAuth() {
  const credential = readClaudeCliCredentialsForRuntime();
  if (!credential) {
    return undefined;
  }
  return credential.type === "oauth"
    ? {
        apiKey: credential.access,
        source: "Claude CLI native auth",
        mode: "oauth" as const,
        expiresAt: credential.expires,
      }
    : {
        apiKey: credential.token,
        source: "Claude CLI native auth",
        mode: "token" as const,
        expiresAt: credential.expires,
      };
}

const anthropicProviderDiscovery: ProviderPlugin = {
  id: CLAUDE_CLI_BACKEND_ID,
  label: "Claude CLI",
  docsPath: "/providers/models",
  auth: [],
  // Contribute the Claude CLI binary's supported model set via the public
  // ProviderPluginCatalog seam. Core's `/models` picker reads catalog entries
  // through this contract — keeps the CLI allowlist provider-owned and avoids
  // a direct `extensions/anthropic` import in core.
  catalog: {
    order: "simple",
    run: async () => ({ provider: buildClaudeCliProviderCatalog() }),
  },
  resolveSyntheticAuth: ({ provider }) =>
    provider === CLAUDE_CLI_BACKEND_ID ? resolveClaudeCliSyntheticAuth() : undefined,
};

export default anthropicProviderDiscovery;
