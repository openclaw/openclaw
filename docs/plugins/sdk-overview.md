---
title: "Plugin SDK Overview"
sidebarTitle: "SDK Overview"
summary: "How the OpenClaw plugin SDK is organized, which subpaths are stable, and how to choose the right import"
read_when:
  - You are starting a new OpenClaw plugin
  - You need to choose the right plugin-sdk subpath
  - You are replacing deprecated compat imports
---

# Plugin SDK Overview

The OpenClaw plugin SDK is split into **small public subpaths** under
`openclaw/plugin-sdk/<subpath>`.

Use the narrowest import that matches the job. That keeps plugin dependencies
small, avoids circular imports, and makes it clear which contract you depend on.

## Rules first

- Use focused imports such as `openclaw/plugin-sdk/plugin-entry`.
- Do not import the root `openclaw/plugin-sdk` barrel in new code.
- Do not import `openclaw/extension-api` in new code.
- Do not import `src/**` from plugin packages.
- Inside a plugin package, route internal imports through local files such as
  `./api.ts` or `./runtime-api.ts`, not through the published SDK path for that
  same plugin.

## SDK map

| Job                          | Subpath                                                                                                                                         | Next page                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Define plugin entry modules  | `plugin-sdk/plugin-entry`, `plugin-sdk/core`                                                                                                    | [Plugin Entry Points](/plugins/sdk-entrypoints)      |
| Use injected runtime helpers | `plugin-sdk/runtime`, `plugin-sdk/runtime-store`                                                                                                | [Plugin Runtime](/plugins/sdk-runtime)               |
| Build setup/configure flows  | `plugin-sdk/setup`, `plugin-sdk/channel-setup`, `plugin-sdk/secret-input`                                                                       | [Plugin Setup](/plugins/sdk-setup)                   |
| Build channel plugins        | `plugin-sdk/core`, `plugin-sdk/channel-contract`, `plugin-sdk/channel-actions`, `plugin-sdk/channel-pairing`                                    | [Channel Plugin SDK](/plugins/sdk-channel-plugins)   |
| Build provider plugins       | `plugin-sdk/plugin-entry`, `plugin-sdk/provider-auth`, `plugin-sdk/provider-onboard`, `plugin-sdk/provider-models`, `plugin-sdk/provider-usage` | [Provider Plugin SDK](/plugins/sdk-provider-plugins) |
| Test plugin code             | `plugin-sdk/testing`                                                                                                                            | [Plugin SDK Testing](/plugins/sdk-testing)           |

## Typical plugin layout

```text
my-plugin/
├── package.json
├── openclaw.plugin.json
├── index.ts
├── setup-entry.ts
├── api.ts
├── runtime-api.ts
└── src/
    ├── provider.ts
    ├── setup.ts
    └── provider.test.ts
```

```ts
// api.ts
export {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
```

## What belongs where

### Entry helpers

- `plugin-sdk/plugin-entry` is the default entry surface for providers, tools,
  commands, services, memory plugins, and context engines.
- `plugin-sdk/core` adds channel-focused helpers such as
  `defineChannelPluginEntry(...)`.

### Runtime helpers

- Use `api.runtime.*` for trusted in-process helpers that OpenClaw injects at
  registration time.
- Use `plugin-sdk/runtime-store` when plugin modules need a mutable runtime slot
  that is initialized later.

### Setup helpers

- `plugin-sdk/setup` contains shared setup-wizard helpers and config patch
  helpers.
- `plugin-sdk/channel-setup` contains channel-specific setup adapters.
- `plugin-sdk/secret-input` exposes the shared secret-input schema helpers.

### Channel helpers

- `plugin-sdk/channel-contract` exports pure channel types.
- `plugin-sdk/channel-actions` covers shared `message` tool schema helpers.
- `plugin-sdk/channel-pairing` covers pairing approval flows.
- `plugin-sdk/webhook-ingress` covers plugin-owned webhook routes.

### Provider helpers

- `plugin-sdk/provider-auth` covers auth flows and credential helpers.
- `plugin-sdk/provider-onboard` covers config patches after auth/setup.
- `plugin-sdk/provider-models` covers catalog and model-definition helpers.
- `plugin-sdk/provider-usage` covers usage snapshot helpers.
- `plugin-sdk/provider-setup` and `plugin-sdk/self-hosted-provider-setup`
  cover self-hosted and local-model onboarding.

## Example: mixing subpaths in one plugin

```ts
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { applyProviderConfigWithDefaultModel } from "openclaw/plugin-sdk/provider-onboard";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";

export default definePluginEntry({
  id: "example-provider",
  name: "Example Provider",
  description: "Small provider plugin example",
  configSchema: {
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        apiKey: { type: "string" },
      },
    },
    safeParse(value) {
      return buildSecretInputSchema().safeParse((value as { apiKey?: unknown })?.apiKey);
    },
  },
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: "example",
      label: "Example",
      auth: [
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
      ],
    });
  },
});
```

## Choose the smallest public seam

If a helper exists on a focused subpath, prefer that over a broader runtime
surface.

- Prefer `plugin-sdk/provider-auth` over reaching into unrelated provider files.
- Prefer `plugin-sdk/channel-contract` for types in tests and helper modules.
- Prefer `plugin-sdk/runtime-store` over custom mutable globals.
- Prefer `plugin-sdk/testing` for shared test fixtures.

## Related

- [Building Plugins](/plugins/building-plugins)
- [Plugin Entry Points](/plugins/sdk-entrypoints)
- [Plugin Runtime](/plugins/sdk-runtime)
- [Plugin Setup](/plugins/sdk-setup)
- [Channel Plugin SDK](/plugins/sdk-channel-plugins)
- [Provider Plugin SDK](/plugins/sdk-provider-plugins)
- [Plugin SDK Testing](/plugins/sdk-testing)
- [Plugin SDK Migration](/plugins/sdk-migration)
