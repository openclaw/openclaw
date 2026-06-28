/**
 * Claude CLI provider discovery descriptor. It exposes subscription-backed
 * synthetic auth for catalog/runtime discovery without full Anthropic registration.
 */
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  CLAUDE_CLI_API_KEY_HELPER_MARKER,
  hasClaudeCliApiKeyHelper,
  readClaudeCliCredentialsForRuntime,
} from "./cli-auth-seam.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

function resolveClaudeCliSyntheticAuth() {
  const credential = readClaudeCliCredentialsForRuntime();
  if (credential) {
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
  // apiKeyHelper in ~/.claude/settings.json means Claude CLI fetches the key at
  // spawn time — the gate just needs to know auth is configured.
  if (hasClaudeCliApiKeyHelper()) {
    return {
      apiKey: CLAUDE_CLI_API_KEY_HELPER_MARKER,
      source: "Claude CLI apiKeyHelper",
      mode: "api-key" as const,
    };
  }
  return undefined;
}

const anthropicProviderDiscovery: ProviderPlugin = {
  id: CLAUDE_CLI_BACKEND_ID,
  label: "Claude CLI",
  docsPath: "/providers/models",
  auth: [],
  resolveSyntheticAuth: ({ provider }) =>
    provider === CLAUDE_CLI_BACKEND_ID ? resolveClaudeCliSyntheticAuth() : undefined,
};

export default anthropicProviderDiscovery;
