# Upstream Update Summary (v2): v2026.4.1 → v2026.5.12

This is a high-level summary of what we’d incorporate by updating Polytropos from upstream v2026.4.1 to upstream v2026.5.12.

## Evidence gathered

- Directory heatmaps computed via aggregated at depth=3.
- Merge conflict check performed via a throwaway branch dry-run merge.
- Release-notes/changelog sources enumerated from the upstream tree.

## Release notes / changelog sources (candidates)

The repo doesn’t have an obvious single root with per-tag sections. These are the most likely in-tree sources to mine for curated notes:

## Change surface (depth=3 hot spots)

Top changed areas by file count (depth=3):

## What changed (summary)

From the hot spots + commit subjects, the major themes in this range appear to be:

1. **Extension/provider work continues heavily**
   - Large churn under including provider-specific runtime + integration logic.
   - Expect behavior changes and new edge-case handling in channel adapters.

2. **Core runtime hardening around secrets, security, daemon/gateway, and cron**
   - Churn in , , , suggests ongoing reliability/security work.

3. **CI/release machinery changes**
   - Significant + release tooling churn: expect changes in how releases are built/verified/published.

4. **Memory/media subsystems**
   - Changes under memory/media-related packages and subsystems imply internal refactors and bugfixes.

## Representative diffs (stat-only)

Below are stat-only summaries for a small set of the hottest directories.

### extensions/discord/src

extensions/discord/src/account-inspect.test.ts | 2 +-
extensions/discord/src/account-inspect.ts | 14 +-
extensions/discord/src/accounts.test.ts | 211 +-
extensions/discord/src/accounts.ts | 121 +-
.../src/actions/handle-action.guild-admin.ts | 84 +-
.../discord/src/actions/handle-action.test.ts | 348 ++-
extensions/discord/src/actions/handle-action.ts | 107 +-
extensions/discord/src/actions/runtime.guild.ts | 350 +--
.../src/actions/runtime.messaging.messages.ts | 205 ++
.../src/actions/runtime.messaging.reactions.ts | 67 +
.../src/actions/runtime.messaging.runtime.ts | 69 +
.../discord/src/actions/runtime.messaging.send.ts | 248 ++
.../src/actions/runtime.messaging.shared.ts | 97 +
.../discord/src/actions/runtime.messaging.ts | 654 +----
.../src/actions/runtime.moderation.authz.test.ts | 111 +-
.../discord/src/actions/runtime.moderation.ts | 81 +-
.../discord/src/actions/runtime.presence.test.ts | 13 +-
extensions/discord/src/actions/runtime.presence.ts | 20 +-
extensions/discord/src/actions/runtime.shared.ts | 72 +-
extensions/discord/src/actions/runtime.test.ts | 631 +++--
extensions/discord/src/actions/runtime.ts | 14 +-
extensions/discord/src/api-barrel.test.ts | 80 +
extensions/discord/src/api.test.ts | 82 +-
extensions/discord/src/api.ts | 115 +-
.../discord/src/approval-handler.runtime.test.ts | 41 +
extensions/discord/src/approval-handler.runtime.ts | 636 +++++
extensions/discord/src/approval-native.test.ts | 179 +-
extensions/discord/src/approval-native.ts | 179 +-
extensions/discord/src/approval-runtime.ts | 14 +
extensions/discord/src/approval-shared.ts | 56 +
extensions/discord/src/audit-core.ts | 178 ++
extensions/discord/src/audit.test.ts | 118 +-
extensions/discord/src/audit.ts | 136 +-
.../discord/src/channel-actions.contract.test.ts | 45 +
extensions/discord/src/channel-actions.runtime.ts | 1 +
extensions/discord/src/channel-actions.test.ts | 395 ++-
extensions/discord/src/channel-actions.ts | 124 +-
extensions/discord/src/channel-api.ts | 29 +
extensions/discord/src/channel.conversation.ts | 159 ++
extensions/discord/src/channel.loaders.ts | 50 +

### src/auto-reply/reply

