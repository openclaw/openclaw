---
title: "Plugin SDK Migration"
sidebarTitle: "SDK Migration"
summary: "Migrate from legacy compat surfaces to focused plugin-sdk subpaths and injected runtime helpers"
read_when:
  - You see the OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED warning
  - You see the OPENCLAW_EXTENSION_API_DEPRECATED warning
  - You are updating a plugin from the monolithic plugin-sdk import to scoped subpaths
  - You are updating a plugin away from openclaw/extension-api
  - You maintain an external OpenClaw plugin
---

# Plugin SDK Migration

OpenClaw is migrating from broad compatibility surfaces to narrower, documented
contracts:

- `openclaw/plugin-sdk/compat` -> focused `openclaw/plugin-sdk/<subpath>` imports
- `openclaw/extension-api` -> injected runtime helpers such as `api.runtime.agent.*`

This page explains what changed, why, and how to migrate.

<Info>
  The compat import still works at runtime. This is a deprecation warning, not
  a breaking change yet. But new plugins **must not** use it, and existing
  plugins should migrate before the next major release removes it.
</Info>

## Why this changed

The old monolithic `openclaw/plugin-sdk/compat` re-exported everything from one
entry point. This caused slow startup (importing one helper loaded dozens of
unrelated modules), circular dependency risk, and an unclear API surface.

Focused subpaths fix all three: each subpath is a small, self-contained module
with a clear purpose.

## Migration steps

<Steps>
  <Step title="Find deprecated imports">
    Search your plugin for imports from either deprecated surface:

    ```bash
    grep -r "plugin-sdk/compat" my-plugin/
    grep -r "openclaw/extension-api" extensions/my-plugin/
    ```

  </Step>

  <Step title="Replace with focused subpaths or runtime injection">
    Each export from compat maps to a specific subpath. Replace the import
    source:

    ```typescript
    // Before (compat entry)
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

    If your plugin imports from `openclaw/extension-api`, you will now see:

    ```text
    [OPENCLAW_EXTENSION_API_DEPRECATED] Warning: openclaw/extension-api is deprecated.
    Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports.
    ```

    That bridge also still works at runtime today. It exists to preserve older
    plugins while they migrate to the injected plugin runtime.

    Move host-side helpers onto the injected plugin runtime instead of
    importing them directly:

    ```typescript
    // Before (deprecated extension-api bridge)
    import { runEmbeddedPiAgent } from "openclaw/extension-api";

    const result = await runEmbeddedPiAgent({
      sessionId,
      sessionFile,
      workspaceDir,
      prompt,
      timeoutMs,
    });

    // After (preferred injected runtime)
    const result = await api.runtime.agent.runEmbeddedPiAgent({
      sessionId,
      sessionFile,
      workspaceDir,
      prompt,
      timeoutMs,
    });
    ```

    The same pattern applies to the other legacy `extension-api` helpers:

    - `resolveAgentDir` -> `api.runtime.agent.resolveAgentDir`
    - `resolveAgentWorkspaceDir` -> `api.runtime.agent.resolveAgentWorkspaceDir`
    - `resolveAgentIdentity` -> `api.runtime.agent.resolveAgentIdentity`
    - `resolveThinkingDefault` -> `api.runtime.agent.resolveThinkingDefault`
    - `resolveAgentTimeoutMs` -> `api.runtime.agent.resolveAgentTimeoutMs`
    - `ensureAgentWorkspace` -> `api.runtime.agent.ensureAgentWorkspace`
    - session store helpers -> `api.runtime.agent.session.*`

    See the [subpath reference](#subpath-reference) below for the scoped import
    mapping.

  </Step>

  <Step title="Build and test">
    ```bash
    pnpm build
    pnpm test -- extensions/my-plugin/
    ```
  </Step>
</Steps>

## Subpath reference

<Accordion title="Full subpath table">
  | Subpath | Purpose | Key exports |
  | --- | --- | --- |
  | `plugin-sdk/core` | Plugin entry definitions, base types | `defineChannelPluginEntry`, `definePluginEntry` |
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
  | `plugin-sdk/allow-from` | Allowlist formatting | `formatAllowFromLowercase` |
  | `plugin-sdk/allowlist-resolution` | Allowlist input mapping | `mapAllowlistResolutionInputs` |
  | `plugin-sdk/command-auth` | Command gating | `resolveControlCommandGate` |
  | `plugin-sdk/secret-input` | Secret input parsing | Secret input helpers |
  | `plugin-sdk/webhook-ingress` | Webhook request helpers | Webhook target utilities |
  | `plugin-sdk/reply-payload` | Message reply types | Reply payload types |
  | `plugin-sdk/provider-onboard` | Provider onboarding patches | Onboarding config helpers |
  | `plugin-sdk/keyed-async-queue` | Ordered async queue | `KeyedAsyncQueue` |
  | `plugin-sdk/testing` | Test utilities | Test helpers and mocks |
</Accordion>

Use the narrowest subpath that matches the job. If you cannot find an export,
check the source at `src/plugin-sdk/` or ask in Discord.

## Removal timeline

| When                   | What happens                                                            |
| ---------------------- | ----------------------------------------------------------------------- |
| **Now**                | Compat import and `openclaw/extension-api` emit runtime warnings        |
| **Next major release** | These legacy bridges may be removed; plugins still using them will fail |

All core plugins have already been migrated. External plugins should migrate
before the next major release.

## Suppressing the warning temporarily

Set this environment variable while you work on migrating:

```bash
OPENCLAW_SUPPRESS_PLUGIN_SDK_COMPAT_WARNING=1 openclaw gateway run
OPENCLAW_SUPPRESS_EXTENSION_API_WARNING=1 openclaw gateway run
```

This is a temporary escape hatch, not a permanent solution.

## Related

- [Building Plugins](/plugins/building-plugins)
- [Plugin Architecture](/plugins/architecture)
- [Plugin Manifest](/plugins/manifest)
