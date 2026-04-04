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

Legacy provider convenience seams for bundled channels are also gone. Imports
such as `openclaw/plugin-sdk/slack`, `openclaw/plugin-sdk/discord`,
`openclaw/plugin-sdk/signal`, `openclaw/plugin-sdk/whatsapp`, and
`openclaw/plugin-sdk/telegram-core` were private mono-repo shortcuts, not
stable plugin contracts. Use narrow generic SDK subpaths instead. Inside the
bundled plugin workspace, keep provider-owned helpers in that plugin's own
`api.ts` or `runtime-api.ts`.

Current bundled provider examples:

- Anthropic keeps Claude-specific stream helpers in its own `api.ts` /
  `contract-api.ts` seam
- OpenAI keeps provider builders, default-model helpers, and realtime provider
  builders in its own `api.ts`
- OpenRouter keeps provider builder and onboarding/config helpers in its own
  `api.ts`

## How to migrate

<Steps>
  <Step title="Audit Windows wrapper fallback behavior">
    If your plugin uses `openclaw/plugin-sdk/windows-spawn`, unresolved Windows
    `.cmd`/`.bat` wrappers now fail closed unless you explicitly pass
    `allowShellFallback: true`.

    ```typescript
    // Before
    const program = applyWindowsSpawnProgramPolicy({ candidate });

    // After
    const program = applyWindowsSpawnProgramPolicy({
      candidate,
      // Only set this for trusted compatibility callers that intentionally
      // accept shell-mediated fallback.
      allowShellFallback: true,
    });
    ```

    If your caller does not intentionally rely on shell fallback, do not set
    `allowShellFallback` and handle the thrown error instead.

  </Step>

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