src/auto-reply/reply/abort-cutoff.ts | 17 +-
src/auto-reply/reply/abort-primitives.ts | 10 +-
src/auto-reply/reply/abort.runtime-types.ts | 15 +
src/auto-reply/reply/abort.test.ts | 47 +-
src/auto-reply/reply/abort.ts | 78 +-
src/auto-reply/reply/acp-projector.test.ts | 59 +-
src/auto-reply/reply/acp-projector.ts | 40 +-
src/auto-reply/reply/acp-reset-target.ts | 45 +-
src/auto-reply/reply/acp-stream-settings.test.ts | 4 +-
src/auto-reply/reply/acp-stream-settings.ts | 4 +-
src/auto-reply/reply/agent-runner-auth-profile.ts | 20 +-
.../agent-runner-direct-runtime-config.test.ts | 327 ++
.../reply/agent-runner-execution.runtime.ts | 1 -
.../reply/agent-runner-execution.test.ts | 3265 ++++++++++++-
src/auto-reply/reply/agent-runner-execution.ts | 1743 ++++++-
src/auto-reply/reply/agent-runner-helpers.test.ts | 53 +-
src/auto-reply/reply/agent-runner-helpers.ts | 42 +-
.../reply/agent-runner-memory.dedup.test.ts | 2 +-
.../reply/agent-runner-memory.runtime.ts | 1 -
src/auto-reply/reply/agent-runner-memory.test.ts | 1084 +++++
src/auto-reply/reply/agent-runner-memory.ts | 432 +-
src/auto-reply/reply/agent-runner-payloads.test.ts | 523 +-
src/auto-reply/reply/agent-runner-payloads.ts | 333 +-
.../reply/agent-runner-reminder-guard.ts | 7 +-
src/auto-reply/reply/agent-runner-run-params.ts | 96 +
.../reply/agent-runner-runtime-config.test.ts | 78 +
.../reply/agent-runner-session-reset.test.ts | 146 +
src/auto-reply/reply/agent-runner-session-reset.ts | 142 +
src/auto-reply/reply/agent-runner-usage-line.ts | 23 +-
.../agent-runner-utils.secret-resolution.test.ts | 191 +
src/auto-reply/reply/agent-runner-utils.test.ts | 107 +-
src/auto-reply/reply/agent-runner-utils.ts | 180 +-
.../reply/agent-runner.media-paths.test.ts | 285 +-
.../reply/agent-runner.misc.runreplyagent.test.ts | 2368 +++++----
.../reply/agent-runner.runreplyagent.e2e.test.ts | 2611 ++++------
src/auto-reply/reply/agent-runner.test-fixtures.ts | 42 +
src/auto-reply/reply/agent-runner.ts | 1874 +++++++-
src/auto-reply/reply/auto-topic-label-config.ts | 36 -
src/auto-reply/reply/auto-topic-label.test.ts | 174 -
src/auto-reply/reply/auto-topic-label.ts | 101 -

### extensions/telegram/src

extensions/telegram/src/access-groups.ts | 72 +
extensions/telegram/src/account-config.ts | 80 +
extensions/telegram/src/account-inspect.test.ts | 4 +-
extensions/telegram/src/account-inspect.ts | 35 +-
extensions/telegram/src/account-selection.ts | 151 +
extensions/telegram/src/account-throttler.test.ts | 17 +
extensions/telegram/src/account-throttler.ts | 21 +
extensions/telegram/src/accounts.test.ts | 233 +-
extensions/telegram/src/accounts.ts | 134 +-
extensions/telegram/src/action-runtime.test.ts | 594 ++--
extensions/telegram/src/action-runtime.ts | 205 +-
extensions/telegram/src/action-threading.test.ts | 39 +-
extensions/telegram/src/action-threading.ts | 9 +-
extensions/telegram/src/agent-config.ts | 21 +
extensions/telegram/src/allow-from.ts | 6 +
extensions/telegram/src/allowed-updates.test.ts | 18 +-
extensions/telegram/src/allowed-updates.ts | 54 +-
extensions/telegram/src/api-fetch.test.ts | 39 +-
extensions/telegram/src/api-fetch.ts | 2 +-
extensions/telegram/src/api-logging.ts | 2 +-
extensions/telegram/src/api-root.test.ts | 38 +
extensions/telegram/src/api-root.ts | 49 +
extensions/telegram/src/approval-buttons.ts | 44 -
.../telegram/src/approval-callback-data.test.ts | 33 +
extensions/telegram/src/approval-callback-data.ts | 23 +
.../telegram/src/approval-handler.runtime.test.ts | 121 +
.../telegram/src/approval-handler.runtime.ts | 195 ++
extensions/telegram/src/approval-native.test.ts | 100 +-
extensions/telegram/src/approval-native.ts | 169 +-
.../telegram/src/audit-membership-runtime.ts | 9 +-
extensions/telegram/src/audit.test.ts | 24 +-
extensions/telegram/src/audit.ts | 47 +-
extensions/telegram/src/audit.types.ts | 29 +
extensions/telegram/src/auto-topic-label-config.ts | 24 +
extensions/telegram/src/auto-topic-label.test.ts | 60 +
extensions/telegram/src/auto-topic-label.ts | 16 +
extensions/telegram/src/bot-access.ts | 42 +-
extensions/telegram/src/bot-core.ts | 643 ++++
extensions/telegram/src/bot-deps.ts | 34 +-
.../telegram/src/bot-handlers.agent.runtime.ts | 5 +

