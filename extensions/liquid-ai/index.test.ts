import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import liquid from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("Liquid provider setup", () => {
  it.each([undefined, "other/existing"])(
    "never selects or replaces chat primary %s",
    async (primary) => {
      const provider = await registerSingleProviderPlugin(liquid);
      expect(provider).toMatchObject({ id: "liquid-ai", envVars: ["LIQUIDAI_API_KEY"] });
      expect(provider.catalog).toBeUndefined();
      expect(provider.auth).toHaveLength(1);
      const method = provider.auth[0]!;
      const config: OpenClawConfig = {
        ...(primary ? { agents: { defaults: { model: { primary } } } } : {}),
        auth: { profiles: { "liquid:manual": { provider: "liquid", mode: "api_key" } } },
        models: {
          providers: {
            liquid: {
              baseUrl: "https://router.inference.ai.exchange/v1",
              api: "openai-completions",
              models: [],
            },
          },
        },
      };
      const before = structuredClone(config);
      const resolveApiKey = vi.fn(async () => ({
        key: "synthetic-existing-key",
        source: "profile" as const,
      }));
      const toApiKeyCredential = vi.fn();
      const result = await method.runNonInteractive?.({
        authChoice: "liquid-ai-api-key",
        config,
        baseConfig: config,
        opts: {},
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        resolveApiKey,
        toApiKeyCredential,
      });
      expect(result?.agents).toEqual(config.agents);
      expect(result?.models).toEqual(config.models);
      expect(result?.auth?.profiles?.["liquid:manual"]).toEqual(
        config.auth?.profiles?.["liquid:manual"],
      );
      expect(config).toEqual(before);
      expect(result?.auth?.profiles?.["liquid-ai:default"]).toMatchObject({
        provider: "liquid-ai",
        mode: "api_key",
      });
      expect(resolveApiKey).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "liquid-ai",
          envVar: "LIQUIDAI_API_KEY",
          flagName: "--liquid-ai-api-key",
        }),
      );
      expect(toApiKeyCredential).not.toHaveBeenCalled();
      expect(method.starterModel).toBeUndefined();
      expect(manifest.providerAuthChoices).toContainEqual(
        expect.objectContaining({
          provider: "liquid-ai",
          method: method.id,
          credentialOnly: true,
          appGuidedSecret: true,
        }),
      );
    },
  );
});
