import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAuthProfileOrder, type AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { expect, it } from "vitest";
import { runAnthropicSetupTokenAuth } from "./auth.runtime.js";

const token = `sk-ant-oat01-${"synthetic".repeat(12)}`;
const apiKey = { provider: "anthropic", mode: "api_key" } as const;

it.each([
  { occupied: false, expected: "anthropic:setup-token" },
  { occupied: true, expected: "anthropic:setup-token-2" },
])(
  "keeps API-key profiles usable when setup-token slots are occupied: $occupied",
  async ({ occupied, expected }) => {
    const config: ProviderAuthContext["config"] = {
      auth: {
        profiles: {
          "anthropic:default": apiKey,
          ...(occupied ? { "anthropic:setup-token": apiKey } : {}),
        },
      },
    };
    const original = structuredClone(config);
    const result = await runAnthropicSetupTokenAuth(
      {
        config,
        opts: { token },
        runtime: createRuntimeEnv(),
        prompter: createTestWizardPrompter(),
        agentDir: "/unused/agent",
        workspaceDir: "/unused/workspace",
        isRemote: false,
        openUrl: async () => {},
        oauth: {
          createVpsAwareHandlers: () => {
            throw new Error("unexpected OAuth redirect");
          },
        },
      },
      "anthropic/claude-opus-5-5",
    );
    const saved = result.profiles[0];
    if (!saved) {
      throw new Error("setup-token login returned no credential");
    }
    expect(saved.profileId).toBe(expected);
    expect(config).toEqual(original);
    expect(result.configPatch).toBeUndefined();
    const keyStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "synthetic-key" },
      },
    };
    const tokenStore: AuthProfileStore = {
      version: 1,
      profiles: { [saved.profileId]: saved.credential },
    };
    expect(
      resolveAuthProfileOrder({ cfg: config, store: keyStore, provider: "anthropic" }),
    ).toEqual(["anthropic:default"]);
    expect(
      resolveAuthProfileOrder({ cfg: config, store: tokenStore, provider: "anthropic" }),
    ).toEqual([expected]);
  },
);