### ui/src/ui

ui/src/ui/app-channels.test.ts | 148 ++
ui/src/ui/app-channels.ts | 91 +-
ui/src/ui/app-chat.test.ts | 1449 ++++++++++++-
ui/src/ui/app-chat.ts | 649 +++++-
ui/src/ui/app-defaults.test.ts | 11 +
ui/src/ui/app-defaults.ts | 5 +
ui/src/ui/app-gateway-chat-load.node.test.ts | 231 ++
ui/src/ui/app-gateway.node.test.ts | 846 +++++++-
ui/src/ui/app-gateway.sessions.node.test.ts | 296 ++-
ui/src/ui/app-gateway.ts | 541 ++++-
ui/src/ui/app-last-active-session.ts | 14 +
ui/src/ui/app-lifecycle-connect.node.test.ts | 52 +-
ui/src/ui/app-lifecycle.node.test.ts | 30 +-
ui/src/ui/app-lifecycle.ts | 64 +-
ui/src/ui/app-native-bridge.test.ts | 196 ++
ui/src/ui/app-native-bridge.ts | 70 +
ui/src/ui/app-polling.node.test.ts | 62 +
ui/src/ui/app-polling.ts | 20 +-
ui/src/ui/app-render-usage-tab.ts | 41 +
ui/src/ui/app-render.assistant-avatar.test.ts | 296 +++
ui/src/ui/app-render.exec-policy.test.ts | 81 +
ui/src/ui/app-render.helpers.browser.test.ts | 265 +++
ui/src/ui/app-render.helpers.node.test.ts | 853 +++++++-
ui/src/ui/app-render.helpers.ts | 912 +++-----
ui/src/ui/app-render.ts | 2197 +++++++++++++-------
ui/src/ui/app-scroll.test.ts | 218 ++
ui/src/ui/app-scroll.ts | 45 +
.../app-settings.refresh-active-tab.node.test.ts | 453 ++++
ui/src/ui/app-settings.test.ts | 266 ++-
ui/src/ui/app-settings.ts | 647 ++++--
ui/src/ui/app-tool-stream.node.test.ts | 274 ++-
ui/src/ui/app-tool-stream.ts | 164 +-
ui/src/ui/app-view-state.ts | 145 +-
ui/src/ui/app.talk.test.ts | 66 +
ui/src/ui/app.ts | 610 +++++-
ui/src/ui/assistant-identity.test.ts | 27 +
ui/src/ui/assistant-identity.ts | 47 +-
ui/src/ui/canvas-url.test.ts | 39 +
ui/src/ui/canvas-url.ts | 74 +
ui/src/ui/chat-event-reload.test.ts | 38 +-

### extensions/browser/src

