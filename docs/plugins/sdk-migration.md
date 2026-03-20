---
title: "Plugin SDK Migration"
summary: "Migrate from openclaw/plugin-sdk/compat to focused subpath imports"
read_when:
  - You see the OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED warning
  - You are updating a plugin from the monolithic plugin-sdk import to scoped subpaths
  - You maintain an external OpenClaw plugin
---

# Plugin SDK Migration

OpenClaw is migrating from a single monolithic `openclaw/plugin-sdk/compat` barrel
to **focused subpath imports** (`openclaw/plugin-sdk/<subpath>`). This page explains
what changed, why, and how to migrate.

## Why this change

The monolithic compat barrel re-exported everything from a single entry point.
This caused:

- **Slow startup**: importing one helper pulled in dozens of unrelated modules.
- **Circular dependency risk**: broad re-exports made it easy to create import cycles.
- **Unclear API surface**: no way to tell which exports were stable vs internal.

Focused subpaths fix all three: each subpath is a small, self-contained module
with a clear purpose.

## What triggers the warning

If your plugin imports from the compat barrel, you will see:

```
[OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED] Warning: openclaw/plugin-sdk/compat is
deprecated for new plugins. Migrate to focused openclaw/plugin-sdk/<subpath> imports.
```

The compat barrel still works at runtime. This is a deprecation warning, not an
error. But new plugins **must not** use it, and existing plugins should migrate
before compat is removed.

## How to migrate

### Step 1: Find compat imports

Search your extension for imports from the compat path:

```bash
grep -r "plugin-sdk/compat" extensions/my-plugin/
```

### Step 2: Replace with focused subpaths

Each export from compat maps to a specific subpath. Replace the import source:

```typescript
// Before (compat barrel)
import {
  createChannelReplyPipeline,
  createPluginRuntimeStore,
  resolveControlCommandGate,
} from "openclaw/plugin-sdk/compat";

// After (focused subpaths)
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
```

### Step 3: Verify

Run the build and tests:

```bash
pnpm build
pnpm test -- extensions/my-plugin/
```

## Subpath reference

| Subpath                             | Purpose                              | Key exports                                                            |
| ----------------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| `plugin-sdk/core`                   | Plugin entry definitions, base types | `defineChannelPluginEntry`, `definePluginEntry`                        |
| `plugin-sdk/channel-setup`          | Setup wizard adapters                | `createOptionalChannelSetupSurface`                                    |
| `plugin-sdk/channel-pairing`        | DM pairing primitives                | `createChannelPairingController`                                       |
| `plugin-sdk/channel-reply-pipeline` | Reply prefix + typing wiring         | `createChannelReplyPipeline`                                           |
| `plugin-sdk/channel-config-helpers` | Config adapter factories             | `createHybridChannelConfigAdapter`, `createScopedChannelConfigAdapter` |
| `plugin-sdk/channel-config-schema`  | Config schema builders               | Channel config schema types                                            |
| `plugin-sdk/channel-policy`         | Group/DM policy resolution           | `resolveChannelGroupRequireMention`                                    |
| `plugin-sdk/channel-lifecycle`      | Account status tracking              | `createAccountStatusSink`                                              |
| `plugin-sdk/channel-runtime`        | Runtime wiring helpers               | Channel runtime utilities                                              |
| `plugin-sdk/channel-send-result`    | Send result types                    | Reply result types                                                     |
| `plugin-sdk/runtime-store`          | Persistent plugin storage            | `createPluginRuntimeStore`                                             |
| `plugin-sdk/allow-from`             | Allowlist formatting                 | `formatAllowFromLowercase`, `formatNormalizedAllowFromEntries`         |
| `plugin-sdk/allowlist-resolution`   | Allowlist input mapping              | `mapAllowlistResolutionInputs`                                         |
| `plugin-sdk/command-auth`           | Command gating                       | `resolveControlCommandGate`                                            |
| `plugin-sdk/secret-input`           | Secret input parsing                 | Secret input helpers                                                   |
| `plugin-sdk/webhook-ingress`        | Webhook request helpers              | Webhook target utilities                                               |
| `plugin-sdk/reply-payload`          | Message reply types                  | Reply payload types                                                    |
| `plugin-sdk/provider-onboard`       | Provider onboarding patches          | Onboarding config helpers                                              |
| `plugin-sdk/keyed-async-queue`      | Ordered async queue                  | `KeyedAsyncQueue`                                                      |
| `plugin-sdk/testing`                | Test utilities                       | Test helpers and mocks                                                 |

Use the narrowest subpath that has what you need. If you cannot find an export,
check the source at `src/plugin-sdk/` or ask in Discord.

## Compat barrel removal timeline

- **Now**: compat barrel emits a deprecation warning at runtime.
- **Next major release**: compat barrel will be removed. Plugins still using it will
  fail to import.

Bundled plugins (under `extensions/`) have already been migrated. External plugins
should migrate before the next major release.

## Suppressing the warning temporarily

If you need to suppress the warning while migrating:

```bash
OPENCLAW_SUPPRESS_PLUGIN_SDK_COMPAT_WARNING=1 openclaw gateway run
```

This is a temporary escape hatch, not a permanent solution.

## Internal barrel pattern

Within your extension, use local barrel files (`api.ts`, `runtime-api.ts`) for
internal code sharing instead of importing through the plugin SDK:

```typescript
// extensions/my-plugin/api.ts — public contract for this extension
export { MyConfig } from "./src/config.js";
export { MyRuntime } from "./src/runtime.js";
```

Never import your own extension back through `openclaw/plugin-sdk/<your-extension>`
from production files. That path is for external consumers only. See
[Building Extensions](/plugins/building-extensions#step-4-use-local-barrels-for-internal-imports).

## Related

- [Building Extensions](/plugins/building-extensions)
- [Plugin Architecture](/plugins/architecture)
- [Plugin Manifest](/plugins/manifest)
