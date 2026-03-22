---
title: "Plugin SDK Subpaths"
sidebarTitle: "SDK Subpaths"
summary: "Starting points and supporting public `openclaw/plugin-sdk/*` imports for plugin authors"
read_when:
  - You want to know where to start in the SDK
  - You are replacing old `openclaw/plugin-sdk` root-barrel imports
  - You need a short public import-path reference instead of internal repo files
---

# Plugin SDK Subpaths

This page lists the public `openclaw/plugin-sdk/*` imports plugin authors
should start from.

It is intentionally short. Use the task-specific guides for the detailed
channel, provider, runtime, and testing surfaces.

Use these documented subpaths instead of:

- the legacy root barrel `openclaw/plugin-sdk`
- core `src/**` imports
- `src/plugin-sdk-internal/**`
- another plugin's private `src/**`

<Info>
  If the helper you need is not documented here, do not reach into internal
  files. Open a request for a new public subpath instead.
</Info>

## Start here

| Import path                        | Use it for                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `openclaw/plugin-sdk/plugin-entry` | `definePluginEntry(...)` for provider, tool, and hook plugins                                    |
| `openclaw/plugin-sdk/core`         | `defineChannelPluginEntry(...)`, `defineSetupPluginEntry(...)`, and shared plugin contract types |
| `openclaw/plugin-sdk/testing`      | Public test helpers and fixtures                                                                 |

## Choose imports by task

- Tool, hook, and command plugins usually start with
  `openclaw/plugin-sdk/plugin-entry`. See [Tool Plugins](/plugins/sdk-tool-plugins).
- Channel plugins start with `openclaw/plugin-sdk/core`, then pull focused
  helpers as needed. See [Channel Plugins](/plugins/sdk-channel-plugins) and
  [Channel Plugin Interface](/plugins/sdk-channel-interface).
- Provider plugins usually start with `openclaw/plugin-sdk/plugin-entry`, plus
  provider helpers when needed. See [Provider Plugins](/plugins/sdk-provider-plugins)
  and [Provider Plugin Interface](/plugins/sdk-provider-interface).
- Shared runtime helpers live in the runtime guide. See
  [Plugin Runtime Helpers](/plugins/sdk-runtime).
- Setup entrypoints, manifests, and config adapters live in the setup guide.
  See [Plugin Setup and Config](/plugins/sdk-setup).

## Common supporting imports

| Import path                            | Use it for                                |
| -------------------------------------- | ----------------------------------------- |
| `openclaw/plugin-sdk/channel-setup`    | Setup surfaces and setup helpers          |
| `openclaw/plugin-sdk/channel-contract` | Shared channel contract types             |
| `openclaw/plugin-sdk/provider-auth`    | API key auth and shared auth helpers      |
| `openclaw/plugin-sdk/provider-models`  | Model normalization helpers               |
| `openclaw/plugin-sdk/runtime-store`    | Persistent plugin runtime storage         |
| `openclaw/plugin-sdk/command-auth`     | Command-gating helpers                    |
| `openclaw/plugin-sdk/webhook-ingress`  | Shared webhook request and target helpers |
| `openclaw/plugin-sdk/reply-payload`    | Shared reply-payload shaping              |

## Compatibility shims

| Import path                           | Status             | Notes                                                     |
| ------------------------------------- | ------------------ | --------------------------------------------------------- |
| `openclaw/plugin-sdk`                 | Deprecated         | Old root barrel. New code should use focused subpaths.    |
| `openclaw/plugin-sdk/channel-runtime` | Compatibility only | Old channel shim. Prefer narrower channel subpaths above. |

## What is not part of the public contract

These are the common mistakes to avoid:

- importing `src/**` from plugin code
- importing `src/plugin-sdk-internal/**`
- importing another plugin's `src/**`
- using extension-specific helper barrels as if they were stable global SDK API

Inside your own plugin package, prefer local barrels such as:

- `./api.ts`
- `./runtime-api.ts`

Those are for your plugin's internal structure. `openclaw/plugin-sdk/*` is the
cross-package contract.

## Related

- [Plugin SDK Overview](/plugins/sdk-overview) — registration API and API object
- [Plugin Entry Points](/plugins/sdk-entrypoints) — `definePluginEntry` and channel entry helpers
- [Tool Plugins](/plugins/sdk-tool-plugins) — build tool, hook, and command plugins
- [Channel Plugin Interface](/plugins/sdk-channel-interface) — public `ChannelPlugin` shape
- [Provider Plugin Interface](/plugins/sdk-provider-interface) — public `ProviderPlugin` shape
- [Plugin Runtime Helpers](/plugins/sdk-runtime) — runtime-specific helpers
- [Migrate to SDK](/plugins/sdk-migration) — replace deprecated import paths
- [Building Plugins](/plugins/building-plugins) — first plugin walkthrough