extensions/browser/src/browser-control-state.ts | 70 +
extensions/browser/src/browser-gateway-contract.ts | 3 +
extensions/browser/src/browser-runtime.ts | 3 +
extensions/browser/src/browser-tool.actions.ts | 252 ++-
extensions/browser/src/browser-tool.runtime.ts | 48 +
extensions/browser/src/browser-tool.schema.ts | 10 +-
extensions/browser/src/browser-tool.test.ts | 935 ++++++++---
extensions/browser/src/browser-tool.ts | 282 +++-
extensions/browser/src/browser/act-policy.ts | 44 +
.../browser/src/browser/bridge-auth-registry.ts | 6 +-
.../browser/src/browser/bridge-server.auth.test.ts | 15 +-
extensions/browser/src/browser/bridge-server.ts | 55 +-
.../browser/src/browser/browser-proxy-mode.test.ts | 53 +
.../browser/src/browser/browser-proxy-mode.ts | 55 +
.../browser/src/browser/browser-utils.test.ts | 21 +-
.../browser/src/browser/cdp-proxy-bypass.test.ts | 60 +-
.../browser/src/browser/cdp-reachability-policy.ts | 33 +
.../browser/src/browser/cdp-target-filter.ts | 22 +
.../browser/src/browser/cdp-timeouts.test.ts | 69 -
extensions/browser/src/browser/cdp-timeouts.ts | 21 +-
.../browser/src/browser/cdp.helpers.fuzz.test.ts | 438 ++++++
.../src/browser/cdp.helpers.internal.test.ts | 503 ++++++
extensions/browser/src/browser/cdp.helpers.test.ts | 269 ++++
extensions/browser/src/browser/cdp.helpers.ts | 341 +++-
.../browser/src/browser/cdp.internal.test.ts | 1189 ++++++++++++++
.../src/browser/cdp.screenshot-params.test.ts | 162 +-
extensions/browser/src/browser/cdp.test.ts | 372 ++++-
extensions/browser/src/browser/cdp.ts | 848 ++++++++--
.../browser/src/browser/chrome-mcp.runtime.ts | 5 +
.../browser/src/browser/chrome-mcp.snapshot.ts | 17 +-
extensions/browser/src/browser/chrome-mcp.test.ts | 479 +++++-
extensions/browser/src/browser/chrome-mcp.ts | 825 ++++++++--
.../src/browser/chrome.default-browser.test.ts | 56 +-
.../browser/src/browser/chrome.diagnostics.ts | 398 +++++
.../browser/src/browser/chrome.executables.ts | 88 +-
.../browser/src/browser/chrome.internal.test.ts | 1306 ++++++++++++++++
.../browser/src/browser/chrome.launch-args.test.ts | 46 -
.../chrome.loopback-ssrf.integration.test.ts | 70 +
.../src/browser/chrome.profile-decoration.ts | 89 +-
extensions/browser/src/browser/chrome.test.ts | 565 ++++++-

### extensions/matrix/src

extensions/matrix/src/account-selection.test.ts | 141 ++
extensions/matrix/src/account-selection.ts | 150 +-
.../matrix/src/actions.account-propagation.test.ts | 164 +-
extensions/matrix/src/actions.test.ts | 111 +-
extensions/matrix/src/actions.ts | 113 +-
extensions/matrix/src/approval-auth.ts | 25 +-
.../matrix/src/approval-handler.runtime.test.ts | 567 +++++
extensions/matrix/src/approval-handler.runtime.ts | 585 +++++
extensions/matrix/src/approval-ids.ts | 6 +
extensions/matrix/src/approval-native.test.ts | 329 +++
extensions/matrix/src/approval-native.ts | 348 +++
extensions/matrix/src/approval-reaction-auth.ts | 45 +
extensions/matrix/src/approval-reactions.test.ts | 187 ++
extensions/matrix/src/approval-reactions.ts | 313 +++
extensions/matrix/src/channel-account-paths.ts | 97 +
.../matrix/src/channel.account-paths.test.ts | 30 +-
extensions/matrix/src/channel.directory.test.ts | 179 +-
.../matrix/src/channel.message-adapter.test.ts | 245 +++
extensions/matrix/src/channel.resolve.test.ts | 33 +-
extensions/matrix/src/channel.runtime.ts | 3 +-
extensions/matrix/src/channel.setup.test.ts | 57 +-
extensions/matrix/src/channel.setup.ts | 48 +
extensions/matrix/src/channel.ts | 426 ++--
extensions/matrix/src/cli-metadata.ts | 19 +
extensions/matrix/src/cli.test.ts | 1075 ++++++++-
extensions/matrix/src/cli.ts | 1307 ++++++++++-
extensions/matrix/src/config-adapter.ts | 41 +
extensions/matrix/src/config-schema.test.ts | 94 +
extensions/matrix/src/config-schema.ts | 64 +-
extensions/matrix/src/config-ui-hints.ts | 28 +
extensions/matrix/src/directory-live.test.ts | 37 +-
extensions/matrix/src/directory-live.ts | 33 +-
extensions/matrix/src/doctor-contract.ts | 287 +++
extensions/matrix/src/doctor.test.ts | 403 ++++
extensions/matrix/src/doctor.ts | 262 +++
.../matrix/src/exec-approval-resolver.test.ts | 68 +
extensions/matrix/src/exec-approval-resolver.ts | 23 +
extensions/matrix/src/exec-approvals.test.ts | 483 +++++
extensions/matrix/src/exec-approvals.ts | 293 +++
extensions/matrix/src/group-mentions.test.ts | 29 +

