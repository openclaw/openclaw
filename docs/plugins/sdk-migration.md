---
title: "Plugin SDK Migration"
sidebarTitle: "Migrate to SDK"
summary: "Migrate from the legacy backwards-compatibility layer to the modern plugin SDK"
read_when:
  - You see the OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED warning
  - You see the OPENCLAW_EXTENSION_API_DEPRECATED warning
  - You are updating a plugin to the modern plugin architecture
  - You maintain an external OpenClaw plugin
---

# Plugin SDK Migration

OpenClaw has moved from a broad backwards-compatibility layer to a modern plugin
architecture with focused, documented imports. If your plugin was built before
the new architecture, this guide helps you migrate.

## What is changing

The old plugin system provided two wide-open surfaces that let plugins import
anything they needed from a single entry point:

- **`openclaw/plugin-sdk/compat`** — a single import that re-exported dozens of
  helpers. It was introduced to keep older hook-based plugins working while the
  new plugin architecture was being built.
- **`openclaw/extension-api`** — a bridge that gave plugins direct access to
  host-side helpers like the embedded agent runner.

Both surfaces are now **deprecated**. They still work at runtime, but new
plugins must not use them, and existing plugins should migrate before the next
major release removes them.

<Warning>
  The backwards-compatibility layer will be removed in a future major release.
  Plugins that still import from these surfaces will break when that happens.
</Warning>

## Why this changed

The old approach caused problems:

- **Slow startup** — importing one helper loaded dozens of unrelated modules
- **Circular dependencies** — broad re-exports made it easy to create import cycles
- **Unclear API surface** — no way to tell which exports were stable vs internal

The modern plugin SDK fixes this: each import path (`openclaw/plugin-sdk/\<subpath\>`)
is a small, self-contained module with a clear purpose and documented contract.

## How to migrate

<Steps>
  <Step title="Find deprecated imports">
    Search your plugin for imports from either deprecated surface:

    ```bash
    grep -r "plugin-sdk/compat" my-plugin/
    grep -r "openclaw/extension-api" my-plugin/
    ```

  </Step>

  <Step title="Replace with focused imports">
    Each export from the old surface maps to a specific modern import path:

    ```typescript
    // Before (deprecated backwards-compatibility layer)
    import {
      createChannelReplyPipeline,
      createPluginRuntimeStore,
      resolveControlCommandGate,
    } from "openclaw/plugin-sdk/compat";

    // After (modern focused imports)
    import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
    import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
    import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
    ```

    For host-side helpers, use the injected plugin runtime instead of importing
    directly:

    ```typescript
    // Before (deprecated extension-api bridge)
    import { runEmbeddedPiAgent } from "openclaw/extension-api";
    const result = await runEmbeddedPiAgent({ sessionId, prompt });

    // After (injected runtime)
    const result = await api.runtime.agent.runEmbeddedPiAgent({ sessionId, prompt });
    ```

    The same pattern applies to other legacy bridge helpers:

    | Old import | Modern equivalent |
    | --- | --- |
    | `resolveAgentDir` | `api.runtime.agent.resolveAgentDir` |
    | `resolveAgentWorkspaceDir` | `api.runtime.agent.resolveAgentWorkspaceDir` |
    | `resolveAgentIdentity` | `api.runtime.agent.resolveAgentIdentity` |
    | `resolveThinkingDefault` | `api.runtime.agent.resolveThinkingDefault` |
    | `resolveAgentTimeoutMs` | `api.runtime.agent.resolveAgentTimeoutMs` |
    | `ensureAgentWorkspace` | `api.runtime.agent.ensureAgentWorkspace` |
    | session store helpers | `api.runtime.agent.session.*` |

  </Step>

  <Step title="Build and test">
    ```bash
    pnpm build
    pnpm test -- my-plugin/
    ```
  </Step>
</Steps>

## Import path reference