<Accordion title="Common import path table">
  | Import path | Purpose | Key exports |
  | --- | --- | --- |
  | `plugin-sdk/plugin-entry` | Canonical plugin entry helper | `definePluginEntry` |
  | `plugin-sdk/core` | Legacy umbrella re-export for channel entry definitions/builders | `defineChannelPluginEntry`, `createChatChannelPlugin` |
  | `plugin-sdk/provider-entry` | Single-provider entry helper | `defineSingleProviderPluginEntry` |
  | `plugin-sdk/channel-core` | Focused channel entry definitions and builders | `defineChannelPluginEntry`, `defineSetupPluginEntry`, `createChatChannelPlugin`, `createChannelPluginBase` |
  | `plugin-sdk/setup` | Shared setup wizard helpers | Allowlist prompts, setup status builders |
  | `plugin-sdk/setup-runtime` | Setup-time runtime helpers | Account-scoped setup runtime helpers, delegated setup proxies |
  | `plugin-sdk/setup-adapter-runtime` | Setup adapter helpers | `createEnvPatchedAccountSetupAdapter` |
  | `plugin-sdk/setup-tools` | Setup tooling helpers | CLI/archive/docs helpers for setup/install flows |
  | `plugin-sdk/account-core` | Multi-account helpers | Account list/config/action-gate helpers |
  | `plugin-sdk/account-id` | Account-id helpers | `DEFAULT_ACCOUNT_ID`, account-id normalization |
  | `plugin-sdk/account-resolution` | Account lookup helpers | Account lookup + default-fallback helpers |
  | `plugin-sdk/account-helpers` | Narrow account helpers | Account list/account-action helpers |
  | `plugin-sdk/channel-setup` | Setup wizard adapters | `createOptionalChannelSetupSurface` |
  | `plugin-sdk/channel-pairing` | DM pairing primitives | `createChannelPairingController` |
  | `plugin-sdk/channel-reply-pipeline` | Reply prefix + typing wiring | `createChannelReplyPipeline` |
  | `plugin-sdk/channel-config-helpers` | Config adapter factories | `createHybridChannelConfigAdapter` |
  | `plugin-sdk/channel-config-schema` | Config schema builders | Channel config schema types |
  | `plugin-sdk/channel-policy` | Group/DM policy resolution | `resolveChannelGroupRequireMention` |
  | `plugin-sdk/channel-lifecycle` | Account status tracking | `createAccountStatusSink` |
  | `plugin-sdk/inbound-envelope` | Inbound envelope helpers | Shared route + envelope builder helpers |
  | `plugin-sdk/inbound-reply-dispatch` | Inbound reply helpers | Shared record-and-dispatch helpers |
  | `plugin-sdk/messaging-targets` | Messaging target parsing | Target parsing/matching helpers |
  | `plugin-sdk/outbound-media` | Outbound media helpers | Shared outbound media loading |
  | `plugin-sdk/outbound-runtime` | Outbound runtime helpers | Outbound identity/send delegate helpers |
  | `plugin-sdk/thread-bindings-runtime` | Thread-binding helpers | Thread-binding lifecycle and adapter helpers |
  | `plugin-sdk/agent-media-payload` | Legacy media payload helpers | Agent media payload builder for legacy field layouts |
  | `plugin-sdk/channel-runtime` | Deprecated compatibility shim | Legacy channel runtime utilities only |
  | `plugin-sdk/channel-send-result` | Send result types | Reply result types |
  | `plugin-sdk/runtime-store` | Persistent plugin storage | `createPluginRuntimeStore` |
  | `plugin-sdk/runtime` | Broad runtime helpers | Runtime/logging/backup/plugin-install helpers |
  | `plugin-sdk/runtime-env` | Narrow runtime env helpers | Logger/runtime env, timeout, retry, and backoff helpers |
  | `plugin-sdk/plugin-runtime` | Shared plugin runtime helpers | Plugin commands/hooks/http/interactive helpers |
  | `plugin-sdk/hook-runtime` | Hook pipeline helpers | Shared webhook/internal hook pipeline helpers |
  | `plugin-sdk/process-runtime` | Process helpers | Shared exec helpers |
  | `plugin-sdk/cli-runtime` | CLI runtime helpers | Command formatting, waits, version helpers |
  | `plugin-sdk/gateway-runtime` | Gateway helpers | Gateway client and channel-status patch helpers |
  | `plugin-sdk/approval-runtime` | Approval prompt helpers | Exec/plugin approval payload, approval capability/profile helpers, native approval routing/runtime helpers |
  | `plugin-sdk/approval-auth-runtime` | Approval auth helpers | Approver resolution, same-chat action auth |
  | `plugin-sdk/approval-client-runtime` | Approval client helpers | Native exec approval profile/filter helpers |
  | `plugin-sdk/approval-delivery-runtime` | Approval delivery helpers | Native approval capability/delivery adapters |
  | `plugin-sdk/approval-native-runtime` | Approval target helpers | Native approval target/account binding helpers |
  | `plugin-sdk/approval-reply-runtime` | Approval reply helpers | Exec/plugin approval reply payload helpers |
  | `plugin-sdk/security-runtime` | Security helpers | Shared trust, DM gating, external-content, and secret-collection helpers |
  | `plugin-sdk/ssrf-policy` | SSRF policy helpers | Host allowlist and private-network policy helpers |
  | `plugin-sdk/ssrf-runtime` | SSRF runtime helpers | Pinned-dispatcher, guarded fetch, SSRF policy helpers |
  | `plugin-sdk/collection-runtime` | Bounded cache helpers | `pruneMapToMaxSize` |
  | `plugin-sdk/diagnostic-runtime` | Diagnostic gating helpers | `isDiagnosticFlagEnabled`, `isDiagnosticsEnabled` |
  | `plugin-sdk/error-runtime` | Error formatting helpers | `formatUncaughtError`, error graph helpers |
  | `plugin-sdk/fetch-runtime` | Wrapped fetch/proxy helpers | `resolveFetch`, proxy helpers |
  | `plugin-sdk/host-runtime` | Host normalization helpers | `normalizeHostname`, `normalizeScpRemoteHost` |
  | `plugin-sdk/retry-runtime` | Retry helpers | `RetryConfig`, `retryAsync`, policy runners |
  | `plugin-sdk/allow-from` | Allowlist formatting | `formatAllowFromLowercase` |
  | `plugin-sdk/allowlist-resolution` | Allowlist input mapping | `mapAllowlistResolutionInputs` |
  | `plugin-sdk/command-auth` | Command gating and command-surface helpers | `resolveControlCommandGate`, sender-authorization helpers, command registry helpers |
  | `plugin-sdk/secret-input` | Secret input parsing | Secret input helpers |
  | `plugin-sdk/webhook-ingress` | Webhook request helpers | Webhook target utilities |
  | `plugin-sdk/webhook-request-guards` | Webhook body guard helpers | Request body read/limit helpers |
  | `plugin-sdk/reply-runtime` | Shared reply runtime | Inbound dispatch, heartbeat, reply planner, chunking |
  | `plugin-sdk/reply-dispatch-runtime` | Narrow reply dispatch helpers | Finalize + provider dispatch helpers |
  | `plugin-sdk/reply-reference` | Reply reference planning | `createReplyReferencePlanner` |
  | `plugin-sdk/reply-chunking` | Reply chunk helpers | Text/markdown chunking helpers |
  | `plugin-sdk/session-store-runtime` | Session store helpers | Store path + updated-at helpers |
  | `plugin-sdk/state-paths` | State path helpers | State and OAuth dir helpers |
  | `plugin-sdk/target-resolver-runtime` | Target resolver helpers | Shared target resolver helpers |
  | `plugin-sdk/string-normalization-runtime` | String normalization helpers | Slug/string normalization helpers |
  | `plugin-sdk/request-url` | Request URL helpers | Extract string URLs from request-like inputs |
  | `plugin-sdk/run-command` | Timed command helpers | Timed command runner with normalized stdout/stderr |
  | `plugin-sdk/param-readers` | Param readers | Common tool/CLI param readers |
  | `plugin-sdk/tool-send` | Tool send extraction | Extract canonical send target fields from tool args |
  | `plugin-sdk/temp-path` | Temp path helpers | Shared temp-download path helpers |
  | `plugin-sdk/logging-core` | Logging helpers | Subsystem logger and redaction helpers |
  | `plugin-sdk/markdown-table-runtime` | Markdown-table helpers | Markdown table mode helpers |
  | `plugin-sdk/reply-payload` | Message reply types | Reply payload types |
  | `plugin-sdk/provider-setup` | Curated local/self-hosted provider setup helpers | Self-hosted provider discovery/config helpers |
  | `plugin-sdk/self-hosted-provider-setup` | Focused OpenAI-compatible self-hosted provider setup helpers | Same self-hosted provider discovery/config helpers |
  | `plugin-sdk/provider-onboard` | Provider onboarding patches | Onboarding config helpers |
  | `plugin-sdk/keyed-async-queue` | Ordered async queue | `KeyedAsyncQueue` |
  | `plugin-sdk/testing` | Test utilities | Test helpers and mocks |
</Accordion>

This table is intentionally the common migration subset, not the full SDK
surface. The generated full list of 200+ entrypoints lives in
`scripts/lib/plugin-sdk-entrypoints.json`.

That generated list still includes some bundled-plugin helper seams such as
`plugin-sdk/feishu`, `plugin-sdk/feishu-setup`, `plugin-sdk/zalo`,
`plugin-sdk/zalo-setup`, and `plugin-sdk/matrix*`. Those remain exported for
bundled-plugin maintenance and compatibility, but they are intentionally
omitted from the common migration table and are not the recommended target for
new plugin code.

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
