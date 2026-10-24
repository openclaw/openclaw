import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import {
  capturePluginRegistration,
  createNonExitingRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

function provider() {
  const captured = capturePluginRegistration(plugin);
  const selected = captured.providers.find((entry) => entry.id === "cloudflare-workers-ai");
  if (!selected) {
    throw new Error("Expected Workers AI provider");
  }
  return selected;
}

const method = () => provider().auth[0]!;

describe("Cloudflare Workers AI setup", () => {
  it("restores the declared Decision capabilities for a configured native row", async () => {
    const baseUrl = "https://api.cloudflare.com/client/v4/accounts/synthetic-account/ai";
    const projected = await provider().augmentModelCatalog!({
      config: { models: { providers: { "cloudflare-workers-ai": { baseUrl, models: [] } } } },
      entries: [
        {
          provider: "cloudflare-workers-ai",
          id: "@cf/cloudflare/clef",
          name: "Configured Clef",
          inference: { chat: false },
        },
      ],
      env: {},
    });
    expect(projected?.[0]).toMatchObject({
      name: "Configured Clef",
      baseUrl,
      inference: manifest.modelCatalog.providers["cloudflare-workers-ai"].models[0]!.inference,
    });
    expect(projected?.[0]?.api).toBeUndefined();
  });

  it.each([
    ["https://api.cloudflare.com/client/v4/accounts/synthetic-account/ai", true],
    ["https://api.cloudflare.com/client/v4/accounts/synthetic-account/ai/", true],
    ["https://proxy.example.test/workers", false],
    ["https://api.cloudflare.com.example.test/client/v4/accounts/account/ai", false],
    ["https://api.cloudflare.com/client/v4/accounts/account/ai?route=custom", false],
  ])("binds route %s before auth and scopes hosted pricing", async (baseUrl, native) => {
    const entries: Parameters<NonNullable<ProviderPlugin["augmentModelCatalog"]>>[0]["entries"] = [
      {
        provider: "cloudflare-workers-ai",
        id: "@cf/cloudflare/clef",
        name: "Cloudflare Clef",
        inference: {
          chat: false,
          decision: {
            protocol: "cloudflare-systemone",
            input: ["text"],
            questions: { boolean: { probabilities: "boolean", abstention: false } },
            billing: {
              unit: "tokens",
              source: "provider-docs",
              usdPerMillion: { input: 0.24, output: 0 },
            },
          },
        },
      },
    ];
    const before = structuredClone(entries);
    const projected = await provider().augmentModelCatalog!({
      config: { models: { providers: { "cloudflare-workers-ai": { baseUrl, models: [] } } } },
      entries,
      env: {},
    });
    expect(projected).toEqual([
      {
        ...before[0],
        baseUrl,
        inference: {
          chat: false,
          decision: native
            ? before[0]!.inference!.decision
            : {
                protocol: "cloudflare-systemone",
                input: ["text"],
                questions: { boolean: { probabilities: "boolean", abstention: false } },
              },
        },
      },
    ]);
    expect(entries).toEqual(before);
  });

  it.each(["plaintext", "ref"] as const)(
    "collects the account and %s credential without selecting a chat model",
    async (mode) => {
      const text = vi
        .fn(async () => "CLOUDFLARE_WORKERS_AI_API_TOKEN")
        .mockResolvedValueOnce("synthetic-account");
      const result = await method().run({
        config: { agents: { defaults: { model: { primary: "other/chat" } } } },
        env: { CLOUDFLARE_WORKERS_AI_API_TOKEN: "synthetic-workers-token" },
        opts:
          mode === "plaintext" ? { cloudflareWorkersAiApiToken: "synthetic-workers-token" } : {},
        prompter: createTestWizardPrompter({ text }),
        runtime: createNonExitingRuntimeEnv(),
        secretInputMode: mode,
        isRemote: false,
        openUrl: vi.fn(async () => {}),
        oauth: { createVpsAwareHandlers: vi.fn() },
      });
      expect(text).toHaveBeenCalledTimes(mode === "plaintext" ? 1 : 2);
      expect(result.profiles).toEqual([
        {
          profileId: "cloudflare-workers-ai:default",
          credential: {
            type: "api_key",
            provider: "cloudflare-workers-ai",
            ...(mode === "plaintext"
              ? { key: "synthetic-workers-token" }
              : {
                  keyRef: {
                    source: "env",
                    provider: "default",
                    id: "CLOUDFLARE_WORKERS_AI_API_TOKEN",
                  },
                }),
          },
        },
      ]);
      expect(result.defaultModel).toBeUndefined();
      expect(result.configPatch?.models?.providers?.["cloudflare-workers-ai"]).toEqual({
        baseUrl: "https://api.cloudflare.com/client/v4/accounts/synthetic-account/ai",
        models: [],
      });
      expect(result.configPatch?.agents?.defaults?.model).toEqual({ primary: "other/chat" });
    },
  );
  it("registers a Decision-only identity without changing Gateway chat", () => {
    const captured = capturePluginRegistration(plugin);
    expect(captured.providers.map((entry) => entry.id)).toEqual([
      "cloudflare-ai-gateway",
      "cloudflare-workers-ai",
    ]);
    expect(captured.providers[0]?.wrapStreamFn).toBeTypeOf("function");
    expect(captured.providers[1]?.wrapStreamFn).toBeUndefined();
    expect(method().starterModel).toBeUndefined();
  });

  it.each([undefined, "other/chat"])(
    "keeps chat primary %s and uses only Workers AI credentials",
    async (primary) => {
      const config: OpenClawConfig = {
        agents: primary ? { defaults: { model: { primary } } } : undefined,
        models: {
          providers: {
            "cloudflare-ai-gateway": {
              baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
              apiKey: "synthetic-anthropic-key",
              models: [],
            },
          },
        },
      };
      const before = structuredClone(config);
      const resolveApiKey = vi.fn(async () => ({
        key: "synthetic-workers-token",
        source: "profile" as const,
      }));
      const toApiKeyCredential = vi.fn();
      const result = await method().runNonInteractive!({
        authChoice: "cloudflare-workers-ai-api-token",
        config,
        baseConfig: config,
        opts: { cloudflareAiGatewayAccountId: "synthetic-account" },
        runtime: createNonExitingRuntimeEnv(),
        resolveApiKey,
        toApiKeyCredential,
      });
      expect(config).toEqual(before);
      expect(result?.agents).toEqual(config.agents);
      expect(result?.models?.providers?.["cloudflare-ai-gateway"]).toEqual(
        config.models?.providers?.["cloudflare-ai-gateway"],
      );
      expect(result?.models?.providers?.["cloudflare-workers-ai"]).toEqual({
        baseUrl: "https://api.cloudflare.com/client/v4/accounts/synthetic-account/ai",
        models: [],
      });
      expect(result?.auth?.profiles?.["cloudflare-workers-ai:default"]).toEqual({
        provider: "cloudflare-workers-ai",
        mode: "api_key",
      });
      expect(resolveApiKey).toHaveBeenCalledExactlyOnceWith({
        provider: "cloudflare-workers-ai",
        flagValue: undefined,
        flagName: "--cloudflare-workers-ai-api-token",
        envVar: "CLOUDFLARE_WORKERS_AI_API_TOKEN",
      });
      expect(toApiKeyCredential).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing account before credential resolution, including validation", async () => {
    const resolveApiKey = vi.fn(async () => null);
    const ctx = {
      authChoice: "cloudflare-workers-ai-api-token",
      config: {},
      baseConfig: {},
      opts: {},
      runtime: createNonExitingRuntimeEnv(),
      resolveApiKey,
      toApiKeyCredential: vi.fn(),
    };
    await expect(method().validateNonInteractive!(ctx)).rejects.toThrow(
      "requires --cloudflare-ai-gateway-account-id",
    );
    await expect(method().runNonInteractive!(ctx)).rejects.toThrow(
      "requires --cloudflare-ai-gateway-account-id",
    );
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it("preserves a configured proxy endpoint, headers and model rows on reconnect", async () => {
    const providerConfig = {
      baseUrl: "https://proxy.example.test/workers",
      models: [],
      headers: { "cf-aig-gateway-id": "synthetic-gateway" },
      request: { proxy: { mode: "env-proxy" as const } },
    };
    const config: OpenClawConfig = {
      models: { providers: { "cloudflare-workers-ai": providerConfig } },
    };
    const result = await method().runNonInteractive!({
      authChoice: "cloudflare-workers-ai-api-token",
      config,
      baseConfig: config,
      opts: {},
      runtime: createNonExitingRuntimeEnv(),
      resolveApiKey: async () => ({ key: "synthetic-workers-token", source: "profile" }),
      toApiKeyCredential: vi.fn(),
    });
    expect(result?.models?.providers?.["cloudflare-workers-ai"]).toEqual(providerConfig);
  });
});