<Accordion title="Full import path table">
  | Import path | Purpose | Key exports |
  | --- | --- | --- |
  | `plugin-sdk/plugin-entry` | Canonical plugin entry helper | `definePluginEntry` |
  | `plugin-sdk/core` | Channel entry definitions, channel builders, base types | `defineChannelPluginEntry`, `createChatChannelPlugin` |
  | `plugin-sdk/channel-setup` | Setup wizard adapters | `createOptionalChannelSetupSurface` |
  | `plugin-sdk/channel-pairing` | DM pairing primitives | `createChannelPairingController` |
  | `plugin-sdk/channel-reply-pipeline` | Reply prefix + typing wiring | `createChannelReplyPipeline` |
  | `plugin-sdk/channel-config-helpers` | Config adapter factories | `createHybridChannelConfigAdapter` |
  | `plugin-sdk/channel-config-schema` | Config schema builders | Channel config schema types |
  | `plugin-sdk/channel-policy` | Group/DM policy resolution | `resolveChannelGroupRequireMention` |
  | `plugin-sdk/channel-lifecycle` | Account status tracking | `createAccountStatusSink` |
  | `plugin-sdk/channel-runtime` | Runtime wiring helpers | Channel runtime utilities |
  | `plugin-sdk/channel-send-result` | Send result types | Reply result types |
  | `plugin-sdk/runtime-store` | Persistent plugin storage | `createPluginRuntimeStore` |
  | `plugin-sdk/approval-runtime` | Approval prompt helpers | Exec/plugin approval payload and reply helpers |
  | `plugin-sdk/collection-runtime` | Bounded cache helpers | `pruneMapToMaxSize` |
  | `plugin-sdk/diagnostic-runtime` | Diagnostic gating helpers | `isDiagnosticFlagEnabled`, `isDiagnosticsEnabled` |
  | `plugin-sdk/error-runtime` | Error formatting helpers | `formatUncaughtError`, error graph helpers |
  | `plugin-sdk/fetch-runtime` | Wrapped fetch/proxy helpers | `resolveFetch`, proxy helpers |
  | `plugin-sdk/host-runtime` | Host normalization helpers | `normalizeHostname`, `normalizeScpRemoteHost` |
  | `plugin-sdk/retry-runtime` | Retry helpers | `RetryConfig`, `retryAsync`, policy runners |
  | `plugin-sdk/allow-from` | Allowlist formatting and input mapping | `formatAllowFromLowercase`, `mapAllowlistResolutionInputs` |
  | `plugin-sdk/command-auth` | Command gating | `resolveControlCommandGate` |
  | `plugin-sdk/secret-input` | Secret input parsing | Secret input helpers |
  | `plugin-sdk/webhook-ingress` | Webhook request helpers | Webhook target utilities |
  | `plugin-sdk/webhook-request-guards` | Webhook body guard helpers | Request body read/limit helpers |
  | `plugin-sdk/reply-payload` | Message reply types | Reply payload types |
  | `plugin-sdk/provider-onboard` | Provider onboarding patches | Onboarding config helpers |
  | `plugin-sdk/keyed-async-queue` | Ordered async queue | `KeyedAsyncQueue` |
  | `plugin-sdk/testing` | Test utilities | Test helpers and mocks |
</Accordion>

Use the narrowest import that matches the job. If you cannot find an export,
check the source at `src/plugin-sdk/` or ask in Discord.

## Removal timeline

| When                   | What happens                                                            |
| ---------------------- | ----------------------------------------------------------------------- |
| **Now**                | Deprecated surfaces emit runtime warnings                               |
| **Next major release** | Deprecated surfaces will be removed; plugins still using them will fail |

All core plugins have already been migrated. External plugins should migrate
before the next major release.

## Suppressing the warnings temporarily

Set these environment variables while you work on migrating:

```bash
OPENCLAW_SUPPRESS_PLUGIN_SDK_COMPAT_WARNING=1 openclaw gateway run
OPENCLAW_SUPPRESS_EXTENSION_API_WARNING=1 openclaw gateway run
```

This is a temporary escape hatch, not a permanent solution.

## Related

- [Getting Started](/plugins/building-plugins) — build your first plugin
- [SDK Overview](/plugins/sdk-overview) — full subpath import reference
- [Channel Plugins](/plugins/sdk-channel-plugins) — building channel plugins
- [Provider Plugins](/plugins/sdk-provider-plugins) — building provider plugins
- [Plugin Internals](/plugins/architecture) — architecture deep dive
- [Plugin Manifest](/plugins/manifest) — manifest schema reference
