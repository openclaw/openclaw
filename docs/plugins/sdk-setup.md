---
title: "Plugin Setup and Config"
sidebarTitle: "Setup and Config"
summary: "Setup wizards, setup-entry.ts, config schemas, and package.json metadata"
read_when:
  - You are adding a setup wizard to a plugin
  - You need to understand setup-entry.ts vs index.ts
  - You are defining plugin config schemas or package.json openclaw metadata
---

# Plugin Setup and Config

Reference for plugin packaging (`package.json` metadata), manifests
(`openclaw.plugin.json`), setup entries, and config schemas.

<Tip>
  **Looking for a walkthrough?** The how-to guides cover packaging in context:
  [Channel Plugins](/plugins/sdk-channel-plugins#step-1-package-and-manifest) and
  [Provider Plugins](/plugins/sdk-provider-plugins#step-1-package-and-manifest).
</Tip>

## Package metadata

Your `package.json` needs an `openclaw` field that tells the plugin system what
your plugin provides:

**Channel plugin:**

```json
{
  "name": "@myorg/openclaw-my-channel",
  "version": "1.0.0",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "channel": {
      "id": "my-channel",
      "label": "My Channel",
      "blurb": "Short description of the channel."
    }
  }
}
```

**Provider plugin:**

```json
{
  "name": "@myorg/openclaw-my-provider",
  "version": "1.0.0",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"],
    "providers": ["my-provider"]
  }
}
```

### `openclaw` fields

| Field        | Type       | Description                                                                                |
| ------------ | ---------- | ------------------------------------------------------------------------------------------ |
| `extensions` | `string[]` | Entry point files (relative to package root)                                               |
| `setupEntry` | `string`   | Lightweight setup-only entry (optional)                                                    |
| `channel`    | `object`   | Channel metadata: `id`, `label`, `blurb`, `selectionLabel`, `docsPath`, `order`, `aliases` |
| `providers`  | `string[]` | Provider ids registered by this plugin                                                     |
| `install`    | `object`   | Install hints: `npmSpec`, `localPath`, `defaultChoice`                                     |
| `startup`    | `object`   | Startup behavior flags                                                                     |

### Deferred full load

Channel plugins can opt into deferred loading with:

```json
{
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "startup": {
      "deferConfiguredChannelFullLoadUntilAfterListen": true
    }
  }
}
```

When enabled, OpenClaw loads only `setupEntry` during the pre-listen startup
phase, even for already-configured channels. The full entry loads after the
gateway starts listening.

<Warning>
  Only enable deferred loading when your `setupEntry` registers everything the
  gateway needs before it starts listening (channel registration, HTTP routes,
  gateway methods). If the full entry owns required startup capabilities, keep
  the default behavior.
</Warning>

## Plugin manifest

Every native plugin must ship an `openclaw.plugin.json` in the package root.
OpenClaw uses this to validate config without executing plugin code.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "Adds My Plugin capabilities to OpenClaw",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "webhookSecret": {
        "type": "string",
        "description": "Webhook verification secret"
      }
    }
  }
}
```

For channel plugins, add `kind` and `channels`:

```json
{
  "id": "my-channel",
  "kind": "channel",
  "channels": ["my-channel"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Even plugins with no config must ship a schema. An empty schema is valid:

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false
  }
}
```

See [Plugin Manifest](/plugins/manifest) for the full schema reference.

## Setup entry

The `setup-entry.ts` file is a lightweight alternative to `index.ts` that
OpenClaw loads when it only needs setup surfaces (onboarding, config repair,
disabled channel inspection).

```typescript
// setup-entry.ts
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { myChannelPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(myChannelPlugin);
```

This avoids loading heavy runtime code (crypto libraries, CLI registrations,
background services) during setup flows.

**When OpenClaw uses `setupEntry` instead of the full entry:**

- The channel is disabled but needs setup/onboarding surfaces
- The channel is enabled but unconfigured
- Deferred loading is enabled (`deferConfiguredChannelFullLoadUntilAfterListen`)

**What `setupEntry` must register:**

- The channel plugin object (via `defineSetupPluginEntry`)
- Any HTTP routes required before gateway listen
- Any gateway methods needed during startup

**What `setupEntry` should NOT include:**

- CLI registrations
- Background services
- Heavy runtime imports (crypto, SDKs)
- Gateway methods only needed after startup

## Config schema

Plugin config is validated against the JSON Schema in your manifest. Users
configure plugins via:

```json5
{
  plugins: {
    entries: {
      "my-plugin": {
        config: {
          webhookSecret: "abc123",
        },
      },
    },
  },
}
```

Your plugin receives this config as `api.pluginConfig` during registration.

For channel-specific config, use the channel config section instead:

```json5
{
  channels: {
    "my-channel": {
      token: "bot-token",
      allowFrom: ["user1", "user2"],
    },
  },
}
```

### Building channel config schemas

Use `buildChannelConfigSchema` from `openclaw/plugin-sdk/core` to convert a
Zod schema into the `ChannelConfigSchema` wrapper that OpenClaw validates:

```typescript
import { z } from "zod";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/core";

const accountSchema = z.object({
  token: z.string().optional(),
  allowFrom: z.array(z.string()).optional(),
  accounts: z.object({}).catchall(z.any()).optional(),
  defaultAccount: z.string().optional(),
});

const configSchema = buildChannelConfigSchema(accountSchema);
```

## Setup wizards

Channel plugins can provide interactive setup wizards for `openclaw onboard`.
The wizard is a `ChannelSetupWizard` object on the `ChannelPlugin`:

```typescript
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";

const setupWizard: ChannelSetupWizard = {
  channel: "my-channel",
  status: {
    configuredLabel: "Connected",
    unconfiguredLabel: "Not configured",
    resolveConfigured: ({ cfg }) => Boolean((cfg.channels as any)?.["my-channel"]?.token),
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: "my-channel",
      credentialLabel: "Bot token",
      preferredEnvVar: "MY_CHANNEL_BOT_TOKEN",
      envPrompt: "Use MY_CHANNEL_BOT_TOKEN from environment?",
      keepPrompt: "Keep current token?",
      inputPrompt: "Enter your bot token:",
      inspect: ({ cfg, accountId }) => {
        const token = (cfg.channels as any)?.["my-channel"]?.token;
        return {
          accountConfigured: Boolean(token),
          hasConfiguredValue: Boolean(token),
        };
      },
    },
  ],
};
```

The `ChannelSetupWizard` type supports `credentials`, `textInputs`,
`dmPolicy`, `allowFrom`, `groupAccess`, `prepare`, `finalize`, and more.
See bundled plugins (e.g. `extensions/discord/src/channel.setup.ts`) for
full examples.

For DM allowlist prompts that only need the standard
`note -> prompt -> parse -> merge -> patch` flow, prefer the shared setup
helpers from `openclaw/plugin-sdk/setup`: `createPromptParsedAllowFromForAccount(...)`,
`createTopLevelChannelParsedAllowFromPrompt(...)`, and
`createNestedChannelParsedAllowFromPrompt(...)`.

For channel setup status blocks that only vary by labels, scores, and optional
extra lines, prefer `createStandardChannelSetupStatus(...)` from
`openclaw/plugin-sdk/setup` instead of hand-rolling the same `status` object in
each plugin.

For optional setup surfaces that should only appear in certain contexts, use
`createOptionalChannelSetupSurface` from `openclaw/plugin-sdk/channel-setup`:

```typescript
import { createOptionalChannelSetupSurface } from "openclaw/plugin-sdk/channel-setup";

