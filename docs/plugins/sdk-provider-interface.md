---
title: "Provider Plugin Interface"
sidebarTitle: "Provider Interface"
summary: "Reference for the public ProviderPlugin shape and the provider-owned hooks around auth, catalogs, and runtime behavior"
read_when:
  - You want the public shape of `ProviderPlugin`
  - You need to know which provider fields are required versus optional
  - You are building a provider plugin and want a field-by-field reference
---

# Provider Plugin Interface

This page describes the public `ProviderPlugin` interface used by model
provider plugins.

If you want a step-by-step walkthrough, start with
[Provider Plugins](/plugins/sdk-provider-plugins). This page is the reference
for the interface itself.

## Import

```typescript
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-models";
```

Common supporting imports:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
```

## Required fields

These fields are the public core of a `ProviderPlugin`:

| Field   | What it does                                    |
| ------- | ----------------------------------------------- |
| `id`    | Stable provider id                              |
| `label` | Human display name                              |
| `auth`  | Auth methods used by onboarding and login flows |

In practice, most real providers also define `catalog` or
`resolveDynamicModel`, because OpenClaw needs some way to resolve models.

## Minimal shape

```typescript
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-models";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";

export const acmeProvider: ProviderPlugin = {
  id: "acme-ai",
  label: "Acme AI",
  docsPath: "/providers/acme-ai",
  envVars: ["ACME_AI_API_KEY"],

  auth: [
    createProviderApiKeyAuthMethod({
      providerId: "acme-ai",
      methodId: "api-key",
      label: "Acme AI API key",
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
      const apiKey = ctx.resolveProviderApiKey("acme-ai").apiKey;
      if (!apiKey) {
        return null;
      }

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
          ],
        },
      };
    },
  },
};
```

## Core sections

### Identity and discovery

| Field      | Meaning                                         |
| ---------- | ----------------------------------------------- |
| `id`       | Provider id used in model refs and config       |
| `label`    | User-facing provider name                       |
| `docsPath` | Docs page for the provider                      |
| `aliases`  | Alternate provider names                        |
| `envVars`  | Relevant env vars shown in setup and help flows |
| `wizard`   | Onboarding and model-picker metadata            |

### Auth

`auth` is required.

Each entry is a `ProviderAuthMethod`, usually created with helpers such as
`createProviderApiKeyAuthMethod(...)`.

Related provider-owned auth hooks:

| Field                     | Use it for                                                       |
| ------------------------- | ---------------------------------------------------------------- |
| `formatApiKey`            | Convert stored auth-profile data into the runtime API key string |
| `refreshOAuth`            | Provider-owned OAuth refresh logic                               |
| `buildAuthDoctorHint`     | Better repair guidance when auth breaks                          |
| `buildMissingAuthMessage` | Better missing-auth message for this provider                    |
| `deprecatedProfileIds`    | Retiring old provider profile ids                                |

### Catalog and model resolution

These hooks decide which models exist and how OpenClaw resolves them.

| Field                    | Use it for                                                   |
| ------------------------ | ------------------------------------------------------------ |
| `catalog`                | Preferred model catalog hook                                 |
| `discovery`              | Legacy alias for `catalog`                                   |
| `resolveDynamicModel`    | Cheap sync fallback for model ids not in the local catalog   |
| `prepareDynamicModel`    | Async prefetch before retrying `resolveDynamicModel`         |
| `normalizeResolvedModel` | Final provider-specific model normalization                  |
| `augmentModelCatalog`    | Append extra rows after base catalog merging                 |
| `suppressBuiltInModel`   | Hide stale built-in rows or surface provider-specific errors |

Prefer `catalog` for new code. `discovery` exists for compatibility.

## Runtime hooks

These hooks let the provider own runtime behavior without forking the generic
runner.

| Field                | Use it for                                                    |
| -------------------- | ------------------------------------------------------------- |
| `prepareExtraParams` | Provider-specific request params before stream wrapping       |
| `wrapStreamFn`       | Custom headers or body rewrites around the stream call        |
| `prepareRuntimeAuth` | Exchange a stored credential into a short-lived runtime token |
| `resolveUsageAuth`   | Usage/billing auth resolution                                 |
| `fetchUsageSnapshot` | Usage/quota snapshot fetching                                 |

## Policy and capability hooks

These hooks keep provider-specific policy out of core command logic.

| Field                         | Use it for                                                   |
| ----------------------------- | ------------------------------------------------------------ |
| `capabilities`                | Static capability overrides for transcript and tooling logic |
| `isCacheTtlEligible`          | Prompt-caching eligibility                                   |
| `isBinaryThinking`            | Binary on/off reasoning support                              |
| `supportsXHighThinking`       | `xhigh` reasoning support                                    |
| `resolveDefaultThinkingLevel` | Provider-owned default reasoning level                       |
| `isModernModelRef`            | Preferred modern-model matching                              |
| `onModelSelected`             | Provider reaction after model selection                      |

## Interface expectations

Keep these ids aligned:

- `openclaw.plugin.json` `id`
- `package.json` `openclaw.providers`
- `definePluginEntry({ id })`
- `ProviderPlugin.id`

Practical rules:

- `auth` should describe at least one real auth path for the provider.
- Prefer `catalog` over `discovery` for new code.
- Keep `resolveDynamicModel(...)` cheap and deterministic.
- If model resolution needs network I/O, do that in `prepareDynamicModel(...)`
  and let OpenClaw retry `resolveDynamicModel(...)`.
- Catalog and dynamic-model rows should return complete model definitions,
  including `id`, `name`, `reasoning`, `input`, `cost`, `contextWindow`, and
  `maxTokens`.
- Keep provider-specific transport, auth, and policy behavior inside the
  provider hooks instead of shared core.

## Related

- [Provider Plugins](/plugins/sdk-provider-plugins) — step-by-step provider walkthrough
- [Plugin Entry Points](/plugins/sdk-entrypoints) — `definePluginEntry(...)`
- [Plugin Runtime Helpers](/plugins/sdk-runtime) — `api.runtime` and subagent/runtime helpers
- [SDK Subpaths](/plugins/sdk-subpaths) — public import paths
- [Plugin Internals](/plugins/architecture#provider-runtime-hooks) — provider runtime ownership and deeper architecture
