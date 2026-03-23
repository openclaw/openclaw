---
title: "Building Provider Plugins"
sidebarTitle: "Provider Plugins"
summary: "Step-by-step guide to building a model provider plugin for OpenClaw"
read_when:
  - You are building a new model provider plugin
  - You want to add an OpenAI-compatible proxy or custom LLM to OpenClaw
  - You need to understand provider auth, catalogs, and runtime hooks
---

# Building Provider Plugins

This guide walks through building a provider plugin that adds a model provider
(LLM) to OpenClaw. By the end you will have a provider with a model catalog,
API key auth, and dynamic model resolution.

<Info>
  If you have not built any OpenClaw plugin before, read
  [Getting Started](/plugins/building-plugins) first for the basic package
  structure and manifest setup.
</Info>

## Walkthrough

<Steps>
  <Step title="Package and manifest">
    <CodeGroup>
    ```json package.json
    {
      "name": "@myorg/openclaw-acme-ai",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "providers": ["acme-ai"]
      }
    }
    ```

    ```json openclaw.plugin.json
    {
      "id": "acme-ai",
      "name": "Acme AI",
      "description": "Acme AI model provider",
      "providers": ["acme-ai"],
      "providerAuthEnvVars": {
        "acme-ai": ["ACME_AI_API_KEY"]
      },
      "providerAuthChoices": [
        {
          "provider": "acme-ai",
          "method": "api-key",
          "choiceId": "acme-ai-api-key",
          "choiceLabel": "Acme AI API key",
          "groupId": "acme-ai",
          "groupLabel": "Acme AI",
          "cliFlag": "--acme-ai-api-key",
          "cliOption": "--acme-ai-api-key <key>",
          "cliDescription": "Acme AI API key"
        }
      ],
      "configSchema": {
        "type": "object",
        "additionalProperties": false
      }
    }
    ```
    </CodeGroup>

    The manifest declares `providerAuthEnvVars` so OpenClaw can detect
    credentials without loading your plugin runtime.

  </Step>

  <Step title="Register the provider">
    A minimal provider needs an `id`, `label`, `auth`, and `catalog`:

    ```typescript index.ts
    import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
    import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";

    export default definePluginEntry({
      id: "acme-ai",
      name: "Acme AI",
      description: "Acme AI model provider",
      register(api) {
        api.registerProvider({
          id: "acme-ai",
          label: "Acme AI",
          docsPath: "/providers/acme-ai",
          envVars: ["ACME_AI_API_KEY"],

          auth: [
            createProviderApiKeyAuthMethod({
              providerId: "acme-ai",
              methodId: "api-key",
              label: "Acme AI API key",
              hint: "API key from your Acme AI dashboard",
              optionKey: "acmeAiApiKey",
              flagName: "--acme-ai-api-key",
              envVar: "ACME_AI_API_KEY",
              promptMessage: "Enter your Acme AI API key",
              defaultModel: "acme-ai/acme-large",
            }),
          ],

          catalog: {
            order: "simple",
            run: async (ctx) => {
              const apiKey =
                ctx.resolveProviderApiKey("acme-ai").apiKey;
              if (!apiKey) return null;
              return {
                provider: {
                  baseUrl: "https://api.acme-ai.com/v1",
                  apiKey,
                  api: "openai-completions",
                  models: [
                    {
                      id: "acme-large",
                      name: "Acme Large",
                      reasoning: true,
                      input: ["text", "image"],
                      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                      contextWindow: 200000,
                      maxTokens: 32768,
                    },
                    {
                      id: "acme-small",
                      name: "Acme Small",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
                      contextWindow: 128000,
                      maxTokens: 8192,
                    },
                  ],
                },
              };
            },
          },
        });
      },
    });
    ```

    That is a working provider. Users can now
    `openclaw onboard --acme-ai-api-key <key>` and select
    `acme-ai/acme-large` as their model.

    For bundled providers that only register one text provider with API-key
    auth plus a single catalog-backed runtime, prefer the narrower
    `defineSingleProviderPluginEntry(...)` helper:

    ```typescript
    import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";

    export default defineSingleProviderPluginEntry({
      id: "acme-ai",
      name: "Acme AI",
      description: "Acme AI model provider",
      provider: {
        label: "Acme AI",
        docsPath: "/providers/acme-ai",
        auth: [
          {
            methodId: "api-key",
            label: "Acme AI API key",
            hint: "API key from your Acme AI dashboard",
            optionKey: "acmeAiApiKey",
            flagName: "--acme-ai-api-key",
            envVar: "ACME_AI_API_KEY",
            promptMessage: "Enter your Acme AI API key",
            defaultModel: "acme-ai/acme-large",
          },
        ],
        catalog: {
          buildProvider: () => ({
            api: "openai-completions",
            baseUrl: "https://api.acme-ai.com/v1",
            models: [{ id: "acme-large", name: "Acme Large" }],
          }),
        },
      },
    });
    ```

    If your auth flow also needs to patch `models.providers.*`, aliases, and
    the agent default model during onboarding, use the preset helpers from
    `openclaw/plugin-sdk/provider-onboard`. The narrowest helpers are
    `createDefaultModelPresetAppliers(...)`,
    `createDefaultModelsPresetAppliers(...)`, and
    `createModelCatalogPresetAppliers(...)`.

  </Step>

  <Step title="Add dynamic model resolution">
    If your provider accepts arbitrary model IDs (like a proxy or router),
    add `resolveDynamicModel`:

    ```typescript
    api.registerProvider({
      // ... id, label, auth, catalog from above

      resolveDynamicModel: (ctx) => ({
        id: ctx.modelId,
        name: ctx.modelId,
        provider: "acme-ai",
        api: "openai-completions",
        baseUrl: "https://api.acme-ai.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      }),
    });
    ```

    If resolving requires a network call, use `prepareDynamicModel` for async
    warm-up — `resolveDynamicModel` runs again after it completes.

  </Step>

  <Step title="Add runtime hooks (as needed)">
    Most providers only need `catalog` + `resolveDynamicModel`. Add hooks
    incrementally as your provider requires them.

    <Tabs>
      <Tab title="Token exchange">
        For providers that need a token exchange before each inference call:

        ```typescript
        prepareRuntimeAuth: async (ctx) => {
          const exchanged = await exchangeToken(ctx.apiKey);
          return {
            apiKey: exchanged.token,
            baseUrl: exchanged.baseUrl,
            expiresAt: exchanged.expiresAt,
          };
        },
        ```
      </Tab>
      <Tab title="Custom headers">
        For providers that need custom request headers or body modifications:

        ```typescript
        // wrapStreamFn returns a StreamFn derived from ctx.streamFn
        wrapStreamFn: (ctx) => {
          if (!ctx.streamFn) return undefined;
          const inner = ctx.streamFn;
          return async (params) => {
            params.headers = {
              ...params.headers,
              "X-Acme-Version": "2",
            };
            return inner(params);
          };
        },
        ```
      </Tab>
      <Tab title="Usage and billing">
        For providers that expose usage/billing data:

        ```typescript
        resolveUsageAuth: async (ctx) => {
          const auth = await ctx.resolveOAuthToken();
          return auth ? { token: auth.token } : null;
        },
        fetchUsageSnapshot: async (ctx) => {
          return await fetchAcmeUsage(ctx.token, ctx.timeoutMs);
        },
        ```
      </Tab>
    </Tabs>

    <Accordion title="All 21 available hooks">
      OpenClaw calls hooks in this order. Most providers only use 2-3:

      | # | Hook | When to use |
      | --- | --- | --- |
      | 1 | `catalog` | Model catalog or base URL defaults |
      | 2 | `resolveDynamicModel` | Accept arbitrary upstream model IDs |
      | 3 | `prepareDynamicModel` | Async metadata fetch before resolving |
      | 4 | `normalizeResolvedModel` | Transport rewrites before the runner |
      | 5 | `capabilities` | Transcript/tooling metadata |
      | 6 | `prepareExtraParams` | Default request params |
      | 7 | `wrapStreamFn` | Custom headers/body wrappers |
      | 8 | `formatApiKey` | Custom runtime token shape |
      | 9 | `refreshOAuth` | Custom OAuth refresh |
      | 10 | `buildAuthDoctorHint` | Auth repair guidance |
      | 11 | `isCacheTtlEligible` | Prompt cache TTL gating |
      | 12 | `buildMissingAuthMessage` | Custom missing-auth hint |
      | 13 | `suppressBuiltInModel` | Hide stale upstream rows |
      | 14 | `augmentModelCatalog` | Synthetic forward-compat rows |
      | 15 | `isBinaryThinking` | Binary thinking on/off |
      | 16 | `supportsXHighThinking` | `xhigh` reasoning support |
      | 17 | `resolveDefaultThinkingLevel` | Default `/think` policy |
      | 18 | `isModernModelRef` | Live/smoke model matching |
      | 19 | `prepareRuntimeAuth` | Token exchange before inference |
      | 20 | `resolveUsageAuth` | Custom usage credential parsing |
      | 21 | `fetchUsageSnapshot` | Custom usage endpoint |

      For detailed descriptions and real-world examples, see
      [Internals: Provider Runtime Hooks](/plugins/architecture#provider-runtime-hooks).
    </Accordion>

  </Step>

  <Step title="Add extra capabilities (optional)">
    A provider plugin can register speech, media understanding, image
    generation, and web search alongside text inference:

    ```typescript
    register(api) {
      api.registerProvider({ id: "acme-ai", /* ... */ });

      api.registerSpeechProvider({
        id: "acme-ai",
        label: "Acme Speech",
        isConfigured: ({ config }) => Boolean(config.messages?.tts),
        synthesize: async (req) => ({
          audioBuffer: Buffer.from(/* PCM data */),
          outputFormat: "mp3",
          fileExtension: ".mp3",
          voiceCompatible: false,
        }),
      });

      api.registerMediaUnderstandingProvider({
        id: "acme-ai",
        capabilities: ["image", "audio"],
        describeImage: async (req) => ({ text: "A photo of..." }),
        transcribeAudio: async (req) => ({ text: "Transcript..." }),
      });

      api.registerImageGenerationProvider({
        id: "acme-ai",
        label: "Acme Images",
        generate: async (req) => ({ /* image result */ }),
      });
    }
    ```

    OpenClaw classifies this as a **hybrid-capability** plugin. This is the
    recommended pattern for company plugins (one plugin per vendor). See
    [Internals: Capability Ownership](/plugins/architecture#capability-ownership-model).

  </Step>

  <Step title="Test">
    ```typescript src/provider.test.ts
    import { describe, it, expect } from "vitest";
    // Export your provider config object from index.ts or a dedicated file
    import { acmeProvider } from "./provider.js";

    describe("acme-ai provider", () => {
      it("resolves dynamic models", () => {
        const model = acmeProvider.resolveDynamicModel!({
          modelId: "acme-beta-v3",
        } as any);
        expect(model.id).toBe("acme-beta-v3");
        expect(model.provider).toBe("acme-ai");
      });

      it("returns catalog when key is available", async () => {
        const result = await acmeProvider.catalog!.run({
          resolveProviderApiKey: () => ({ apiKey: "test-key" }),
        } as any);
        expect(result?.provider?.models).toHaveLength(2);
      });

      it("returns null catalog when no key", async () => {
        const result = await acmeProvider.catalog!.run({
          resolveProviderApiKey: () => ({ apiKey: undefined }),
        } as any);
        expect(result).toBeNull();
      });
    });
    ```

  </Step>
</Steps>

## File structure

```
extensions/acme-ai/
├── package.json              # openclaw.providers metadata
├── openclaw.plugin.json      # Manifest with providerAuthEnvVars
├── index.ts                  # definePluginEntry + registerProvider
└── src/
    ├── provider.test.ts      # Tests
    └── usage.ts              # Usage endpoint (optional)
```

## Catalog order reference

`catalog.order` controls when your catalog merges relative to built-in
providers:

| Order     | When          | Use case                                        |
| --------- | ------------- | ----------------------------------------------- |
| `simple`  | First pass    | Plain API-key providers                         |
| `profile` | After simple  | Providers gated on auth profiles                |
| `paired`  | After profile | Synthesize multiple related entries             |
| `late`    | Last pass     | Override existing providers (wins on collision) |

## Next steps

- [Channel Plugins](/plugins/sdk-channel-plugins) — if your plugin also provides a channel
- [SDK Runtime](/plugins/sdk-runtime) — `api.runtime` helpers (TTS, search, subagent)
- [SDK Overview](/plugins/sdk-overview) — full subpath import reference
- [Plugin Internals](/plugins/architecture#provider-runtime-hooks) — hook details and bundled examples
