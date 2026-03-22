---
title: "Provider Plugin SDK"
sidebarTitle: "Provider Plugins"
summary: "Contracts and helper subpaths for model-provider plugins, including auth, onboarding, catalogs, and usage"
read_when:
  - You are building a model provider plugin
  - You need auth helpers for API keys or OAuth
  - You need onboarding config patches or catalog helpers
---

# Provider Plugin SDK

Provider plugins use `definePluginEntry(...)` and call `api.registerProvider(...)`
with a `ProviderPlugin` definition.

## Minimal provider entry

```ts
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "example-provider",
  name: "Example Provider",
  description: "Example text-inference provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: "example",
      label: "Example",
      auth: [],
    });
  },
});
```

## Provider subpaths

| Subpath                                 | Use it for                                     |
| --------------------------------------- | ---------------------------------------------- |
| `plugin-sdk/provider-auth`              | API key, OAuth, auth-profile, and PKCE helpers |
| `plugin-sdk/provider-onboard`           | Config patches after setup/auth                |
| `plugin-sdk/provider-models`            | Model-definition and catalog helpers           |
| `plugin-sdk/provider-setup`             | Shared local/self-hosted setup flows           |
| `plugin-sdk/self-hosted-provider-setup` | OpenAI-compatible self-hosted providers        |
| `plugin-sdk/provider-usage`             | Usage snapshot fetch helpers                   |

## API key auth

`createProviderApiKeyAuthMethod(...)` is the standard helper for API-key
providers:

```ts
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { applyProviderConfigWithDefaultModel } from "openclaw/plugin-sdk/provider-onboard";

const auth = [
  createProviderApiKeyAuthMethod({
    providerId: "example",
    methodId: "api-key",
    label: "Example API key",
    optionKey: "exampleApiKey",
    flagName: "--example-api-key",
    envVar: "EXAMPLE_API_KEY",
    promptMessage: "Enter Example API key",
    profileId: "example:default",
    defaultModel: "example/default",
    applyConfig: (cfg) =>
      applyProviderConfigWithDefaultModel(cfg, "example", {
        id: "default",
        name: "Default",
      }),
  }),
];
```

## OAuth auth

`buildOauthProviderAuthResult(...)` builds the standard auth result payload for
OAuth-style providers:

```ts
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth";

async function runOAuthLogin() {
  return buildOauthProviderAuthResult({
    providerId: "example-portal",
    defaultModel: "example-portal/default",
    access: "access-token",
    refresh: "refresh-token",
    email: "user@example.com",
    notes: ["Tokens auto-refresh when the provider supports refresh tokens."],
  });
}
```

## Catalog and discovery hooks

Provider plugins usually implement either `catalog` or the legacy `discovery`
alias. `catalog` is preferred.

```ts
api.registerProvider({
  id: "example",
  label: "Example",
  auth,
  catalog: {
    order: "simple",
    async run(ctx) {
      const apiKey = ctx.resolveProviderApiKey("example").apiKey;
      if (!apiKey) {
        return null;
      }
      return {
        provider: {
          api: "openai",
          baseUrl: "https://api.example.com/v1",
          apiKey,
          models: [
            {
              id: "default",
              name: "Default",
              input: ["text"],
            },
          ],
        },
      };
    },
  },
});
```

## Onboarding config patches

`plugin-sdk/provider-onboard` keeps post-auth config writes consistent.

Common helpers:

- `applyProviderConfigWithDefaultModel(...)`
- `applyProviderConfigWithDefaultModels(...)`
- `applyProviderConfigWithModelCatalog(...)`
- `applyAgentDefaultModelPrimary(...)`
- `ensureModelAllowlistEntry(...)`

## Self-hosted and local model setup

Use `plugin-sdk/provider-setup` or
`plugin-sdk/self-hosted-provider-setup` when the provider is an OpenAI-style
backend, Ollama, SGLang, or vLLM.

Examples from the shared setup surfaces:

- `promptAndConfigureOllama(...)`
- `configureOllamaNonInteractive(...)`
- `promptAndConfigureOpenAICompatibleSelfHostedProvider(...)`
- `discoverOpenAICompatibleSelfHostedProvider(...)`

These helpers keep setup behavior aligned with built-in provider flows.

## Usage snapshots

If the provider owns quota or usage endpoints, use `resolveUsageAuth(...)` and
`fetchUsageSnapshot(...)`.

`plugin-sdk/provider-usage` includes shared fetch helpers such as:

- `fetchClaudeUsage(...)`
- `fetchCodexUsage(...)`
- `fetchGeminiUsage(...)`
- `fetchMinimaxUsage(...)`
- `fetchZaiUsage(...)`

## Provider guidance

- Keep auth logic in `provider-auth`.
- Keep config mutation in `provider-onboard`.
- Keep catalog/model helpers in `provider-models`.
- Keep usage logic in `provider-usage`.
- Use `catalog`, not `discovery`, in new plugins.

## Related

- [Plugin SDK Overview](/plugins/sdk-overview)
- [Plugin Entry Points](/plugins/sdk-entrypoints)
- [Plugin Setup](/plugins/sdk-setup)
- [Plugin Internals](/plugins/architecture#provider-runtime-hooks)