### src/agents/pi-embedded-runner

src/agents/pi-embedded-runner/abort.ts | 6 +-
src/agents/pi-embedded-runner/aliases.test.ts | 17 +
.../anthropic-cache-control-payload.test.ts | 35 +
.../anthropic-cache-control-payload.ts | 1 +
.../anthropic-cache-retention.ts | 30 -
.../anthropic-family-cache-semantics.ts | 106 +
.../anthropic-family-tool-payload-compat.ts | 102 +-
.../pi-embedded-runner/bedrock-stream-wrappers.ts | 16 -
src/agents/pi-embedded-runner/cache-ttl.test.ts | 133 +-
src/agents/pi-embedded-runner/cache-ttl.ts | 81 +-
.../pi-embedded-runner/compact-reasons.test.ts | 32 +-
src/agents/pi-embedded-runner/compact-reasons.ts | 21 +-
.../pi-embedded-runner/compact.hooks.harness.ts | 361 +-
.../pi-embedded-runner/compact.hooks.test.ts | 864 ++++-
src/agents/pi-embedded-runner/compact.queued.ts | 354 ++
src/agents/pi-embedded-runner/compact.runtime.ts | 14 +-
.../pi-embedded-runner/compact.runtime.types.ts | 6 +
src/agents/pi-embedded-runner/compact.ts | 1535 +++++----
src/agents/pi-embedded-runner/compact.types.ts | 91 +
.../compaction-duplicate-user-messages.test.ts | 76 +
.../compaction-duplicate-user-messages.ts | 109 +
src/agents/pi-embedded-runner/compaction-hooks.ts | 45 +-
.../compaction-runtime-context.test.ts | 171 +-
.../compaction-runtime-context.ts | 22 +-
.../compaction-safety-timeout.ts | 2 +-
.../compaction-successor-transcript.test.ts | 472 +++
.../compaction-successor-transcript.ts | 289 ++
.../context-engine-capabilities.ts | 85 +
.../context-engine-maintenance.test.ts | 1159 ++++++-
.../context-engine-maintenance.ts | 645 +++-
.../context-truncation-notice.ts | 5 +
src/agents/pi-embedded-runner/delivery-evidence.ts | 124 +
.../effective-tool-policy.test.ts | 186 ++
.../pi-embedded-runner/effective-tool-policy.ts | 179 +
.../pi-embedded-runner/empty-assistant-turn.ts | 57 +
src/agents/pi-embedded-runner/extensions.test.ts | 61 +-
src/agents/pi-embedded-runner/extensions.ts | 88 +-
.../extra-params.cache-retention-default.test.ts | 196 +-
.../pi-embedded-runner/extra-params.google.test.ts | 86 +-
.../extra-params.kilocode.test.ts | 4 +-

### extensions/slack/src