const setupSurface = createOptionalChannelSetupSurface({
  channel: "my-channel",
  label: "My Channel",
  npmSpec: "@myorg/openclaw-my-channel",
  docsPath: "/channels/my-channel",
});
// Returns { setupAdapter, setupWizard }
```

## Publishing and installing

**External plugins:** publish to [ClawHub](/tools/clawhub) or npm, then install:

```bash
openclaw plugins install @myorg/openclaw-my-plugin
```

OpenClaw tries ClawHub first and falls back to npm automatically. You can also
force a specific source:

```bash
openclaw plugins install clawhub:@myorg/openclaw-my-plugin   # ClawHub only
openclaw plugins install npm:@myorg/openclaw-my-plugin       # npm only
```

**In-repo plugins:** place under `extensions/` and they are automatically
discovered during build.

**Users can browse and install:**

```bash
openclaw plugins search <query>
openclaw plugins install <package-name>
```

<Info>
  For npm-sourced installs, `openclaw plugins install` runs
  `npm install --ignore-scripts` (no lifecycle scripts). Keep plugin dependency
  trees pure JS/TS and avoid packages that require `postinstall` builds.
</Info>

## Related

- [SDK Entry Points](/plugins/sdk-entrypoints) -- `definePluginEntry` and `defineChannelPluginEntry`
- [Plugin Manifest](/plugins/manifest) -- full manifest schema reference
- [Building Plugins](/plugins/building-plugins) -- step-by-step getting started guide
