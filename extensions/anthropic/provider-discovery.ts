import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  isClaudeCliBedrockAuthEnabled,
  readClaudeCliCredentialsForRuntime,
} from "./cli-auth-seam.js";

const ANTHROPIC_PROVIDER_ID = "anthropic";
const CLAUDE_CLI_BACKEND_ID = "claude-cli";
const CLAUDE_CLI_BEDROCK_AUTH_MARKER = "claude-cli-bedrock";

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

function resolveClaudeCliBedrockSyntheticAuth() {
  if (!isClaudeCliBedrockAuthEnabled()) {
    return undefined;
  }
  return {
    apiKey: CLAUDE_CLI_BEDROCK_AUTH_MARKER,
    source: "Claude CLI Bedrock auth (CLAUDE_CODE_USE_BEDROCK=1)",
    mode: "api-key" as const,
  };
}

const anthropicProviderDiscovery: ProviderPlugin = {
  id: CLAUDE_CLI_BACKEND_ID,
  label: "Claude CLI",
  docsPath: "/providers/models",
  auth: [],
  resolveSyntheticAuth: ({ provider }) => {
    if (provider === CLAUDE_CLI_BACKEND_ID) {
      return resolveClaudeCliSyntheticAuth();
    }
    // Post-2026.5.21 model refs canonicalize as `anthropic/<model>` even when
    // the agent's runtime is the Claude CLI; allow the Bedrock-via-CLI signal
    // to satisfy auth resolution for the `anthropic` provider id too.
    if (provider === ANTHROPIC_PROVIDER_ID) {
      return resolveClaudeCliBedrockSyntheticAuth();
    }
    return undefined;
  },
};

export default anthropicProviderDiscovery;