extensions/slack/src/account-inspect.ts | 3 +-
extensions/slack/src/account-reply-mode.ts | 37 +
extensions/slack/src/account-surface-fields.ts | 2 +-
extensions/slack/src/accounts.runtime.ts | 1 +
extensions/slack/src/accounts.test.ts | 335 +++-
extensions/slack/src/accounts.ts | 133 +-
extensions/slack/src/action-runtime.runtime.ts | 1 +
extensions/slack/src/action-runtime.test.ts | 492 +++--
extensions/slack/src/action-runtime.ts | 216 ++-
extensions/slack/src/action-threading.test.ts | 17 +-
extensions/slack/src/action-threading.ts | 13 +-
extensions/slack/src/actions.blocks.test.ts | 99 +-
extensions/slack/src/actions.download-file.test.ts | 101 +-
extensions/slack/src/actions.reactions.test.ts | 157 ++
extensions/slack/src/actions.read.test.ts | 55 +
extensions/slack/src/actions.runtime.ts | 16 +
extensions/slack/src/actions.ts | 145 +-
extensions/slack/src/approval-auth.ts | 11 +-
.../slack/src/approval-handler.runtime.test.ts | 251 +++
extensions/slack/src/approval-handler.runtime.ts | 352 ++++
extensions/slack/src/approval-native.test.ts | 199 +-
extensions/slack/src/approval-native.ts | 183 +-
extensions/slack/src/block-kit-tables.test.ts | 68 -
extensions/slack/src/block-kit-tables.ts | 134 --
extensions/slack/src/blocks-fallback.test.ts | 31 -
extensions/slack/src/blocks-input.test.ts | 57 -
extensions/slack/src/blocks-render.ts | 174 +-
extensions/slack/src/blocks.test-helpers.ts | 16 +-
extensions/slack/src/blocks.test.ts | 145 ++
.../channel-actions-setup-status.contract.test.ts | 137 ++
extensions/slack/src/channel-actions.ts | 83 +-
extensions/slack/src/channel-api.ts | 27 +
extensions/slack/src/channel-migration.ts | 9 +-
extensions/slack/src/channel-type.test.ts | 201 ++
extensions/slack/src/channel-type.ts | 103 +-
extensions/slack/src/channel.lazy-seams.test.ts | 358 ++++
.../slack/src/channel.message-adapter.test.ts | 228 +++
extensions/slack/src/channel.runtime.ts | 5 -
extensions/slack/src/channel.setup.ts | 89 +-
extensions/slack/src/channel.test.ts | 880 +++++++--

### src/channels/plugins

src/channels/plugins/account-helpers.ts | 36 +-
src/channels/plugins/acp-bindings.test.ts | 61 +-
.../plugins/acp-configured-binding-consumer.ts | 9 +-
.../plugins/acp-stateful-target-driver.test.ts | 77 ++
src/channels/plugins/acp-stateful-target-driver.ts | 51 +-
.../plugins/acp-stateful-target-reset.runtime.ts | 1 +
.../actions/discord/handle-action.guild-admin.ts | 1 -
.../plugins/actions/discord/handle-action.ts | 1 -
src/channels/plugins/allowlist-match.ts | 2 +-
src/channels/plugins/approval-native.types.ts | 44 +
src/channels/plugins/approvals.test.ts | 76 ++
src/channels/plugins/approvals.ts | 31 +-
src/channels/plugins/binding-provider.ts | 11 -
src/channels/plugins/binding-routing.test.ts | 178 ++++
src/channels/plugins/binding-routing.ts | 114 +-
src/channels/plugins/binding-targets.test.ts | 2 +
src/channels/plugins/binding-targets.ts | 38 +-
src/channels/plugins/binding-types.ts | 4 +-
src/channels/plugins/bluebubbles-actions.ts | 34 -
src/channels/plugins/bootstrap-registry.ts | 108 ++
src/channels/plugins/bundled-ids.ts | 29 +
src/channels/plugins/bundled-root-caches.test.ts | 237 +++++
src/channels/plugins/bundled-root.ts | 50 +
src/channels/plugins/bundled.shape-guard.test.ts | 944 ++++++++++++++++-
src/channels/plugins/bundled.ts | 906 +++++++++++++---
src/channels/plugins/catalog.test.ts | 23 +
src/channels/plugins/catalog.ts | 307 +++---
src/channels/plugins/channel-id.types.ts | 3 +
src/channels/plugins/channel-meta.ts | 63 ++
.../plugins/channel-runtime-surface.types.ts | 44 +
src/channels/plugins/chat-target-prefixes.ts | 22 +-
src/channels/plugins/config-helpers.ts | 2 +-
src/channels/plugins/config-schema.test.ts | 69 +-
src/channels/plugins/config-schema.ts | 93 +-
src/channels/plugins/config-write-policy-shared.ts | 206 ++++
src/channels/plugins/config-writes.ts | 190 +---
.../plugins/configured-binding-builtins.ts | 9 +-
.../plugins/configured-binding-compiler.ts | 48 +-
.../plugins/configured-binding-consumers.ts | 6 +-
src/channels/plugins/configured-binding-match.ts | 8 +-

### extensions/qqbot/src

