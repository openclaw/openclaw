---
title: "Plugin Setup"
sidebarTitle: "Setup"
summary: "Shared setup-wizard helpers for channel plugins, provider plugins, and secret inputs"
read_when:
  - You are building a setup or onboarding flow
  - You need shared allowlist or DM policy setup helpers
  - You need the shared secret-input schema
---

# Plugin Setup

OpenClaw exposes shared setup helpers so plugin setup flows behave like the
built-in ones.

Main subpaths:

- `openclaw/plugin-sdk/setup`
- `openclaw/plugin-sdk/channel-setup`
- `openclaw/plugin-sdk/secret-input`

## Channel setup helpers

Use `plugin-sdk/channel-setup` when a channel plugin needs the standard setup
adapter and setup wizard shapes.

### Optional channel plugins

If a channel is installable but not always present, use
`createOptionalChannelSetupSurface(...)`:

```ts
import { createOptionalChannelSetupSurface } from "openclaw/plugin-sdk/channel-setup";

export const optionalExampleSetup = createOptionalChannelSetupSurface({
  channel: "example",
  label: "Example Channel",
  npmSpec: "@openclaw/example-channel",
  docsPath: "/channels/example",
});
```

That returns:

- `setupAdapter`
- `setupWizard`

Both surfaces produce a consistent “install this plugin first” experience.

## Shared setup helpers

`plugin-sdk/setup` re-exports the setup primitives used by bundled channels.

Common helpers:

- `applySetupAccountConfigPatch(...)`
- `createPatchedAccountSetupAdapter(...)`
- `createEnvPatchedAccountSetupAdapter(...)`
- `createTopLevelChannelDmPolicy(...)`
- `setSetupChannelEnabled(...)`
- `promptResolvedAllowFrom(...)`
- `promptSingleChannelSecretInput(...)`

### Example: patch channel config in setup

```ts
import {
  DEFAULT_ACCOUNT_ID,
  createPatchedAccountSetupAdapter,
  setSetupChannelEnabled,
} from "openclaw/plugin-sdk/setup";

export const exampleSetupAdapter = createPatchedAccountSetupAdapter({
  resolveAccountId: ({ accountId }) => accountId ?? DEFAULT_ACCOUNT_ID,
  applyPatch: ({ nextConfig, accountId }) => {
    const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
    return setSetupChannelEnabled({
      nextConfig,
      channel: "example",
      accountId: resolvedAccountId,
      enabled: true,
    });
  },
});
```

## Secret input schema

Use `plugin-sdk/secret-input` instead of rolling your own secret-input parser.

```ts
import {
  buildOptionalSecretInputSchema,
  buildSecretInputArraySchema,
  buildSecretInputSchema,
  hasConfiguredSecretInput,
} from "openclaw/plugin-sdk/secret-input";

const ApiKeySchema = buildSecretInputSchema();
const OptionalApiKeySchema = buildOptionalSecretInputSchema();
const ExtraKeysSchema = buildSecretInputArraySchema();

const parsed = OptionalApiKeySchema.safeParse(process.env.EXAMPLE_API_KEY);
if (parsed.success && hasConfiguredSecretInput(parsed.data)) {
  // ...
}
```

## Provider setup note

Provider-specific onboarding helpers live on provider-focused subpaths:

- `plugin-sdk/provider-auth`
- `plugin-sdk/provider-onboard`
- `plugin-sdk/provider-setup`
- `plugin-sdk/self-hosted-provider-setup`

See [Provider Plugin SDK](/plugins/sdk-provider-plugins).

## Setup guidance

- Keep setup input schemas strict and small.
- Reuse OpenClaw’s allowlist, DM-policy, and secret-input helpers.
- Keep setup-entry modules thin; move behavior into `src/`.
- Link docs from setup flows when install or auth steps are manual.

## Related

- [Plugin SDK Overview](/plugins/sdk-overview)
- [Plugin Entry Points](/plugins/sdk-entrypoints)
- [Provider Plugin SDK](/plugins/sdk-provider-plugins)
- [Plugin Manifest](/plugins/manifest)
