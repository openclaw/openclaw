// Anthropic Doctor contract. Claude CLI sign-in before the `anthropic/*` runtime
// entry pinned only the Claude IDs it seeded, and native Claude CLI login leaves
// no Anthropic credential, so every other Claude ID failed with a missing API key.
// Doctor adds the entry current sign-in writes; runtime reads only that entry.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeAnthropicProviderId, parseAnthropicModelRef } from "./claude-model-refs.js";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_PROFILE_ID } from "./cli-constants.js";

const CLAUDE_CLI_WILDCARD_REF = "anthropic/*";

// An Anthropic credential means IDs outside the sign-in allowlist already run on
// the HTTP route, so adding the wildcard would move them to Claude CLI.
function hasAnthropicCredential(cfg: OpenClawConfig): boolean {
  if (
    Object.values(cfg.auth?.profiles ?? {}).some(
      (profile) => normalizeAnthropicProviderId(profile.provider) === "anthropic",
    )
  ) {
    return true;
  }
  return ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"].some((key) => {
    const value = process.env[key] || cfg.env?.vars?.[key] || cfg.env?.[key];
    return typeof value === "string" && value.trim() !== "";
  });
}

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const models = cfg.agents?.defaults?.models ?? {};
  if (
    Object.keys(models).some((ref) => {
      const parsed = parseAnthropicModelRef(ref);
      return parsed?.explicitProvider && parsed.provider === "anthropic" && parsed.model === "*";
    })
  ) {
    // Never replace an authored wildcard, whichever runtime it names.
    return { config: cfg, changes: [] };
  }
  // Sign-in selects a Claude CLI-pinned default model. An API default with a
  // Claude CLI fallback (docs/gateway/cli-backends.md) must keep its HTTP route,
  // wherever its credential is stored.
  const model = cfg.agents?.defaults?.model;
  const primary = typeof model === "string" ? model : model?.primary;
  const parsedPrimary = primary ? parseAnthropicModelRef(primary) : null;
  const primaryEntry = primary ? models[primary] : undefined;
  const primaryRuntime = isRecord(primaryEntry?.agentRuntime)
    ? primaryEntry.agentRuntime.id
    : undefined;
  const anthropicProviders = Object.entries(cfg.models?.providers ?? {}).filter(
    ([provider]) => normalizeAnthropicProviderId(provider) === "anthropic",
  );
  if (
    !parsedPrimary?.explicitProvider ||
    parsedPrimary.provider !== "anthropic" ||
    normalizeLowercaseStringOrEmpty(primaryRuntime) !== CLAUDE_CLI_BACKEND_ID ||
    // The wildcard outranks a provider-level runtime; an API key is a credential.
    anthropicProviders.some(
      ([, entry]) =>
        entry.agentRuntime !== undefined ||
        (entry.apiKey !== undefined && entry.apiKey !== CLAUDE_CLI_PROFILE_ID),
    ) ||
    hasAnthropicCredential(cfg)
  ) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          models: {
            ...models,
            [CLAUDE_CLI_WILDCARD_REF]: { agentRuntime: { id: CLAUDE_CLI_BACKEND_ID } },
          },
        },
      },
    },
    changes: [
      `agents.defaults.models["${CLAUDE_CLI_WILDCARD_REF}"]: added the ${CLAUDE_CLI_BACKEND_ID} runtime so Claude models not seeded at Claude CLI sign-in run through Claude Code instead of failing without an Anthropic API key.`,
    ],
  };
}
