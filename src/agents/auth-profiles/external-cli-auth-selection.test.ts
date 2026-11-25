import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOAuthRefreshCredential } from "./credential-fixtures.test-support.js";
import { resolveExternalCliAuthOverlayScopeFromSelection } from "./external-cli-auth-selection.js";
import type { AuthProfileStore } from "./types.js";

// CLI backend discovery has its own contract tests; this suite owns only auth-overlay selection
// and must not cold-load every registered backend just to project one configured runtime id.
vi.mock("../model-runtime-aliases.js", () => ({
  resolveCliRuntimeExecutionProvider: vi.fn(
    (params: { cfg?: OpenClawConfig; provider?: string; modelId?: string }) => {
      const modelKey =
        params.provider && params.modelId ? `${params.provider}/${params.modelId}` : undefined;
      return modelKey
        ? params.cfg?.agents?.defaults?.models?.[modelKey]?.agentRuntime?.id
        : undefined;
    },
  ),
}));

const cliId = "anthropic:claude-cli";
const apiId = "anthropic:api";
const externalScope = { providerIds: ["claude-cli"], ignoreAutoPreferredProfile: true };
const authProfiles: NonNullable<OpenClawConfig["auth"]>["profiles"] = {
  [apiId]: { provider: "anthropic", mode: "api_key" },
  [cliId]: { provider: "claude-cli", mode: "oauth" },
};

function resolveScope(params: {
  cfg?: OpenClawConfig;
  store?: AuthProfileStore;
  userPinnedAuthProfileId?: string;
}) {
  return resolveExternalCliAuthOverlayScopeFromSelection({
    provider: "anthropic",
    modelId: "test-model",
    ...params,
  });
}

describe("resolveExternalCliAuthOverlayScopeFromSelection", () => {
  it("loads Claude CLI auth for an explicit model runtime", () => {
    const models = { "anthropic/test-model": { agentRuntime: { id: "claude-cli" } } };
    expect(resolveScope({ cfg: { agents: { defaults: { models } } } })).toEqual(externalScope);
  });

  it("honors persisted auth-store order when config has no order", () => {
    const store = {
      version: 1,
      profiles: { [cliId]: createOAuthRefreshCredential({ provider: "claude-cli" }) },
      order: { anthropic: [cliId] },
    } satisfies AuthProfileStore;

    expect(resolveScope({ store })).toEqual(externalScope);
  });

  it.each([
    [apiId, undefined, { ignoreAutoPreferredProfile: false }],
    [cliId, apiId, { providerIds: ["claude-cli"], ignoreAutoPreferredProfile: false }],
  ] as const)("resolves ordered %s auth with pin %s", (ordered, pin, expected) => {
    const cfg = {
      auth: { order: { anthropic: [ordered] }, profiles: authProfiles },
    } satisfies OpenClawConfig;
    expect(resolveScope({ cfg, userPinnedAuthProfileId: pin })).toEqual(expected);
  });
});