extensions/qqbot/src/api.ts | 991 -------------
extensions/qqbot/src/bridge/approval/capability.ts | 237 ++++
.../qqbot/src/bridge/approval/handler-runtime.ts | 204 +++
extensions/qqbot/src/bridge/bootstrap.ts | 135 ++
extensions/qqbot/src/bridge/channel-entry.ts | 18 +
.../commands/framework-context-adapter.test.ts | 55 +
.../bridge/commands/framework-context-adapter.ts | 60 +
.../bridge/commands/framework-registration.test.ts | 118 ++
.../src/bridge/commands/framework-registration.ts | 66 +
.../qqbot/src/bridge/commands/from-parser.test.ts | 86 ++
.../qqbot/src/bridge/commands/from-parser.ts | 60 +
.../qqbot/src/bridge/commands/result-dispatcher.ts | 76 +
extensions/qqbot/src/bridge/config-shared.ts | 132 ++
extensions/qqbot/src/bridge/config.ts | 176 +++
extensions/qqbot/src/bridge/gateway.ts | 179 +++
extensions/qqbot/src/bridge/logger.ts | 31 +
extensions/qqbot/src/bridge/narrowing.ts | 31 +
extensions/qqbot/src/bridge/plugin-version.test.ts | 146 ++
extensions/qqbot/src/bridge/plugin-version.ts | 102 ++
extensions/qqbot/src/bridge/runtime.ts | 25 +
extensions/qqbot/src/bridge/sdk-adapter.ts | 167 +++
extensions/qqbot/src/bridge/setup/finalize.ts | 144 ++
extensions/qqbot/src/bridge/setup/surface.ts | 34 +
extensions/qqbot/src/bridge/tools/channel.ts | 58 +
extensions/qqbot/src/bridge/tools/index.ts | 15 +
extensions/qqbot/src/bridge/tools/remind.test.ts | 141 ++
extensions/qqbot/src/bridge/tools/remind.ts | 91 ++
.../qqbot/src/channel.message-adapter.test.ts | 89 ++
extensions/qqbot/src/channel.setup.ts | 150 +-
extensions/qqbot/src/channel.ts | 476 ++++---
extensions/qqbot/src/command-auth.test.ts | 69 +-
extensions/qqbot/src/config-schema.ts | 50 +-
extensions/qqbot/src/config.test.ts | 216 ++-
extensions/qqbot/src/config.ts | 199 ---
extensions/qqbot/src/engine/access/index.ts | 2 +
.../qqbot/src/engine/access/resolve-policy.test.ts | 61 +
.../qqbot/src/engine/access/resolve-policy.ts | 30 +
.../qqbot/src/engine/access/sender-match.test.ts | 60 +
extensions/qqbot/src/engine/access/sender-match.ts | 55 +
extensions/qqbot/src/engine/access/types.ts | 2 +

### extensions/whatsapp/src

extensions/whatsapp/src/account-config.ts | 51 +-
extensions/whatsapp/src/account-ids.ts | 13 +
extensions/whatsapp/src/account-types.ts | 5 +
extensions/whatsapp/src/accounts.test.ts | 108 ++
extensions/whatsapp/src/accounts.ts | 25 +-
.../whatsapp/src/accounts.whatsapp-auth.test.ts | 2 +-
.../whatsapp/src/action-runtime-target-auth.ts | 8 +-
extensions/whatsapp/src/action-runtime.test.ts | 123 ++-
extensions/whatsapp/src/action-runtime.ts | 11 +-
extensions/whatsapp/src/active-listener.test.ts | 83 +-
extensions/whatsapp/src/active-listener.ts | 115 +-
extensions/whatsapp/src/agent-tools-login.test.ts | 81 ++
extensions/whatsapp/src/agent-tools-login.ts | 65 +-
extensions/whatsapp/src/approval-auth.ts | 4 +-
extensions/whatsapp/src/auth-store.runtime.ts | 1 +
extensions/whatsapp/src/auth-store.test.ts | 322 ++++++
extensions/whatsapp/src/auth-store.ts | 332 +++++-
.../auto-reply.broadcast-groups.combined.test.ts | 58 +-
.../auto-reply.broadcast-groups.test-harness.ts | 2 +-
extensions/whatsapp/src/auto-reply.impl.ts | 1 -
extensions/whatsapp/src/auto-reply.test-harness.ts | 170 ++-
...eply.compresses-common-formats-jpeg-cap.test.ts | 38 +-
...b-auto-reply.connection-and-logging.e2e.test.ts | 690 +++++++++++-
.../auto-reply.web-auto-reply.last-route.test.ts | 159 ++-
.../whatsapp/src/auto-reply/config.runtime.ts | 16 +
.../whatsapp/src/auto-reply/deliver-reply.test.ts | 662 +++++++++++-
.../whatsapp/src/auto-reply/deliver-reply.ts | 309 ++++--
.../src/auto-reply/heartbeat-runner.test.ts | 269 -----
.../whatsapp/src/auto-reply/heartbeat-runner.ts | 334 ------
extensions/whatsapp/src/auto-reply/mentions.ts | 34 +-
.../whatsapp/src/auto-reply/monitor-state.test.ts | 117 ++
.../whatsapp/src/auto-reply/monitor-state.ts | 22 +-
extensions/whatsapp/src/auto-reply/monitor.ts | 909 ++++++++++------
.../src/auto-reply/monitor/ack-reaction.test.ts | 146 ++-
.../src/auto-reply/monitor/ack-reaction.ts | 56 +-
.../auto-reply/monitor/audio-preflight.runtime.ts | 9 +
.../whatsapp/src/auto-reply/monitor/broadcast.ts | 42 +-
.../whatsapp/src/auto-reply/monitor/commands.ts | 8 -
extensions/whatsapp/src/auto-reply/monitor/echo.ts | 2 +-
.../auto-reply/monitor/group-activation.runtime.ts | 1 +

