// Qa Lab plugin module implements mock auth behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { applyAuthProfileConfig } from "openclaw/plugin-sdk/provider-auth-api-key";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { writeQaAuthProfiles } from "./auth-store.js";

/** Providers the mock harness stages placeholder credentials for by default. */
const QA_MOCK_AUTH_PROVIDERS = Object.freeze(["openai", "anthropic"] as const);

/** Agent IDs the mock harness stages credentials under. */
const QA_MOCK_AUTH_AGENT_IDS = Object.freeze(["main", "qa"] as const);

export function buildQaMockProfileId(provider: string): string {
  return `qa-mock-${provider}`;
}

export function applyQaMockAuthProfileConfig(params: {
  cfg: OpenClawConfig;
  providers?: readonly string[];
}): OpenClawConfig {
  let next = params.cfg;
  for (const provider of uniqueStrings(params.providers ?? QA_MOCK_AUTH_PROVIDERS)) {
    next = applyAuthProfileConfig(next, {
      profileId: buildQaMockProfileId(provider),
      provider,
      mode: "api_key",
      displayName: `QA mock ${provider} credential`,
    });
  }
  return next;
}

// The runtime requires matching API-key profiles even though the mock accepts any
// credential. Stage them in each isolated agent store before the first request;
// the placeholder deliberately cannot be mistaken for a real provider key.
export async function stageQaMockAuthProfiles(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  agentIds?: readonly string[];
  providers?: readonly string[];
}): Promise<OpenClawConfig> {
  const agentIds = uniqueStrings(params.agentIds ?? QA_MOCK_AUTH_AGENT_IDS);
  const providers = uniqueStrings(params.providers ?? QA_MOCK_AUTH_PROVIDERS);
  for (const agentId of agentIds) {
    await writeQaAuthProfiles({
      agentId,
      profiles: Object.fromEntries(
        providers.map((provider) => [
          buildQaMockProfileId(provider),
          {
            type: "api_key",
            provider,
            key: "qa-mock-not-a-real-key",
            displayName: `QA mock ${provider} credential`,
          },
        ]),
      ),
      stateDir: params.stateDir,
    });
  }
  return applyQaMockAuthProfileConfig({ cfg: params.cfg, providers });
}
