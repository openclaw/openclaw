---
title: "Building Extensions"
summary: "Step-by-step guide for creating OpenClaw channel and provider extensions"
read_when:
  - You want to create a new OpenClaw plugin or extension
  - You need to understand the plugin SDK import patterns
  - You are adding a new channel or provider to OpenClaw
---

# Building Extensions

Extensions add channels, model providers, tools, or other capabilities to OpenClaw.
This guide walks through creating one from scratch.

## Prerequisites

- OpenClaw repository cloned and dependencies installed (`pnpm install`)
- Familiarity with TypeScript (ESM)

## Extension structure

Every extension lives under `extensions/<name>/` and follows this layout:

```
extensions/my-channel/
├── package.json          # npm metadata + openclaw config
├── index.ts              # Entry point (defineChannelPluginEntry)
├── setup-entry.ts        # Setup wizard (optional)
├── api.ts                # Public contract barrel (optional)
├── runtime-api.ts        # Internal runtime barrel (optional)
└── src/
    ├── channel.ts        # Channel adapter implementation
    ├── runtime.ts        # Runtime wiring
    └── *.test.ts         # Colocated tests
```

## Create an extension

<Steps>
  <Step title="Create the package">
    Create `extensions/my-channel/package.json`:

    ```json
    {
      "name": "@openclaw/my-channel",
      "version": "2026.1.1",
      "description": "OpenClaw My Channel plugin",
      "type": "module",
      "dependencies": {},
      "openclaw": {
        "extensions": ["./index.ts"],
        "setupEntry": "./setup-entry.ts",
        "channel": {
          "id": "my-channel",
          "label": "My Channel",
          "selectionLabel": "My Channel (plugin)",
          "docsPath": "/channels/my-channel",
          "docsLabel": "my-channel",
          "blurb": "Short description of the channel.",
          "order": 80
        },
        "install": {
          "npmSpec": "@openclaw/my-channel",
          "localPath": "extensions/my-channel"
        }
      }
    }
    ```

    The `openclaw` field tells the plugin system what your extension provides.
    For provider plugins, use `providers` instead of `channel`.

  </Step>

  <Step title="Define the entry point">
    Create `extensions/my-channel/index.ts`:

    ```typescript
    import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";

    export default defineChannelPluginEntry({
      id: "my-channel",
      name: "My Channel",
      description: "Connects OpenClaw to My Channel",
      plugin: {
        // Channel adapter implementation
      },
    });
    ```

    For provider plugins, use `definePluginEntry` instead.

  </Step>

  <Step title="Import from focused subpaths">
    Always import from specific `openclaw/plugin-sdk/<subpath>` paths rather than
    the monolithic root. The old `openclaw/plugin-sdk/compat` barrel is deprecated
    (see [SDK Migration](/plugins/sdk-migration)).

    ```typescript
    // Correct: focused subpaths
    import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
    import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
    import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
    import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
    import { createOptionalChannelSetupSurface } from "openclaw/plugin-sdk/channel-setup";
    import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";
    import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-oauth";

    // Wrong: monolithic root (lint will reject this)
    import { ... } from "openclaw/plugin-sdk";
    ```

    <Accordion title="Common subpaths reference">
      | Subpath | Purpose |
      | --- | --- |
      | `plugin-sdk/core` | Plugin entry definitions, base types |
      | `plugin-sdk/channel-setup` | Optional setup adapters/wizards |
      | `plugin-sdk/channel-pairing` | DM pairing primitives |
      | `plugin-sdk/channel-reply-pipeline` | Prefix + typing reply wiring |
      | `plugin-sdk/channel-config-schema` | Config schema builders |
      | `plugin-sdk/channel-policy` | Group/DM policy helpers |
      | `plugin-sdk/secret-input` | Secret input parsing/helpers |
      | `plugin-sdk/webhook-ingress` | Webhook request/target helpers |
      | `plugin-sdk/runtime-store` | Persistent plugin storage |
      | `plugin-sdk/allow-from` | Allowlist resolution |
      | `plugin-sdk/reply-payload` | Message reply types |
      | `plugin-sdk/provider-oauth` | OAuth login + PKCE helpers |
      | `plugin-sdk/provider-onboard` | Provider onboarding config patches |
      | `plugin-sdk/testing` | Test utilities |
    </Accordion>

    Use the narrowest primitive that matches the job. Reach for `channel-runtime`
    or other larger helper barrels only when a dedicated subpath does not exist yet.

  </Step>

  <Step title="Use local barrels for internal imports">
    Within your extension, create barrel files for internal code sharing instead
    of importing through the plugin SDK:

    ```typescript
    // api.ts — public contract for this extension
    export { MyChannelConfig } from "./src/config.js";
    export { MyChannelRuntime } from "./src/runtime.js";

    // runtime-api.ts — internal-only exports (not for production consumers)
    export { internalHelper } from "./src/helpers.js";
    ```

    <Warning>
      Never import your own extension back through its published SDK contract
      path from production files. Route internal imports through `./api.ts` or
      `./runtime-api.ts` instead. The SDK contract is for external consumers only.
    </Warning>

  </Step>

  <Step title="Add a plugin manifest">
    Create `openclaw.plugin.json` in your extension root:

    ```json
    {
      "id": "my-channel",
      "kind": "channel",
      "channels": ["my-channel"],
      "name": "My Channel Plugin",
      "description": "Connects OpenClaw to My Channel"
    }
    ```

    See [Plugin manifest](/plugins/manifest) for the full schema.

  </Step>

  <Step title="Test with contract tests">
    OpenClaw runs contract tests against all registered plugins. After adding your
    extension, run:

    ```bash
    pnpm test:contracts:channels   # channel plugins
    pnpm test:contracts:plugins    # provider plugins
    ```

    Contract tests verify your plugin conforms to the expected interface (setup
    wizard, session binding, message handling, group policy, etc.).

    For unit tests, import test helpers from the public testing surface:

    ```typescript
    import { createTestRuntime } from "openclaw/plugin-sdk/testing";
    ```

  </Step>
</Steps>

## Lint enforcement

Three scripts enforce SDK boundaries:

1. **No monolithic root imports** — `openclaw/plugin-sdk` root is rejected
2. **No direct src/ imports** — extensions cannot import `../../src/` directly
3. **No self-imports** — extensions cannot import their own `plugin-sdk/<name>` subpath

Run `pnpm check` to verify all boundaries before committing.

## Pre-submission checklist

<Check>**package.json** has correct `openclaw` metadata</Check>
<Check>Entry point uses `defineChannelPluginEntry` or `definePluginEntry`</Check>
<Check>All imports use focused `plugin-sdk/<subpath>` paths</Check>
<Check>Internal imports use local barrels, not SDK self-imports</Check>
<Check>`openclaw.plugin.json` manifest is present and valid</Check>
<Check>Contract tests pass (`pnpm test:contracts`)</Check>
<Check>Unit tests colocated as `*.test.ts`</Check>
<Check>`pnpm check` passes (lint + format)</Check>
<Check>Doc page created under `docs/channels/` or `docs/plugins/`</Check>

## Related

- [Plugin SDK Migration](/plugins/sdk-migration) — migrating from compat to focused subpaths
- [Plugin Architecture](/plugins/architecture) — internals and capability model
- [Plugin Manifest](/plugins/manifest) — full manifest schema
- [Community Plugins](/plugins/community) — existing community extensions
