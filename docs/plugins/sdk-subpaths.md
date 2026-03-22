---
title: "Plugin SDK Subpaths"
sidebarTitle: "SDK Subpaths"
summary: "Supported public `openclaw/plugin-sdk/*` imports for plugin authors"
read_when:
  - You want to know which SDK import path to use
  - You are replacing old `openclaw/plugin-sdk` root-barrel imports
  - You need a public import-path reference instead of internal repo files
---

# Plugin SDK Subpaths

This page lists the supported public `openclaw/plugin-sdk/*` imports for plugin
authors.

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

## Channel building

| Import path                                  | Use it for                                           |
| -------------------------------------------- | ---------------------------------------------------- |
| `openclaw/plugin-sdk/channel-setup`          | Setup surfaces and setup helpers                     |
| `openclaw/plugin-sdk/channel-pairing`        | Pairing, approval, and account linking flows         |
| `openclaw/plugin-sdk/channel-contract`       | Channel contract types                               |
| `openclaw/plugin-sdk/channel-feedback`       | Feedback and reactions                               |
| `openclaw/plugin-sdk/channel-inbound`        | Inbound envelope helpers, debounce, mention matching |
| `openclaw/plugin-sdk/channel-lifecycle`      | Account status and lifecycle tracking                |
| `openclaw/plugin-sdk/channel-reply-pipeline` | Reply and typing orchestration                       |
| `openclaw/plugin-sdk/channel-config-schema`  | Channel config schema types                          |
| `openclaw/plugin-sdk/channel-config-helpers` | Shared config adapter helpers                        |
| `openclaw/plugin-sdk/channel-policy`         | Shared channel policy helpers                        |
| `openclaw/plugin-sdk/channel-targets`        | Target parsing and matching                          |
| `openclaw/plugin-sdk/channel-actions`        | Shared message-action and card helpers               |
| `openclaw/plugin-sdk/channel-send-result`    | Send-result and reply result types                   |

## Provider building

| Import path                               | Use it for                           |
| ----------------------------------------- | ------------------------------------ |
| `openclaw/plugin-sdk/provider-auth`       | API key auth and shared auth helpers |
| `openclaw/plugin-sdk/provider-auth-login` | Interactive login flows              |
| `openclaw/plugin-sdk/provider-catalog`    | Provider catalog types               |
| `openclaw/plugin-sdk/provider-models`     | Model normalization helpers          |
| `openclaw/plugin-sdk/provider-onboard`    | Onboarding config patches            |
| `openclaw/plugin-sdk/provider-stream`     | Stream wrapper types                 |
| `openclaw/plugin-sdk/provider-usage`      | Usage and billing helpers            |

## Tool, auth, and webhook helpers

| Import path                           | Use it for                                |
| ------------------------------------- | ----------------------------------------- |
| `openclaw/plugin-sdk/command-auth`    | Command-gating helpers                    |
| `openclaw/plugin-sdk/secret-input`    | Secret parsing and prompt input helpers   |
| `openclaw/plugin-sdk/allow-from`      | Allowlist formatting and normalization    |
| `openclaw/plugin-sdk/webhook-ingress` | Shared webhook request and target helpers |
| `openclaw/plugin-sdk/reply-payload`   | Shared reply-payload shaping              |

## Runtime and storage helpers

| Import path                             | Use it for                                                      |
| --------------------------------------- | --------------------------------------------------------------- |
| `openclaw/plugin-sdk/agent-runtime`     | Agent directories, identity, workspace, and embedded Pi helpers |
| `openclaw/plugin-sdk/config-runtime`    | Config load and write helpers                                   |
| `openclaw/plugin-sdk/infra-runtime`     | System events and heartbeat helpers                             |
| `openclaw/plugin-sdk/directory-runtime` | Config-backed directories and dedup helpers                     |
| `openclaw/plugin-sdk/runtime-store`     | Persistent plugin runtime storage                               |
| `openclaw/plugin-sdk/keyed-async-queue` | Keyed async coordination helpers                                |

## Capability type helpers

| Import path                               | Use it for                            |
| ----------------------------------------- | ------------------------------------- |
| `openclaw/plugin-sdk/image-generation`    | Image generation provider types       |
| `openclaw/plugin-sdk/media-understanding` | Media understanding provider types    |
| `openclaw/plugin-sdk/speech`              | Speech provider types                 |
| `openclaw/plugin-sdk/testing`             | Test helpers and fixtures for plugins |

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
- [Migrate to SDK](/plugins/sdk-migration) — replace deprecated import paths
- [Building Plugins](/plugins/building-plugins) — first plugin walkthrough
