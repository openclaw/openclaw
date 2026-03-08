---
summary: "Refactor clusters with highest LOC reduction potential"
read_when:
  - You want to reduce total LOC without changing behavior
  - You are choosing the next dedupe or extraction pass
title: "Refactor Cluster Backlog"
---

# Refactor Cluster Backlog

Ranked by likely LOC reduction, safety, and breadth.

## 1. Channel plugin config and security scaffolding

Highest-value cluster.

Repeated shapes across many channel plugins:

- `config.listAccountIds`
- `config.resolveAccount`
- `config.defaultAccountId`
- `config.setAccountEnabled`
- `config.deleteAccount`
- `config.describeAccount`
- `security.resolveDmPolicy`

Strong examples:

- `extensions/telegram/src/channel.ts`
- `extensions/googlechat/src/channel.ts`
- `extensions/slack/src/channel.ts`
- `extensions/discord/src/channel.ts`
- `extensions/matrix/src/channel.ts`
- `extensions/irc/src/channel.ts`
- `extensions/signal/src/channel.ts`
- `extensions/mattermost/src/channel.ts`

Likely extraction shape:

- `buildChannelConfigAdapter(...)`
- `buildMultiAccountConfigAdapter(...)`
- `buildDmSecurityAdapter(...)`

Expected savings:

- ~250-450 LOC

Risk:

- Medium. Each channel has slightly different `isConfigured`, warnings, and normalization.

## 2. Extension runtime singleton boilerplate

Very safe.

Nearly every extension has the same runtime holder:

- `let runtime: PluginRuntime | null = null`
- `setXRuntime`
- `getXRuntime`

Strong examples:

- `extensions/telegram/src/runtime.ts`
- `extensions/matrix/src/runtime.ts`
- `extensions/slack/src/runtime.ts`
- `extensions/discord/src/runtime.ts`
- `extensions/whatsapp/src/runtime.ts`
- `extensions/imessage/src/runtime.ts`
- `extensions/twitch/src/runtime.ts`

Special-case variants:

- `extensions/bluebubbles/src/runtime.ts`
- `extensions/line/src/runtime.ts`
- `extensions/synology-chat/src/runtime.ts`

Likely extraction shape:

- `createPluginRuntimeStore<T>(errorMessage)`

Expected savings:

- ~180-260 LOC

Risk:

- Low

## 3. Onboarding prompt and config-patch steps

Large surface area.

Many onboarding files repeat:

- resolve account id
- prompt allowlist entries
- merge allowFrom
- set DM policy
- prompt secrets
- patch top-level vs account-scoped config

Strong examples:

- `extensions/bluebubbles/src/onboarding.ts`
- `extensions/googlechat/src/onboarding.ts`
- `extensions/msteams/src/onboarding.ts`
- `extensions/zalo/src/onboarding.ts`
- `extensions/zalouser/src/onboarding.ts`
- `extensions/nextcloud-talk/src/onboarding.ts`
- `extensions/matrix/src/onboarding.ts`
- `extensions/irc/src/onboarding.ts`

Existing helper seam:

- `src/channels/plugins/onboarding/helpers.ts`

Likely extraction shape:

- `promptAllowFromList(...)`
- `buildDmPolicyAdapter(...)`
- `applyScopedAccountPatch(...)`
- `promptSecretFields(...)`

Expected savings:

- ~300-600 LOC

Risk:

- Medium. Easy to over-generalize; keep helpers narrow and composable.

## 4. Multi-account config-schema fragments

Repeated schema fragments across extensions.

Common patterns:

- `const allowFromEntry = z.union([z.string(), z.number()])`
- account schema plus:
  - `accounts: z.object({}).catchall(accountSchema).optional()`
  - `defaultAccount: z.string().optional()`
- repeated DM/group fields
- repeated markdown/tool policy fields

Strong examples:

- `extensions/bluebubbles/src/config-schema.ts`
- `extensions/zalo/src/config-schema.ts`
- `extensions/zalouser/src/config-schema.ts`
- `extensions/matrix/src/config-schema.ts`
- `extensions/nostr/src/config-schema.ts`

Likely extraction shape:

- `AllowFromEntrySchema`
- `buildMultiAccountChannelSchema(accountSchema)`
- `buildCommonDmGroupFields(...)`

Expected savings:

- ~120-220 LOC

Risk:

- Low to medium. Some schemas are simple, some are special.

## 5. Webhook and monitor lifecycle startup

Good medium-value cluster.

Repeated `startAccount` / monitor setup patterns:

- resolve account
- compute webhook path
- log startup
- start monitor
- wait for abort
- cleanup
- status sink updates

Strong examples:

- `extensions/googlechat/src/channel.ts`
- `extensions/bluebubbles/src/channel.ts`
- `extensions/zalo/src/channel.ts`
- `extensions/telegram/src/channel.ts`
- `extensions/nextcloud-talk/src/channel.ts`

Existing helper seam:

- `src/plugin-sdk/channel-lifecycle.ts`

Likely extraction shape:

- helper for account monitor lifecycle
- helper for webhook-backed account startup

Expected savings:

- ~150-300 LOC

Risk:

- Medium to high. Transport details diverge quickly.

## 6. Small exact-clone cleanup

Low-risk cleanup bucket.

Examples:

- duplicated gateway argv detection:
  - `src/infra/gateway-lock.ts`
  - `src/cli/daemon-cli/lifecycle.ts`
- duplicated port diagnostics rendering:
  - `src/cli/daemon-cli/restart-health.ts`
- duplicated session-key construction:
  - `src/web/auto-reply/monitor/broadcast.ts`

Expected savings:

- ~30-60 LOC

Risk:

- Low

## Test clusters

### LINE webhook event fixtures

Strong examples:

- `src/line/bot-handlers.test.ts`

Likely extraction:

- `makeLineEvent(...)`
- `runLineEvent(...)`
- `makeLineAccount(...)`

Expected savings:

- ~120-180 LOC

### Telegram native command auth matrix

Strong examples:

- `src/telegram/bot-native-commands.group-auth.test.ts`
- `src/telegram/bot-native-commands.plugin-auth.test.ts`

Likely extraction:

- forum context builder
- denied-message assertion helper
- table-driven auth cases

Expected savings:

- ~80-140 LOC

### Zalo lifecycle setup

Strong examples:

- `extensions/zalo/src/monitor.lifecycle.test.ts`

Likely extraction:

- shared monitor setup harness

Expected savings:

- ~50-90 LOC

### Brave llm-context unsupported-option tests

Strong examples:

- `src/agents/tools/web-tools.enabled-defaults.test.ts`

Likely extraction:

- `it.each(...)` matrix

Expected savings:

- ~30-50 LOC

## Suggested order

1. Runtime singleton boilerplate
2. Small exact-clone cleanup
3. Config and security builder extraction
4. Test-helper extraction
5. Onboarding step extraction
6. Monitor lifecycle helper extraction
