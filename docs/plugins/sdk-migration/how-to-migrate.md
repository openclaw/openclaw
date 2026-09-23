---
summary: "Ordered steps for moving a plugin off the removed SDK compatibility layer"
read_when:
  - You are migrating a plugin to the modern plugin SDK right now
  - You need the ordered steps for config, middleware, approval, and import changes
title: "How to migrate a plugin"
sidebarTitle: "How to migrate"
---

The ordered migration steps. Work through them in order; each step is self-contained. Part of the [Plugin SDK migration](/plugins/sdk-migration) guide.

## How to migrate

<Steps>
  <Step title="Migrate runtime config load/write helpers">
    Bundled plugins should stop calling `api.runtime.config.loadConfig()` and
    `api.runtime.config.writeConfigFile(...)` directly. Prefer config already
    passed into the active call path. Long-lived handlers that need the
    current process snapshot can use `api.runtime.config.current()`. Long-lived
    agent tools should read `ctx.getRuntimeConfig()` inside `execute` so a tool
    created before a config write still sees the refreshed config.

    Config writes go through the transactional helper with an explicit
    after-write policy:

    ```typescript
    await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate(draft) {
        draft.plugins ??= {};
      },
    });
    ```

    Use `afterWrite: { mode: "restart", reason: "..." }` when the change needs
    a clean gateway restart, and `afterWrite: { mode: "none", reason: "..." }`
    only when the caller owns the follow-up and deliberately suppresses the
    reload planner. Mutation results include a typed `followUp` summary for
    tests and logging; the gateway remains responsible for applying or
    scheduling the restart.

    `loadConfig` and `writeConfigFile` have been removed from the plugin
    runtime. Bundled plugins and repo runtime code are guarded by
    `pnpm check:deprecated-api-usage` and
    `pnpm check:no-runtime-action-load-config`: new production plugin usage
    fails outright, direct config writes fail, gateway server methods must use
    the request runtime snapshot, runtime channel send/action/client helpers
    must receive config from their boundary, and long-lived runtime modules
    allow zero ambient `loadConfig()` calls.

    New plugin code should avoid the broad `openclaw/plugin-sdk/config-runtime`
    barrel. Use the narrow subpath for the job:

    | Need | Import |
    | --- | --- |
    | Config types such as `OpenClawConfig` | `openclaw/plugin-sdk/config-contracts` |
    | Plugin-entry config lookup | `api.pluginConfig` |
    | Config merging | Plugin-local logic at the config boundary |
    | Current runtime snapshot reads | `openclaw/plugin-sdk/runtime-config-snapshot` |
    | Config writes | `openclaw/plugin-sdk/config-mutation` |
    | Session store helpers | `openclaw/plugin-sdk/session-store-runtime` |
    | Markdown table config | `api.runtime.channel.text.resolveMarkdownTableMode` |
    | Channel group policy, mention requirements, and sender tool policy | `openclaw/plugin-sdk/channel-policy` |
    | Provider-default group-policy fallback helpers | `openclaw/plugin-sdk/runtime-group-policy` |
    | Secret input resolution | `openclaw/plugin-sdk/secret-input-runtime` |
    | Model/session overrides | `openclaw/plugin-sdk/model-session-runtime` |

    `api.pluginConfig` is registration-scoped, not a live getter. Replacing
    `resolveLivePluginConfigObject(...)` requires preserving freshness through
    the current config supplied by the runtime boundary. The injected markdown
    resolver preserves channel/account precedence and channel defaults;
    `markdown-table-runtime` is a private, JavaScript-only host export.

    Check named types separately. `config-contracts` does not export `TtsMode`,
    `TtsPersonaConfig`, `TtsPersonaFallbackPolicy`, or `SessionResetMode`;
    `session-store-runtime` does not export `SessionResetMode` either. Existing
    callers needing those names must keep retained type imports or explicitly
    adapt their types. Talk config, cron-store operations, context-visibility
    config resolution, and dangerous-name checks also lack a complete modern
    typed-public mapping. Missing public contracts require an SDK-owner decision,
    not an import of the private focused implementation.

    Bundled plugins and their tests are scanner-guarded against the broad
    barrel so imports and mocks stay local to the behavior they need. The
    barrel still exists for external compatibility, but new code should not
    depend on it.

  </Step>

  <Step title="Migrate embedded tool-result extensions to middleware">
    Bundled plugins must replace embedded-runner-only
    `api.registerEmbeddedExtensionFactory(...)` tool-result handlers with
    runtime-neutral middleware:

    ```typescript
    // OpenClaw runtime tools and Codex runtime dynamic tools (result may be
    // transformed). Codex-native tool results are also relayed for observation,
    // but their transformed output never reaches the model: the Codex
    // PostToolUse hook contract cannot replace a native tool response.
    api.registerAgentToolResultMiddleware(async (event) => {
      return compactToolResult(event);
    }, {
      runtimes: ["openclaw", "codex"],
    });
    ```

    Update the plugin manifest at the same time:

    ```json
    {
      "contracts": {
        "agentToolResultMiddleware": ["openclaw", "codex"]
      }
    }
    ```

    Installed plugins can also register tool-result middleware when explicitly
    enabled and every targeted runtime is declared in
    `contracts.agentToolResultMiddleware`. Undeclared installed middleware
    registrations are rejected.

  </Step>

  <Step title="Migrate approval-native handlers to capability facts">
    Approval-capable channel plugins expose native approval behavior through
    `approvalCapability.nativeRuntime` plus the shared runtime-context
    registry:

    - Replace `approvalCapability.handler.loadRuntime(...)` with
      `approvalCapability.nativeRuntime`.
    - Move approval-specific auth/delivery off legacy `plugin.auth` /
      `plugin.approvals` wiring and onto `approvalCapability`.
    - `ChannelPlugin.approvals` has been removed from the public
      channel-plugin contract; move delivery/native/render fields onto
      `approvalCapability`.
    - `plugin.auth` remains for channel login/logout flows only; core no
      longer reads approval auth hooks there.
    - Register channel-owned runtime objects (clients, tokens, Bolt apps)
      through `openclaw/plugin-sdk/channel-runtime-context`.
    - Do not send plugin-owned reroute notices from native approval handlers;
      core owns routed-elsewhere notices from actual delivery results.
    - When passing `channelRuntime` into `createChannelManager(...)`, provide a
      real `createPluginRuntime().channel` surface - partial stubs are
      rejected.

    See [Channel Plugins](/plugins/sdk-channel-plugins) for the current
    approval capability layout.

  </Step>

  <Step title="Audit Windows wrapper fallback behavior">
    If your plugin uses `openclaw/plugin-sdk/windows-spawn`, unresolved Windows
    `.cmd`/`.bat` wrappers now fail closed unless you explicitly pass
    `allowShellFallback: true`:

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
    ```bash
    grep -r "plugin-sdk/compat" my-plugin/
    grep -r "plugin-sdk/infra-runtime" my-plugin/
    grep -r "plugin-sdk/config-runtime" my-plugin/
    grep -r "openclaw/extension-api" my-plugin/
    ```
  </Step>

  <Step title="Replace with focused imports">
    Check the exported name and typed-public contract as well as the import
    path. Some functions are renamed; not every retained helper or named type
    has a modern public replacement:

    ```typescript
    // Before (deprecated backwards-compatibility layer)
    import {
      createChannelReplyPipeline,
      createPluginRuntimeStore,
    } from "openclaw/plugin-sdk/compat";

    // After (modern focused imports)
    import {
      createChannelMessageReplyPipeline as createChannelReplyPipeline,
    } from "openclaw/plugin-sdk/channel-outbound";
    import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
    ```

    The explicit alias preserves existing `createChannelReplyPipeline(...)`
    call sites. The modern export is `createChannelMessageReplyPipeline`;
    see [Retained channel facade mappings](/plugins/sdk-migration/import-paths#retained-channel-facade-mappings)
    for the remaining functions and named types.

    For host-side helpers, use the injected plugin runtime instead of
    importing directly:

    ```typescript
    // Before (deprecated extension-api bridge)
    import { runEmbeddedAgent } from "openclaw/extension-api";
    const result = await runEmbeddedAgent({ sessionId, prompt });

    // After (injected runtime)
    const result = await api.runtime.agent.runEmbeddedAgent({ sessionId, prompt });
    ```

    Same pattern for other legacy bridge helpers:

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

  <Step title="Replace broad infra-runtime imports">
    `openclaw/plugin-sdk/infra-runtime` still exists for external
    compatibility, but new code should use the supported surface it actually
    needs:

    | Need | Typed-public import or injected API |
    | --- | --- |
    | New system event producers | `api.runtime.system.enqueueSystemEvent` |
    | Heartbeat wake requests | `api.runtime.system.requestHeartbeat` |
    | Channel activity telemetry | `api.runtime.channel.activity.record` and `.get` |
    | `createDedupeCache`, `resolveGlobalDedupeCache` | `openclaw/plugin-sdk/dedupe-runtime` |
    | Safe local-file/media paths, regular-file checks, and symlink-parent checks | `openclaw/plugin-sdk/security-runtime` (itself a deprecated broad barrel) |
    | `fetchWithSsrFGuard`, pinned-dispatcher helpers, `LookupFn`, `SsrFPolicy` | `openclaw/plugin-sdk/ssrf-runtime` |
    | Approval request/resolution types | `openclaw/plugin-sdk/approval-runtime` |
    | Approval reply payload and command helpers | `openclaw/plugin-sdk/approval-reply-runtime` |
    | `collectErrorGraphCandidates`, `extractErrorCode`, `formatErrorMessage`, `formatUncaughtError`, `readErrorName`, `toErrorObject` | `openclaw/plugin-sdk/error-runtime` |
    | `generateSecureToken`, `generateSecureUuid` | `openclaw/plugin-sdk/core` |
    | `parseFiniteNumber`, `parseStrictFiniteNumber`, `parseStrictInteger`, `parseStrictNonNegativeInteger`, `parseStrictPositiveInteger` | `openclaw/plugin-sdk/string-coerce-runtime` |

    These are symbol-specific mappings, not replacements for the whole barrel.
    Private-local entries such as `heartbeat-runtime`, `delivery-queue-runtime`,
    `fetch-runtime`, `runtime-fetch`, and `file-lock` are JavaScript-only host
    exports, not typed third-party APIs. Heartbeat event/summary/visibility
    helpers, pending-delivery drain, transport readiness, concurrency, and file
    locking do not have equivalent modern typed-public mappings here. Retain
    existing compatibility imports for those operations pending an SDK-owner
    decision.

    `fetchWithSsrFGuard` is not a drop-in replacement for dispatcher-aware fetch:
    it takes an options object and returns `{ response, finalUrl, release, ... }`,
    not a bare `Response`; callers must release its resources. The named types
    `PinnedDispatcherPolicy`, `GuardedFetchOptions`, and `GuardedFetchResult`
    are not exported by `ssrf-runtime`. Similarly, `dedupe-runtime` does not
    export the legacy `DedupeCache` or `DedupeCacheOptions` names. Migrate type
    usage explicitly rather than assuming a function move also moves its types.

    The error mapping does not cover `hasErrnoCode`, `isErrno`,
    `stringifyNonErrorCause`, `ErrorKind`, or `detectErrorKind`; the last helper
    preserves legacy substring classification. The numeric and random mappings
    likewise do not cover every timer, expiry, hex, fraction, or integer helper.
    Keep unsupported retained imports until their public contract is resolved.

    System event snapshot inspection and consume helpers remain available only
    through the deprecated `openclaw/plugin-sdk/infra-runtime` compatibility
    surface; there is no modern public replacement. Current snapshots carry an
    opaque `id` for one queued occurrence. Preserve it through copies and
    serialization when returning a snapshot to consume. Legacy ID-less callers
    retain structural matching, which can be ambiguous after queue churn. Do
    not treat the ID as persistent or valid across restarts.

    File-lock nesting is owner-scoped. Pass the same `reentrantOwner` only for
    nested acquisitions in one logical operation; omit it for ordinary locking.
    Never use a process-wide constant, because unrelated work would incorrectly
    share the critical section.

    Bundled plugins are scanner-guarded against `infra-runtime`, so repo code
    cannot regress to the broad barrel.

  </Step>

  <Step title="Migrate channel route helpers">
    New channel route code uses `openclaw/plugin-sdk/channel-route`. The older
    route-key names remain as compatibility aliases:

    | Old helper | Modern helper |
    | --- | --- |
    | `channelRouteIdentityKey(...)` | `channelRouteDedupeKey(...)` |
    | `channelRouteKey(...)` | `channelRouteCompactKey(...)` |

    The modern route helpers normalize `{ channel, to, accountId, threadId }`
    consistently across native approvals, reply suppression, inbound dedupe,
    cron delivery, and session routing.

    Channel plugins use `messaging.targetResolver.resolveTarget(...)` for target-id normalization
    and directory-miss fallback,
    `messaging.inferTargetChatType(...)` when core needs an early peer kind,
    and `messaging.resolveOutboundSessionRoute(...)` for provider-native
    session and thread identity.

  </Step>

  <Step title="Build and test">
    ```bash
    pnpm build
    pnpm test my-plugin/
    ```
  </Step>
</Steps>