### extensions/qa-lab/src

.../qa-lab/src/agentic-parity-report.test.ts | 717 ++++
extensions/qa-lab/src/agentic-parity-report.ts | 541 ++++
extensions/qa-lab/src/agentic-parity.ts | 90 +
extensions/qa-lab/src/browser-runtime.test.ts | 169 +
extensions/qa-lab/src/browser-runtime.ts | 210 ++
extensions/qa-lab/src/bundled-plugin-staging.ts | 463 +++
extensions/qa-lab/src/bus-queries.ts | 167 +
extensions/qa-lab/src/bus-server.test.ts | 94 +
extensions/qa-lab/src/bus-server.ts | 217 ++
extensions/qa-lab/src/bus-state.test.ts | 173 +
extensions/qa-lab/src/bus-state.ts | 296 ++
extensions/qa-lab/src/bus-waiters.ts | 135 +
extensions/qa-lab/src/character-eval.test.ts | 633 ++++
extensions/qa-lab/src/character-eval.ts | 726 +++++
extensions/qa-lab/src/cli-options.ts | 4 +
extensions/qa-lab/src/cli-paths.ts | 86 +
extensions/qa-lab/src/cli.runtime.test.ts | 1342 ++++++++
extensions/qa-lab/src/cli.runtime.ts | 1005 ++++++
extensions/qa-lab/src/cli.test.ts | 623 ++++
extensions/qa-lab/src/cli.ts | 672 ++++
extensions/qa-lab/src/coverage-report.test.ts | 31 +
extensions/qa-lab/src/coverage-report.ts | 192 ++
extensions/qa-lab/src/cron-run-wait.test.ts | 53 +
extensions/qa-lab/src/cron-run-wait.ts | 57 +
extensions/qa-lab/src/discovery-eval.test.ts | 101 +
extensions/qa-lab/src/discovery-eval.ts | 72 +
extensions/qa-lab/src/docker-harness.test.ts | 123 +
extensions/qa-lab/src/docker-harness.ts | 383 +++
extensions/qa-lab/src/docker-runtime.ts | 278 ++
extensions/qa-lab/src/docker-up.runtime.test.ts | 272 ++
extensions/qa-lab/src/docker-up.runtime.ts | 141 +
extensions/qa-lab/src/extract-tool-payload.ts | 1 +
extensions/qa-lab/src/gateway-child.test.ts | 1410 ++++++++
extensions/qa-lab/src/gateway-child.ts | 979 ++++++
extensions/qa-lab/src/gateway-log-redaction.ts | 48 +
extensions/qa-lab/src/gateway-rpc-client.test.ts | 198 ++
extensions/qa-lab/src/gateway-rpc-client.ts | 77 +
extensions/qa-lab/src/harness-runtime.ts | 89 +
extensions/qa-lab/src/lab-server-capture.test.ts | 59 +
extensions/qa-lab/src/lab-server-capture.ts | 127 +

## Merge conflicts (if we update today)

Dry-run merge exit code: 1

Conflicting files:

Raw merge output (first ~40 lines):
