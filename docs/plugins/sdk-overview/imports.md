---
summary: "Which plugin SDK subpath to import from, and how to lay out a plugin's own barrels"
title: "Plugin SDK imports and module layout"
sidebarTitle: "Imports and module layout"
read_when:
  - You need to know which SDK subpath to import from
  - You are looking up a specific SDK export
  - You are deciding how to structure your plugin's internal imports
---

Which `openclaw/plugin-sdk/*` subpath to import from, and how to organize a
plugin's own public and internal barrels. Part of the
[Plugin SDK overview](/plugins/sdk-overview).

## Import convention

For features with native Control UI, use [Feature plugins](/plugins/feature-plugins):
`feature-contract` defines shared operations, `feature-plugin` registers their
backend implementations, and `control-ui` exposes browser contribution and
replacement contracts.

Always import from a specific subpath:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
```

Each subpath is a small, self-contained module. This keeps startup fast and
prevents circular dependency issues. For channel-specific entry/build helpers,
prefer `openclaw/plugin-sdk/channel-core`; keep `openclaw/plugin-sdk/core` for
the broader umbrella surface and shared helpers such as
`buildChannelConfigSchema`.

For channel config, publish the channel-owned JSON Schema through
`openclaw.plugin.json#channelConfigs`. The `plugin-sdk/channel-config-schema`
subpath is for shared schema primitives and the generic builder. OpenClaw's
bundled plugins use `plugin-sdk/bundled-channel-config-schema` for retained
bundled-channel schemas. That bundled schema subpath is not a pattern for new
plugins.

<Warning>
  Do not import provider- or channel-branded convenience seams (for example
  `openclaw/plugin-sdk/slack`, `.../discord`, `.../signal`, `.../whatsapp`).
  Bundled plugins compose generic SDK subpaths inside their own `api.ts` /
  `runtime-api.ts` barrels; core consumers should either use those plugin-local
  barrels or add a narrow generic SDK contract when a need is truly
  cross-channel.

A small set of bundled-plugin helper seams still appear in the generated export
map when they have tracked owner usage. They exist for bundled-plugin
maintenance only and are not recommended import paths for new third-party
plugins.

`openclaw/plugin-sdk/discord` and `openclaw/plugin-sdk/telegram-account` are
also kept as deprecated compatibility facades for tracked owner usage. Do not
copy those import paths into new plugins; use injected runtime helpers and
generic channel SDK subpaths instead.
</Warning>

## Subpath reference

The plugin SDK is exposed as a set of narrow subpaths grouped by area (plugin
entry, channel, provider, auth, runtime, capability, memory, and reserved
bundled-plugin helpers). For the full catalog — grouped and linked — see
[Plugin SDK subpaths](/plugins/sdk-subpaths).

The compiler entrypoint inventory lives in
`scripts/lib/plugin-sdk-entrypoints.json`; typed public exports exclude the
internal subpaths listed in
`scripts/lib/plugin-sdk-private-local-only-subpaths.json`. Production entries
on that list retain JavaScript-only host runtime exports for separately
published official plugins, while test-only entries remain unexported. Run
`pnpm plugin-sdk:surface` to audit the public export count. Deprecated public
subpaths that are old enough and unused by bundled extension production code are
tracked in `scripts/lib/plugin-sdk-deprecated-public-subpaths.json`; broad
deprecated re-export barrels are tracked in
`scripts/lib/plugin-sdk-deprecated-barrel-subpaths.json`.

## Internal module convention

Within your plugin, use local barrel files for internal imports:

```text
my-plugin/
  api.ts            # Public exports for external consumers
  runtime-api.ts    # Internal-only runtime exports
  index.ts          # Plugin entry point
  setup-entry.ts    # Lightweight setup-only entry (optional)
```

<Warning>
  Never import your own plugin through `openclaw/plugin-sdk/<your-plugin>`
  from production code. Route internal imports through `./api.ts` or
  `./runtime-api.ts`. The SDK path is the external contract only.
</Warning>

Facade-loaded bundled plugin public surfaces (`api.ts`, `runtime-api.ts`,
`index.ts`, `setup-entry.ts`, and similar public entry files) prefer the
active runtime config snapshot when OpenClaw is already running. If no runtime
snapshot exists yet, they fall back to the resolved config file on disk.
Packaged bundled plugin facades should be loaded through OpenClaw's plugin
facade loaders; direct imports from `dist/extensions/...` bypass the manifest
and runtime sidecar checks that packaged installs use for plugin-owned code.

Provider plugins can expose a narrow plugin-local contract barrel when a
helper is intentionally provider-specific and does not belong in a generic SDK
subpath yet. Bundled examples:

- **Anthropic**: public `api.ts` / `contract-api.ts` seam for Claude
  beta-header and `service_tier` stream helpers.
- **`@openclaw/openai-provider`**: `api.ts` exports provider builders,
  default-model helpers, and realtime provider builders.
- **`@openclaw/openrouter-provider`**: `api.ts` exports the provider builder
  plus onboarding/config helpers.

<Warning>
  Extension production code should also avoid `openclaw/plugin-sdk/<other-plugin>`
  imports. If a helper is truly shared, promote it to a neutral SDK subpath
  such as `openclaw/plugin-sdk/speech`, `.../provider-model-shared`, or another
  capability-oriented surface instead of coupling two plugins together.
</Warning>
