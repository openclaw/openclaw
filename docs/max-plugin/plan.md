# MAX Channel Plugin — Implementation Plan

Companion docs: `docs/max-plugin/CONTEXT.md` (project goals/owner/status) and `docs/max-plugin/max-api-reference.md` (curated MAX API summary).

This plan is grounded in the actual structure of two existing channel plugins in this repo: `extensions/telegram/` (closest analog: Bot API, polling+webhook, multi-account) and `extensions/nextcloud-talk/` (simpler reference: webhook-only with multi-account). All file/line references below are to the current `main` branch.

---

## 1. Target file layout — `extensions/max/`

The structure mirrors `extensions/nextcloud-talk/` (the simpler reference), with a few additions to support the polling transport that `extensions/telegram/` already does well.

```
extensions/max/
├── package.json                    # Workspace package + openclaw block
├── openclaw.plugin.json            # Plugin manifest (id, channels, channelEnvVars)
├── tsconfig.json                   # Mirror nextcloud-talk/tsconfig.json
├── README.md                       # Short overview, link to docs/channels/max
│
├── index.ts                        # Entry: defineBundledChannelEntry({...})
├── channel-plugin-api.ts           # Re-export src/channel.ts → maxPlugin
├── secret-contract-api.ts          # Re-export src/secret-contract.ts → channelSecrets
├── runtime-api.ts                  # Internal cross-module re-exports (types/runtime helpers)
├── runtime-setter-api.ts           # Re-export setMaxRuntime from src/runtime.ts
├── setup-entry.ts                  # Cold-path setup metadata (used by `openclaw channels list`)
├── doctor-contract-api.ts          # (Phase ≥3) doctor diagnostics barrel
│
└── src/
    ├── channel.ts                  # createChatChannelPlugin({ base, security, pairing, outbound })
    ├── channel-api.ts              # Internal type alias barrel (mirrors nextcloud-talk/src/channel-api.ts)
    ├── accounts.ts                 # ResolvedMaxAccount + resolveMaxAccount
    ├── account-config.ts           # mergeMaxAccountConfig (top-level + accounts.<id>)
    ├── account-selection.ts        # listMaxAccountIds, resolveDefaultMaxAccountSelection
    ├── token.ts                    # resolveMaxToken (env / tokenFile / config)
    ├── types.ts                    # MaxAccountConfig, CoreConfig, MaxInboundMessage, etc.
    ├── config-schema.ts            # Zod schema (MaxConfigSchema) — mirrors nextcloud-talk
    │
    ├── client.ts                   # Lightweight wrapper around @maxhub/max-bot-api (Bot)
    ├── runtime.ts                  # Runtime registry (getMaxRuntime / setMaxRuntime)
    │
    ├── monitor.ts                  # Transport orchestration (selects polling vs webhook)
    ├── monitor-polling.runtime.ts  # Long-polling loop using SDK.start()
    ├── monitor-webhook.runtime.ts  # HTTP webhook listener (Phase 2)
    │
    ├── inbound.ts                  # handleMaxInbound — DM/group gating + dispatchInboundReplyWithBase
    ├── handlers.ts                 # Per-event normalizers: message_created, message_callback, ...
    ├── normalize.ts                # normalizeMaxMessagingTarget, looksLikeMaxTargetId
    ├── policy.ts                   # Group policy / room policy (Phase ≥3)
    ├── send.ts                     # sendMessageMax (text + attachments)
    ├── send.runtime.ts             # Lazy runtime delegate
    ├── attachments.ts              # (Phase 4) two-step upload helper
    │
    ├── session-route.ts            # resolveMaxOutboundSessionRoute (thread-aware route)
    ├── secret-contract.ts          # secretTargetRegistryEntries + collectRuntimeConfigAssignments
    ├── secret-input.ts             # Local secret-input zod schema helper
    ├── setup-core.ts               # ChannelSetupAdapter (validateInput + applyAccountConfig)
    ├── setup-surface.ts            # Setup wizard (interactive prompts)
    ├── replay-guard.ts             # (Phase 2) webhook dedupe by messageId
    ├── signature.ts                # (Phase 2) webhook signature verification (if MAX adds one)
    └── doctor.ts                   # (Phase ≥3) config diagnostics

# Test files (Phase 6) live alongside production files as `*.test.ts`
# (e.g. `src/accounts.test.ts`, `src/inbound.replay.test.ts`).
```

Phase mapping for this layout:
- **Phase 1 (MVP)** ships everything required for `polling + message_created → reply text`:
  `package.json`, `openclaw.plugin.json`, `tsconfig.json`, `index.ts`, `channel-plugin-api.ts`, `secret-contract-api.ts`, `runtime-api.ts`, `runtime-setter-api.ts`, `setup-entry.ts`, plus `src/{channel.ts, channel-api.ts, accounts.ts, account-config.ts, account-selection.ts, token.ts, types.ts, config-schema.ts, client.ts, runtime.ts, monitor.ts, monitor-polling.runtime.ts, inbound.ts, handlers.ts, normalize.ts, send.ts, send.runtime.ts, session-route.ts, secret-contract.ts, secret-input.ts, setup-core.ts, setup-surface.ts}`.
- **Phase 2** adds `monitor-webhook.runtime.ts`, `replay-guard.ts`, `signature.ts`.
- **Phase 3** adds keyboard handling in `handlers.ts` (no new file).
- **Phase 4** adds `attachments.ts` and extends `send.ts`.
- **Phase 5** is config-only.
- **Phase 6** adds `*.test.ts` files.

---

## 2. Manifest files (ready to copy)

### 2.1 `extensions/max/package.json`

Modeled on `extensions/nextcloud-talk/package.json:1-60` (closer fit than Telegram, since MAX has no Grammy ecosystem to depend on yet).

```json
{
  "name": "@openclaw/max",
  "version": "2026.5.3",
  "description": "OpenClaw MAX channel plugin (Russian messenger by VK)",
  "repository": {
    "type": "git",
    "url": "https://github.com/openclaw/openclaw"
  },
  "type": "module",
  "dependencies": {
    "@maxhub/max-bot-api": "0.2.2",
    "zod": "^4.4.1"
  },
  "devDependencies": {
    "@openclaw/plugin-sdk": "workspace:*",
    "openclaw": "workspace:*"
  },
  "peerDependencies": {
    "openclaw": ">=2026.5.3"
  },
  "peerDependenciesMeta": {
    "openclaw": {
      "optional": true
    }
  },
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "channel": {
      "id": "max-messenger",
      "label": "MAX",
      "selectionLabel": "MAX (Russian messenger)",
      "detailLabel": "MAX bot",
      "docsPath": "/channels/max-messenger",
      "docsLabel": "max-messenger",
      "blurb": "Russian messenger MAX (by VK). Requires a verified Russian legal entity to register a bot at dev.max.ru.",
      "aliases": ["max"],
      "order": 70,
      "markdownCapable": true,
      "configuredState": {
        "env": { "allOf": ["MAX_BOT_TOKEN"] },
        "specifier": "./configured-state",
        "exportName": "hasMaxConfiguredState"
      }
    },
    "compat": {
      "pluginApi": ">=2026.5.3"
    }
  }
}
```

Key choices and references:
- `name: "@openclaw/max"` — same convention as `extensions/nextcloud-talk/package.json:2`.
- `dependencies`: `@maxhub/max-bot-api` is pinned exact at `0.2.2` (no caret) per §8 decision #9 (originally `0.0.13`, updated per §9 N1 — `0.2.2` has a more settled API, SDK bugs are mitigated by the custom supervisor in §6.1.6). Plus `zod` (config schema, same as nextcloud-talk). No grammy fork because the MAX SDK is its own thing.
- `openclaw.extensions: ["./index.ts"]` — required for plugin loader (see `extensions/CLAUDE.md` "Boundary Rules"). All bundled plugins use this pattern; see `extensions/telegram/package.json:18-20`.
- `openclaw.setupEntry: "./setup-entry.ts"` — required so `openclaw channels list` and `status` can read MAX metadata before runtime loads (see `docs/plugins/sdk-channel-plugins.md:160-164`).
- `openclaw.channel.id: "max-messenger"` — primary channel id (per §8 decision #2). Becomes `channels.max-messenger.*` in user config.
- `openclaw.channel.aliases: ["max"]` — short alias accepted by target prefix parsing (mirrors nextcloud-talk's `["nc-talk", "nc"]`, `extensions/nextcloud-talk/package.json:38-40`).
- `openclaw.channel.configuredState.env.allOf` — env presence enables a quick "configured" answer without reading config (see `extensions/telegram/package.json:46-50`).
- `openclaw.compat.pluginApi: ">=2026.5.3"` — gate against older host (mirrors nextcloud-talk).

Skipped vs Telegram:
- `setupFeatures.legacyStateMigrations` — not needed; we have no prior state to migrate.
- `setupFeatures.configPromotion` — defer until Phase 3+ when env-driven onboarding becomes useful.
- `install.npmSpec` and `release.publishToClawHub` — Phase 1 omits these (per §8 decision #10). Phase 5+ adds `install.npmSpec` pointing at `@bccontrol/openclaw-max-messenger` once the standalone npm release lands.

### 2.2 `extensions/max/openclaw.plugin.json`

Modeled on `extensions/telegram/openclaw.plugin.json:1-15`.

```json
{
  "id": "max-messenger",
  "activation": { "onStartup": false },
  "channels": ["max-messenger"],
  "channelEnvVars": {
    "max-messenger": ["MAX_BOT_TOKEN"]
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Notes:
- `activation.onStartup: false` — channel only starts when an account is configured; matches `extensions/telegram/openclaw.plugin.json:3-5` and `extensions/nextcloud-talk/openclaw.plugin.json:3-5`.
- `channels: ["max-messenger"]` — discovery-time channel id list (the alias `"max"` is declared in `package.json` `openclaw.channel.aliases`, not here).
- `channelEnvVars["max-messenger"]: ["MAX_BOT_TOKEN"]` — generic startup paths can reason about env-driven configuration without loading runtime (see `docs/plugins/sdk-channel-plugins.md:154-157`).
- `configSchema` stays empty: the channel-specific schema lives at `channels.max-messenger.*` and is provided by `buildChannelConfigSchema(MaxConfigSchema)` inside `src/channel.ts`. See `extensions/nextcloud-talk/src/channel.ts:83`. (The newer pattern in `docs/plugins/sdk-channel-plugins.md:333-368` would also accept a `channelConfigs["max-messenger"].schema` block here, but no bundled channel uses it yet — sticking with the in-code schema keeps consistency with telegram/nextcloud-talk.)

### 2.3 `extensions/max/tsconfig.json`

One-line file; copy `extensions/nextcloud-talk/tsconfig.json` verbatim. No MAX-specific changes needed.

---

## 3. SDK interfaces to implement

All public types are in `packages/plugin-sdk/`, which is a re-export barrel for `src/plugin-sdk/*` (see `packages/plugin-sdk/src/`). Per `extensions/CLAUDE.md` "Boundary Rules", extension production code imports only from `openclaw/plugin-sdk/*` and local barrels — never from `src/channels/**` directly.

### 3.1 `ChannelPlugin<ResolvedAccount>` — the main contract

- Definition: `src/channels/plugins/types.plugin.ts` (re-exported via `openclaw/plugin-sdk/channel-core`)
- We instantiate it through `createChatChannelPlugin({...})` from `openclaw/plugin-sdk/channel-core`, exactly like:
  - `extensions/nextcloud-talk/src/channel.ts:68-195`
  - `extensions/telegram/src/channel.ts` (similar shape, more adapters wired)

The adapters we need to fill in for MAX (Phase 1 minimum bolded):

| Adapter | Phase | Source of truth in this repo |
|---|---|---|
| **`id: "max-messenger"`** | 1 | `extensions/nextcloud-talk/src/channel.ts:71` |
| **`meta`** (label/docsPath/blurb) | 1 | `extensions/nextcloud-talk/src/channel.ts:34-44` |
| **`capabilities`** | 1 | `extensions/nextcloud-talk/src/channel.ts:74-81` |
| **`reload.configPrefixes: ["channels.max-messenger"]`** | 1 | `extensions/nextcloud-talk/src/channel.ts:82` |
| **`configSchema: buildChannelConfigSchema(MaxConfigSchema)`** | 1 | `extensions/nextcloud-talk/src/channel.ts:83` |
| **`config: ChannelConfigAdapter`** | 1 | `extensions/nextcloud-talk/src/channel.ts:84-96` (via `nextcloudTalkConfigAdapter` in `channel.adapters.ts`) |
| **`messaging: ChannelMessagingAdapter`** | 1 | `extensions/nextcloud-talk/src/channel.ts:121-129` |
| **`secrets: { secretTargetRegistryEntries, collectRuntimeConfigAssignments }`** | 1 | `extensions/nextcloud-talk/src/channel.ts:130-133`, schema in `extensions/nextcloud-talk/src/secret-contract.ts` |
| **`status: createComputedAccountStatusAdapter({...})`** | 1 | `extensions/nextcloud-talk/src/channel.ts:135-152` |
| **`gateway: ChannelGatewayAdapter`** | 1 | `extensions/nextcloud-talk/src/gateway.ts:14-43` (we adapt this for polling) |
| **`outbound: { base, attachedResults }`** | 1 | `extensions/nextcloud-talk/src/channel.ts:167-194` |
| `security: ChannelSecurityAdapter` | 1 | `extensions/nextcloud-talk/src/channel.ts:163-166` (DM policy / allowFrom) |
| `pairing.text` | 1 | `extensions/nextcloud-talk/src/channel.ts:155-162` |
| `setup: ChannelSetupAdapter` | 1 | `extensions/nextcloud-talk/src/setup-core.ts:199-248` |
| `setupWizard` | 2 | `extensions/nextcloud-talk/src/setup-surface.ts` |
| `groups: { resolveRequireMention, resolveToolPolicy }` | 3 | `extensions/nextcloud-talk/src/channel.ts:99-120` |
| `approvalCapability` | 3 | `extensions/nextcloud-talk/src/channel.ts:97` |
| `doctor` | 3 | `extensions/nextcloud-talk/src/channel.ts:98` |

### 3.2 SDK helpers we will lean on

Resolved by reading the actual imports in nextcloud-talk and telegram. All paths under `openclaw/plugin-sdk/*`.

| Helper | Subpath | Used at |
|---|---|---|
| `createChatChannelPlugin` | `channel-core` | `extensions/nextcloud-talk/src/channel.ts:2` |
| `buildChannelConfigSchema` | (re-exported via local `channel-api.ts`) | `extensions/nextcloud-talk/src/channel.ts:12` |
| `defineBundledChannelEntry` | `channel-entry-contract` | `extensions/nextcloud-talk/index.ts:1` |
| `createAccountListHelpers`, `resolveMergedAccountConfig`, `resolveAccountWithDefaultFallback`, `DEFAULT_ACCOUNT_ID`, `normalizeAccountId` | `account-core` | `extensions/nextcloud-talk/src/accounts.ts:1-7` |
| `tryReadSecretFileSync` | `secret-file-runtime` | `extensions/nextcloud-talk/src/accounts.ts:8` |
| `normalizeOptionalString`, `normalizeLowercaseStringOrEmpty` | `text-runtime` | `extensions/nextcloud-talk/src/accounts.ts:9-12` |
| `DmPolicySchema`, `GroupPolicySchema`, `MarkdownConfigSchema`, `ReplyRuntimeConfigSchemaShape`, `ToolPolicySchema`, `requireOpenAllowFrom` | `channel-config-schema` | `extensions/nextcloud-talk/src/config-schema.ts:1-7` |
| `requireChannelOpenAllowFrom`, `runStoppablePassiveMonitor` | `extension-shared` | `extensions/nextcloud-talk/src/config-schema.ts:8`, `extensions/nextcloud-talk/src/gateway.ts:2` |
| `createAccountStatusSink` | `channel-lifecycle` | `extensions/nextcloud-talk/src/gateway.ts:1` |
| `describeWebhookAccountSnapshot`, `buildWebhookChannelStatusSummary`, `createComputedAccountStatusAdapter`, `createDefaultChannelRuntimeState` | `account-helpers` / `status-helpers` | `extensions/nextcloud-talk/src/channel.ts:1, 5-9` |
| `createLoggedPairingApprovalNotifier` | `channel-pairing` | `extensions/nextcloud-talk/src/channel.ts:3` |
| `createAllowlistProviderRouteAllowlistWarningCollector` | `channel-policy` | `extensions/nextcloud-talk/src/channel.ts:4` |
| `dispatchInboundReplyWithBase`, `deliverFormattedTextWithAttachments`, `createChannelPairingController` | `runtime-api.ts` (local barrel re-exports core helpers) | `extensions/nextcloud-talk/src/inbound.ts:2-16` |
| `WEBHOOK_RATE_LIMIT_DEFAULTS`, `createAuthRateLimiter`, `readRequestBodyWithLimit` | `webhook-ingress` | `extensions/nextcloud-talk/src/monitor.ts:3-9` (Phase 2) |
| `ChannelSetupAdapter`, `ChannelSetupInput` | `channel-setup` | `extensions/nextcloud-talk/src/setup-core.ts:1` |
| `patchScopedAccountConfig`, `applyAccountNameToChannelSection` | `setup` | `extensions/nextcloud-talk/src/setup-core.ts:5-7` |
| `createSetupInputPresenceValidator`, `mergeAllowFromEntries`, `promptParsedAllowFromForAccount`, `resolveSetupAccountId` | `setup-runtime` | `extensions/nextcloud-talk/src/setup-core.ts:8-15` |
| `formatDocsLink` | `setup-tools` | `extensions/nextcloud-talk/src/setup-core.ts:16` |
| `SecretTargetRegistryEntry`, `collectConditionalChannelFieldAssignments`, `getChannelSurface`, `hasOwnProperty` | `channel-secret-basic-runtime` | `extensions/nextcloud-talk/src/secret-contract.ts:1-8` |

### 3.3 `defineBundledChannelEntry` — entry point shape

Source: `src/plugin-sdk/channel-entry-contract.ts` (re-exported via `openclaw/plugin-sdk/channel-entry-contract`).

Reference call: `extensions/nextcloud-talk/index.ts:3-20`. Our MAX `index.ts` mirrors that 1:1, only changing ids and exportNames. Notably: this is the **bundled-plugin** form. The newer `defineChannelPluginEntry` form documented in `docs/plugins/sdk-channel-plugins.md:506-535` is intended for external/ClawHub plugins; bundled channels still use `defineBundledChannelEntry` because it supports lazy specifiers (`{ specifier, exportName }`) so discovery doesn't pull runtime modules. We follow the bundled pattern.

---

## 4. MAX events → OpenClaw channel events mapping

Telegram is the canonical reference for "Bot API style platform with discrete update types". Its update routing lives in `extensions/telegram/src/bot-message-dispatch.ts:114-400`, which receives a normalized `TelegramMessageContext` from polling (`monitor-polling.runtime.ts`) or webhook (`monitor-webhook.runtime.ts`) and calls `runInboundReplyTurn(...)` for actionable messages.

Nextcloud-talk's webhook-only flow in `extensions/nextcloud-talk/src/inbound.ts:54-320` is the cleaner shape to copy because MAX has discrete event types from the start, just like Activity Streams.

| MAX event | Telegram analogue | OpenClaw inbound action | Phase | Notes |
|---|---|---|---|---|
| `bot_started` | `my_chat_member` (status → member) | Send `meta.welcomeMessage` if configured; create pairing record if DM and `dmPolicy === "pairing"`. | 1 | First user contact. Mirror `nextcloud-talk` pairing flow at `extensions/nextcloud-talk/src/inbound.ts:175-196` (issue pairing challenge). |
| `message_created` (text) | `message` (with `text`) | `payloadToInboundMessage` (see `extensions/nextcloud-talk/src/monitor.ts:197-214`) → `handleMaxInbound` → `dispatchInboundReplyWithBase` (see `extensions/nextcloud-talk/src/inbound.ts:289-319`). | 1 | Core MVP path. |
| `message_created` (with attachments) | `message` (with `photo`/`video`/`document`) | Same as above + media descriptor on the inbound context. Initial implementation: pass attachment URL/caption as text fallback. Phase 4 wires real media download. | 4 | Telegram does this in `extensions/telegram/src/bot-message-context.body.test.ts` (parses photo/video/file/voice/sticker variants). |
| `message_callback` | `callback_query` | Phase 3: route via `approvalCapability` for native approval buttons OR via `actions` adapter for in-message commands. The button payload's `payload` field maps to Telegram's `callback_data`. | 3 | Telegram callback dispatch lives in `extensions/telegram/src/bot-message-dispatch.ts` together with `bot/native-quote.js` button helpers. |
| `message_edited` | `edited_message` | Phase 1 minimum: ignore (idempotent for agent state). Phase 3+: re-dispatch as a fresh inbound context tagged `WasEdit: true` if config asks. | 1 (drop) / 3 (route) | Telegram drops by default unless `actions.edits` is enabled per-account. |
| `message_removed` | `chat_member` (left) | Drop in Phase 1. Optional audit log in Phase 3. | 1 (drop) | No agent action needed for MVP. |
| `bot_added` | `my_chat_member` (added to chat) | Phase 1: log only. Phase 3: trigger room registration if `groupPolicy === "allowlist"`. | 1 (log) / 3 | |
| `bot_removed` | `my_chat_member` (kicked) | Drop, log only. | 1 | |
| `user_added` | `chat_member` joined | Drop, log only. | 1 | |
| `user_removed` | `chat_member` left | Drop, log only. | 1 | |
| `chat_title_changed` | `message` (with `new_chat_title`) | Drop, log only. Could refresh cached room name. | 1 | |

Inbound message normalization shape (mirror `extensions/nextcloud-talk/src/types.ts:151-161` and `extensions/nextcloud-talk/src/monitor.ts:197-214`):

```typescript
// src/types.ts
export type MaxInboundMessage = {
  messageId: string;          // MAX message id
  chatId: string;             // MAX chat id (DM: peer user id; group: chat id)
  chatTitle?: string;         // group title (undefined for DM)
  senderId: string;           // MAX user id (numeric → string)
  senderName: string;         // first_name / display name
  text: string;               // message.body.text
  attachments: MaxAttachment[]; // [] in Phase 1; populated in Phase 4
  timestamp: number;          // ms
  isGroupChat: boolean;
  replyToMessageId?: string;  // for native reply threading
};
```

Dispatch flow for `message_created` (Phase 1 — copy nextcloud-talk's `handleNextcloudTalkInbound` shape from `extensions/nextcloud-talk/src/inbound.ts:54-320`):

1. Drop if empty text.
2. Resolve allowFrom / dmPolicy / groupPolicy via `resolveDmGroupAccessWithCommandGate(...)` (helper from `runtime-api.ts`, see `extensions/nextcloud-talk/src/inbound.ts:138-156`).
3. If decision is `"pairing"` — issue challenge through `pairing.issueChallenge(...)` (`inbound.ts:177-191`).
4. If decision is `"drop"` — `runtime.log` and return.
5. Mention gating for groups — Phase 3, optional; Phase 1 treats every group message that passes allowlist as actionable.
6. Build inbound context via `core.channel.reply.finalizeInboundContext({...})` (`inbound.ts:264-287`).
7. Dispatch via `dispatchInboundReplyWithBase({...})` (`inbound.ts:289-319`) with a `deliver` that calls `sendMessageMax(chatId, text, {...})`.

---

## 5. Channel config — JSON Schema for `channels.max`

We follow the **nextcloud-talk model** (Zod schema in `src/config-schema.ts`, TypeScript types in `src/types.ts`) rather than Telegram's heavier typebox approach, because nextcloud-talk's schema is closer in surface area to what MAX needs.

Reference: `extensions/nextcloud-talk/src/config-schema.ts` (full file shown in survey above) and `extensions/nextcloud-talk/src/types.ts:9-90`.

### 5.1 `MaxAccountConfig` (TS type, `src/types.ts`)

```typescript
import type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  SecretInput,
} from "../runtime-api.js";

export type MaxTransport = "polling" | "webhook";

export type MaxAccountConfig = {
  /** Optional display name for this account (CLI/UI). */
  name?: string;
  /** Default true; set false to disable this MAX account without removing it. */
  enabled?: boolean;

  /** Bot token issued by dev.max.ru. Mutually exclusive with tokenFile. */
  token?: SecretInput;
  /** Path to file containing the bot token (for secret managers). */
  tokenFile?: string;

  /** Optional API base URL override (default: https://platform-api.max.ru). */
  apiRoot?: string;

  /** Transport: "polling" (default) or "webhook". */
  transport?: MaxTransport;
  /** Public URL passed to set_webhook (only used when transport === "webhook"). */
  webhookUrl?: string;
  /** Webhook server local port. Default: 8789. */
  webhookPort?: number;
  /** Webhook server local host. Default: "0.0.0.0". */
  webhookHost?: string;
  /** Webhook endpoint path. Default: "/max-webhook". */
  webhookPath?: string;

  /** DM policy: "allowlist" | "open" | "pairing". Default: "pairing". */
  dmPolicy?: DmPolicy;
  /** User ids allowed to DM the bot (when dmPolicy === "allowlist"). */
  allowFrom?: string[];

  /** Group policy: "allowlist" | "open" | "blocked". Default: "allowlist". */
  groupPolicy?: GroupPolicy;
  /** User ids allowed to address the bot in group chats. */
  groupAllowFrom?: string[];

  /** Per-DM overrides keyed by user id. */
  dms?: Record<string, DmConfig>;

  /** Outbound text chunk size (chars). Default: 4000 (constant `MAX_TEXT_CHUNK_LIMIT` in code; per §8 decision #6 — unverified upstream limit, revisit after first empirical smoke test). */
  textChunkLimit?: number;
  /** Disable block streaming for MAX (recommended initially: true). */
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Outbound response prefix override. */
  responsePrefix?: string;
  /** Media upload max size in MB. Default: 50. */
  mediaMaxMb?: number;
};

type MaxConfig = {
  /** Per-account configuration (multi-account). */
  accounts?: Record<string, MaxAccountConfig>;
  /** Default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & MaxAccountConfig;

export type CoreConfig = {
  channels?: { ["max-messenger"]?: MaxConfig };
  [key: string]: unknown;
};
```

### 5.2 `MaxConfigSchema` (Zod, `src/config-schema.ts`)

Lifted directly from the nextcloud-talk pattern with MAX-specific fields. The `dmPolicy`/`allowFrom` shape uses the shared SDK schemas so dmPolicy validation matches every other channel.

```typescript
import {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import { z } from "openclaw/plugin-sdk/zod";
import { buildSecretInputSchema } from "./secret-input.js";

const MaxTransportSchema = z.enum(["polling", "webhook"]);

const MaxAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    markdown: MarkdownConfigSchema,

    token: buildSecretInputSchema().optional(),
    tokenFile: z.string().optional(),
    apiRoot: z.string().url().optional(),

    transport: MaxTransportSchema.optional().default("polling"),
    webhookUrl: z.string().url().optional(),
    webhookPort: z.number().int().positive().optional(),
    webhookHost: z.string().optional(),
    webhookPath: z.string().optional(),

    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groupAllowFrom: z.array(z.string()).optional(),

    ...ReplyRuntimeConfigSchemaShape, // textChunkLimit, blockStreaming, etc.
  })
  .strict();

const MaxAccountSchema = MaxAccountSchemaBase.superRefine((value, ctx) => {
  requireChannelOpenAllowFrom({
    channel: "max-messenger",
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    requireOpenAllowFrom,
  });
  if (value.transport === "webhook" && !value.webhookUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "channels.max-messenger: webhookUrl is required when transport is 'webhook'.",
      path: ["webhookUrl"],
    });
  }
});

export const MaxConfigSchema = MaxAccountSchemaBase.extend({
  accounts: z.record(z.string(), MaxAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireChannelOpenAllowFrom({
    channel: "max-messenger",
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    requireOpenAllowFrom,
  });
});
```

### 5.3 Comparison with the Telegram plugin

| Field | MAX shape (this plan) | Telegram equivalent | Notes |
|---|---|---|---|
| `token` (`SecretInput`) | direct | `botToken` | MAX uses the simpler "token" naming; Telegram inherited `botToken`. Internally we resolve via `resolveMaxToken()` mirroring `extensions/telegram/src/token.ts`. |
| `tokenFile` | direct | `tokenFile` | Same. |
| `apiRoot` | direct | `apiRoot` | Allows pinning `https://platform-api.max.ru` (default) or test endpoints. Same as `extensions/telegram/src/accounts.ts:117`. |
| `transport: "polling" \| "webhook"` | explicit field | implicit (presence of `webhookUrl` switches to webhook) | MAX makes this explicit because the API requires `delete_webhook` before polling resumes. Explicit field surfaces the constraint in config and in doctor. |
| `webhookUrl`, `webhookPort`, `webhookHost`, `webhookPath` | direct | direct | Same shape as Telegram. |
| `dmPolicy`, `allowFrom` | shared `DmPolicySchema` | shared `DmPolicySchema` | Identical contract — see `openclaw/plugin-sdk/channel-config-schema`. |
| `groupPolicy`, `groupAllowFrom` | shared | shared | Same. |
| `accounts: Record<string, MaxAccountConfig>` | direct | direct | Multi-account mirror. |
| `defaultAccount` | direct | implicit (`accounts.default`) | Telegram uses `accounts.default` key; nextcloud-talk uses `defaultAccount` field — MAX follows the cleaner nextcloud-talk pattern. |

Top-level config example users will write into `~/.openclaw/openclaw.json`:

```jsonc
{
  "channels": {
    "max-messenger": {
      // Single-account form (Phase 1 MVP)
      "tokenFile": "~/.openclaw/credentials/max-messenger-bcai.token",
      "transport": "polling",
      "dmPolicy": "pairing",
      "allowFrom": ["12345678"],

      // Multi-account form (Phase 5)
      "accounts": {
        "bcai": { "tokenFile": "~/.openclaw/credentials/max-messenger-bcai.token" },
        "test": { "token": "$MAX_BOT_TOKEN_TEST", "transport": "webhook", "webhookUrl": "https://example.com/max-messenger-test" }
      },
      "defaultAccount": "bcai"
    }
  }
}
```

---

## 6. Phased PR plan

Each phase is a single feature branch + PR, sized to fit one mobile review session and verifiable on BCAi by pulling the merged main. Test commands assume sparse-friendly invocations from `CLAUDE.md` "Commands" section.

### Phase 1 — MVP: polling + `message_created` + plain text reply

Per the strategic decision in PR #2 (https://github.com/mefodiytr/openclaw/pull/2#issuecomment-4366189435), Phase 1 ships as **two PRs (1A scaffolding + 1B supervisor) plus a manual smoke procedure (1C)**. The split keeps the scaffolding mobile-reviewable in one pass and gives the polling supervisor its own review cycle once the test harness from §6.1.7 is ready. No production urgency — the bot token is 5–10 business days out (§8 #1).

#### Phase 1A — Scaffolding (mergeable as soon as plan.md merges)

Goal: every file from §1 lands as runnable scaffolding; the plugin loads in the gateway and is visible to `openclaw channels list`. No polling logic yet.

In scope:
- All Phase 1 files from §1 (under `extensions/max-messenger/` per §8 decision #2).
- `package.json` and `openclaw.plugin.json` (§2.1, §2.2). SDK pinned exact `0.2.2` (per §8 decision #9, updated per §9 N1). No `install.npmSpec` (per §8 decision #10).
- `index.ts`, `channel-plugin-api.ts`, `secret-contract-api.ts`, `runtime-api.ts`, `runtime-setter-api.ts`, `setup-entry.ts` — entry barrels, all wired but stubbing runtime calls.
- `src/channel.ts` — `createChatChannelPlugin({...})` with all Phase 1 adapters (per §3.1) wired to stubs that throw `not implemented` for runtime ops. `id: "max-messenger"`, `aliases: ["max"]`. `dmPolicy: "pairing"`, `blockStreaming: true`.
- `src/config-schema.ts` — `MaxConfigSchema` (§5.2) including `MaxPollingConfigSchema` (§6.1.2). Schema validation works; no behavior depends on it yet.
- `src/types.ts`, `src/accounts.ts`, `src/account-config.ts`, `src/account-selection.ts`, `src/token.ts` — types and pure helpers. Single-account path; multi-account stubs throw.
- `src/secret-contract.ts`, `src/secret-input.ts`, `src/setup-core.ts` — onboarding scaffolding (no interactive wizard yet).
- `src/gateway.ts` — `startAccount` / `logoutAccount` shape per §6.1.3, but the supervisor returns immediately with a `not-yet-implemented` warning emitted via `runtime.log`.
- `src/inbound.ts`, `src/handlers.ts`, `src/normalize.ts`, `src/send.ts`, `src/send.runtime.ts`, `src/session-route.ts`, `src/client.ts`, `src/monitor.ts`, `src/runtime.ts` — all stubbed with the public shape; no live network calls.
- `MAX_TEXT_CHUNK_LIMIT = 4000` named constant (per §8 decision #6) with `// TODO: verify empirically`.

Tests / proof:
- `pnpm test extensions/max-messenger` passes config-schema and account-resolution tests against the schema.
- `openclaw channels list` shows MAX with the right metadata.
- No real network/polling — SDK never instantiated.

Branch: `feat/max-messenger-scaffolding`. PR title: `feat(max-messenger): channel plugin scaffolding (Phase 1A)`.

#### Phase 1B — Polling supervisor + harness

Goal: real polling against the fake-MAX harness (§6.1.7); all seven failure scenarios pass; ready to run against a real bot the moment a token is available.

In scope (Phase 1B.0 — prerequisite, lands inside the same PR):
- Fake-MAX test harness at `extensions/max-messenger/test/fake-max-server/` per §6.1.7 — `server.ts` plus the seven required scenario JSONs and `scenarios.test.ts`.

In scope (Phase 1B):
- Custom polling supervisor per §6.1.6: `monitor-polling.runtime.ts`, `polling-loop.ts`, `polling-http.ts`, `marker-store.ts`, `dedup-cache.ts`. Bypasses `bot.start()`; owns the loop.
- Marker persistence (per §8 #15, #17 / §9 N2, N7) — file `~/.openclaw/state/channels/max-messenger/<accountId>.json` storing `{ tokenHash, marker }`; atomic write.
- Inbound dedup LRU (per §8 #16 / §9 N3) — bounded 10000 / TTL 1 h on `mid` and `callback_id`.
- Custom HTTP wrapper (per §9 N4) — `Retry-After`, request timeout = `timeoutSec + 10`, `AbortSignal` wired into `fetch`. Reused for `send_message`.
- Replace the `not-yet-implemented` stubs from 1A with real implementations: `client.ts` (uses the custom HTTP wrapper), `inbound.ts` (handles `message_created` text only; other events `runtime.log` and ignore), `send.ts` `sendText` only.
- Telemetry events from §6.1.5 wired through `runtime.log` and the status sink.
- Optionally (per §9 N5): surface `polling.restart` count in `openclaw status` if it costs <2 h; otherwise defer to Phase 5.

Tests / proof:
- All seven §6.1.7 scenarios pass: `happy-path`, `429-with-retry-after`, `5xx-then-success`, `network-drop`, `slow-response`, `marker-replay`, `401-revoked`.
- Marker persistence round-trip test: kill supervisor mid-batch, restart, confirm no duplicate dispatch (dedup) and no missed events (marker resumes).
- Token-rotation test: change token in config, confirm marker invalidates and `polling.marker_reset` emits.

Branch: `feat/max-messenger-polling-supervisor`. PR title: `feat(max-messenger): polling supervisor + fake-MAX harness (Phase 1B)`.

#### Phase 1C — Smoke test (no PR — manual procedure)

Goal: validate the supervisor against a real MAX bot once the token arrives.

Procedure (documented in `extensions/max-messenger/README.md`):
1. Configure `channels.max-messenger.tokenFile` with the issued token.
2. `openclaw start`; bot pairs with a private MAX chat.
3. Walk through all nine rows of the §6.1.4 failure-modes table manually — induce each scenario where feasible (kill network mid-poll, revoke + reissue token, send rapid-fire messages, etc.) and confirm the supervisor's reaction matches the table.
4. File any divergences as Phase 1 follow-ups.

No code changes if the smoke passes. Owner runs this on BCAi.

### 6.1 Long Polling Transport — Detailed Design (Phase 1B)

This subsection captures the empirically-audited behavior of `@maxhub/max-bot-api` and the gaps the openclaw plugin must close to ship a production-grade polling transport. The audit was performed against the public source at [`max-messenger/max-bot-api-client-ts`](https://github.com/max-messenger/max-bot-api-client-ts). Verification gaps and design decisions still pending land in §9.

#### 6.1.1 SDK behavior audit (`@maxhub/max-bot-api`)

> Audit reads off `0.2.2` source. Phase 1B pins `0.2.2` exact (per §8 decision #9, updated per §9 N1 from the earlier `0.0.13` snapshot). Findings below apply directly to the pinned version; the supervisor in §6.1.6 closes each gap.

| Property | Finding | Citation (in SDK source) |
|---|---|---|
| `bot.start()` body | Lazy `getMyInfo()`, then `await polling.loop(handleUpdate)` — never resolves until `stop()` aborts. | `src/bot.ts:60-73` |
| Per-request long-poll timeout | **Not set by SDK.** `Polling.loop` only passes `{ marker }`; native `fetch` is invoked without an `AbortSignal`-driven timeout. | `src/core/network/polling.ts:24-26`, `src/core/network/api/client.ts:50-53` |
| Network-error handling | Catches only `err.name === 'FetchError'`. Native Node `fetch` throws `TypeError` (with `cause` set to undici `AbortError`/`SocketError`) — those fall through and kill the loop. | `src/core/network/polling.ts:33,44` |
| HTTP 5xx | Caught via `MaxError`; logs, waits 5 s, then `return`s instead of `continue`ing — loop exits after a single 5 s wait. (Control-flow bug in shipped SDK.) | `src/core/network/polling.ts:8,33-40` |
| HTTP 401 (token revoked) | Synthesized as `MaxError(401)`; **not** in the retry whitelist; propagates and crashes the loop. `bot.handleError` defaults to `process.exitCode = 1` and rethrow. | `src/core/network/api/client.ts:55-63`, `src/bot.ts:49-53` |
| HTTP 429 + `Retry-After` | Caught and waits the same hard-coded 5 s. **`Retry-After` header is not read** — the client discards all response headers and returns only `{ status, data }`. | `src/core/network/polling.ts:8,34-40`, `src/core/network/api/client.ts:65-68` |
| Built-in exponential backoff | **None.** Single fixed `RETRY_INTERVAL = 5_000` ms; no jitter, no growth, no cap. | `src/core/network/polling.ts:8` |
| `marker` / offset (resume after restart) | A `marker` exists in the wire protocol and in-memory (updated after each batch), but **the SDK does not persist it and does not expose it via public API**. Process restart re-initializes `marker = undefined`. Functionally **not equivalent** to Telegram's host-managed `getUpdates` `offset`. | `src/core/network/polling.ts:13,24-27`, `src/core/network/api/modules/subscriptions/types.ts:7,14` |
| `bot.stop()` semantics | Aborts an `AbortController`, but the signal is **not wired into `fetch()`** — the in-flight long-poll request completes naturally; the loop exits on the next `while` check. `stop()` returns immediately and does not await the loop or in-flight handler promises. | `src/bot.ts:75-83`, `src/core/network/polling.ts:50-53`, `src/core/network/api/client.ts:50-53` |
| Stable update IDs | **None on wire.** The SDK's internal id is the debug label `` `${update.update_type}:${update.timestamp}` `` (two updates can collide on the same millisecond). Stable dedupe keys must come from inner payload ids — `message.body.mid`, `callback.callback_id`, etc. | `src/core/network/api/types/subcription.ts:5-10`, `src/bot.ts:86` |

**Implications for Phase 1.** The shipped SDK does **not** meet production polling requirements out of the box. The plugin must:

1. Wrap `bot.start()` in an outer supervisor that catches the `start()` rejection and restarts the `Bot` instance with backoff, because most error paths exit the loop after a single fixed 5 s wait.
2. Persist `marker` itself by either (a) subclassing `Polling` to expose it, (b) bypassing `bot.start()` and calling `api.getUpdates({ marker })` directly, or (c) accepting event replay or loss across restarts. Decision pending — see §9 question N2.
3. Implement plugin-layer dedupe keyed off payload-level ids (`message.body.mid`, `callback.callback_id`) if (b) or (c) above is chosen — see §9 question N3.
4. Implement custom backoff with jitter and `Retry-After` parsing (the SDK provides neither).
5. Treat `bot.stop()` as fire-and-forget; track in-flight handler promises externally if a graceful-shutdown SLA matters.

#### 6.1.2 Configuration surface (`channels.max-messenger.polling`)

Adds to `MaxConfigSchema` (§5.2). All fields optional with defaults from §8.

```typescript
import { z } from "openclaw/plugin-sdk/zod";

const MaxPollingConfigSchema = z
  .object({
    // Long-poll request timeout passed to MAX (the server holds the connection
    // open up to this many seconds before responding). Maps to `GetUpdatesDTO.timeout`.
    timeoutSec: z.number().int().min(1).max(120).default(30),

    // Initial backoff after a transient error (network, 5xx, 429 without Retry-After).
    // Doubles on each consecutive failure, capped at `maxBackoffMs`, with jitter.
    retryBackoffMs: z.number().int().min(100).max(60_000).default(1_000),

    // Cap for exponential backoff growth.
    maxBackoffMs: z.number().int().min(1_000).max(300_000).default(30_000),

    // SIGTERM grace window. After `await bot.stop()` returns we wait up to this
    // long for in-flight handler promises to drain before force-exit.
    gracefulShutdownTimeoutMs: z.number().int().min(500).max(30_000).default(5_000),

    // Persist `marker` across restarts so polling resumes from the last ack'd
    // event. Default `true` — the supervisor (§6.1.6) bypasses `bot.start()` and
    // owns the loop, so marker persistence becomes the sane default. Set to
    // `false` only for diagnostics (force-replay) or to opt out of state writes.
    resumeFromLastEvent: z.boolean().default(true),
  })
  .default({});
```

Wired into `MaxAccountSchemaBase` (§5.2):

```typescript
const MaxAccountSchemaBase = z
  .object({
    // ... existing fields ...
    polling: MaxPollingConfigSchema,
  })
  .strict();
```

User-facing example:

```jsonc
{
  "channels": {
    "max-messenger": {
      "tokenFile": "~/.openclaw/credentials/max-messenger-bcai.token",
      "transport": "polling",
      "polling": {
        "timeoutSec": 30,
        "retryBackoffMs": 1000,
        "maxBackoffMs": 30000,
        "gracefulShutdownTimeoutMs": 5000,
        "resumeFromLastEvent": true
      }
    }
  }
}
```

#### 6.1.3 Lifecycle integration with the openclaw Gateway

The plugin's `gateway.startAccount(ctx)` hook is the entry point. Pattern is identical in shape to nextcloud-talk's `extensions/nextcloud-talk/src/gateway.ts:14-43` but wraps a polling supervisor in `runStoppablePassiveMonitor` (`src/plugin-sdk/extension-shared.ts:69`) instead of an HTTP listener. The supervisor is detailed in §6.1.6 — this subsection covers only the lifecycle plumbing.

**Hook contract.** `ChannelGatewayAdapter` is defined at `src/channels/plugins/types.adapters.ts:341`; lifecycle hooks at `src/channels/plugins/types.adapters.ts:545`.

| Hook | When called | MAX plugin behavior |
|---|---|---|
| `gateway.startAccount(ctx)` | First account materialization or after config reload | Build the custom polling supervisor (§6.1.6) and run it inside `runStoppablePassiveMonitor`; return once the supervisor is registered. The supervisor owns its own loop — no `bot.start()`. |
| `gateway.logoutAccount(ctx)` | Account removed | Clear persisted marker, clear secrets, trigger config write with auto-reload. |
| `lifecycle.onAccountConfigChanged(ctx)` | Token / transport / polling config changed | If the token-hash changed: invalidate marker (per §8 #17), then trigger a stop+start cycle on the affected account (Telegram analogue: `extensions/telegram/src/channel.ts:741`). |
| `lifecycle.onAccountRemoved(ctx)` | Account deleted | Same as `logoutAccount` plus full state cleanup. |

The gateway always passes `ctx.abortSignal` (`src/channels/plugins/types.adapters.ts:238-312`); the supervisor's lifetime is bound to that signal.

**Sketch (Phase 1B, single-account form).** Mirrors `extensions/nextcloud-talk/src/gateway.ts:14-43` and `extensions/telegram/src/polling-session.ts:120-352` for the supervisor shape. The supervisor implementation is in §6.1.6.

```typescript
// extensions/max-messenger/src/gateway.ts
import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
import { createMaxPollingSupervisor } from "./monitor-polling.runtime.js";

export const maxMessengerGatewayAdapter: ChannelGatewayAdapter<ResolvedMaxAccount> = {
  startAccount: async (ctx) => {
    const status = createAccountStatusSink(ctx);
    await runStoppablePassiveMonitor({
      abortSignal: ctx.abortSignal,
      start: async ({ stopSignal }) => {
        const supervisor = createMaxPollingSupervisor({
          account: ctx.account,
          runtime: ctx.runtime,
          polling: ctx.cfg.polling, // from MaxPollingConfigSchema
          markerStore: ctx.runtime.markerStore, // see §6.1.6
          dispatch: (update) => handleMaxInbound(ctx, update),
          status,
          log: ctx.log,
        });
        try {
          await supervisor.run(stopSignal); // resolves when stopSignal fires
        } finally {
          await supervisor.shutdown(ctx.cfg.polling.gracefulShutdownTimeoutMs);
        }
      },
    });
  },
  logoutAccount: async (ctx) => {
    await ctx.runtime.markerStore?.clear(ctx.accountId);
  },
};
```

**Token rotation without gateway restart.** Handled by `lifecycle.onAccountConfigChanged`: if the new token's hash differs from the stored one, invalidate marker (per §8 #17 / §9 N7) and trigger a stop+start cycle on the affected account. The supervisor's `shutdown(timeoutMs)` ensures the old loop drains (or is given up on) before the new instance starts.

**Gateway shutdown (SIGTERM).** Gateway aborts `ctx.abortSignal`; `runStoppablePassiveMonitor` invokes the stop branch which calls `supervisor.shutdown(gracefulShutdownTimeoutMs)`. The supervisor flushes any pending marker write, races in-flight handler promises against a `setTimeout` for `gracefulShutdownTimeoutMs`, and emits `max-messenger.polling.shutdown_timeout` (see §6.1.5) if the deadline elapses.

#### 6.1.4 Failure modes

| Scenario | Detection | Plugin reaction | User-visible effect |
|---|---|---|---|
| MAX API DNS / network unreachable | `fetch` throws (undici `TypeError` with `cause`); SDK kills the loop | Supervisor catches rejection; exponential backoff (`retryBackoffMs` → `maxBackoffMs`) with jitter; warn every Nth retry | None (silent retry); status badge flips to `degraded` after N consecutive failures |
| Long-poll request hangs (no response, no socket close) | Supervisor's outer wall-clock timer (`timeoutSec + 10 s` slack) fires | Force-kill `Bot` instance; rebuild from scratch | Brief gap, then resume |
| HTTP 5xx from MAX | SDK `MaxError(5xx)` exits the loop after one 5 s wait | Supervisor catches resolution; backoff + restart | Brief gap, then resume |
| HTTP 429 with `Retry-After` | Supervisor's HTTP wrapper reads response headers (§6.1.6) | Honor `Retry-After` (sec-int or HTTP-date). Fallback when header is absent: exponential growth (`retryBackoffMs` → `maxBackoffMs`). | Brief delay |
| HTTP 401 (token revoked) | Supervisor's HTTP wrapper sees 401 status | Halt supervisor, mark account `unauthorized`, emit `max-messenger.polling.fatal`; require admin re-issue via `openclaw doctor` or `openclaw onboard`. | Channel marked offline in `openclaw status` |
| Gateway SIGTERM during in-flight long-poll | `ctx.abortSignal` fires | Supervisor calls `abortController.abort()` which is wired through to the `fetch` call (§6.1.6); flushes pending marker write; races in-flight handler drain vs `gracefulShutdownTimeoutMs` (default 5 s); force-exit on timeout. | Brief unresponsiveness during restart |
| Unhandled exception inside `dispatch` | Caught by supervisor's per-update try/catch | Log + swallow; do not affect loop; emit warning. | Single message dropped |
| Same event delivered twice (after restart with marker reset / replay) | Same `mid` / `callback_id` seen against in-memory LRU (size 10000, TTL 1 h, per §8 #16) | Drop the duplicate; do not invoke `dispatch`. | None (silent dedup) |
| Marker-write failure after dispatch | Storage error in `markerStore.set` | Log warning; rely on dedup (#16) on next restart; do not block the loop. | None (silent recovery) |

#### 6.1.5 Telemetry (minimum)

The supervisor emits via `runtime.log` and the status sink:

- `max-messenger.polling.restart` — every supervisor-driven restart, with `{ accountId, attempt, backoffMs, lastError }`.
- `max-messenger.polling.fatal` — terminal stop after a non-recoverable error (e.g. 401), with `{ accountId, error }`.
- `max-messenger.polling.shutdown_timeout` — when graceful shutdown exceeded `gracefulShutdownTimeoutMs`.
- `max-messenger.polling.marker_reset` — when persisted marker is cleared (token rotation, explicit reset). Only fires when `resumeFromLastEvent` is on.

#### 6.1.6 Custom Polling Supervisor (per §9 N2 + N4)

The supervisor bypasses `bot.start()` entirely and owns the polling loop. This folds N2 (marker persistence), N3 (dedup), and N4 (custom HTTP for `Retry-After` + timeout + abort wiring) into one cohesive module so each SDK gap is closed in the same place.

**Module layout.**

```
extensions/max-messenger/src/
├── monitor-polling.runtime.ts   # createMaxPollingSupervisor (entry point)
├── polling-loop.ts              # async loop: fetch updates, dispatch, advance marker
├── polling-http.ts              # custom HTTP wrapper (Retry-After, timeout, AbortSignal)
├── marker-store.ts              # persistent { tokenHash, marker } per accountId
└── dedup-cache.ts               # bounded LRU keyed on mid / callback_id
```

**Loop pseudocode (`polling-loop.ts`).** Calls the SDK's HTTP layer directly with explicit `marker` and `timeout`, then dispatches via the SDK's `handleUpdate` so we keep all the SDK's parsers and convenience handlers without inheriting `bot.start()`'s control-flow bugs.

```typescript
import { Api } from "@maxhub/max-bot-api"; // exposed `api` namespace
import { createPollingHttp } from "./polling-http.js";
import { createMarkerStore } from "./marker-store.js";
import { createDedupCache } from "./dedup-cache.js";

export async function runPollingLoop(opts: {
  api: Api;
  account: ResolvedMaxAccount;
  polling: MaxPollingConfig;
  markerStore: MarkerStore;
  dedup: DedupCache;
  dispatch: (update: Update) => Promise<void>;
  stopSignal: AbortSignal;
  log: ChannelLogger;
  status: AccountStatusSink;
}): Promise<void> {
  let { marker } = await opts.markerStore.load(opts.account.accountId, opts.account.tokenHash);
  let backoffMs = opts.polling.retryBackoffMs;

  while (!opts.stopSignal.aborted) {
    try {
      const updates = await opts.api.getUpdates(
        { marker, timeout: opts.polling.timeoutSec, limit: 100 },
        { signal: opts.stopSignal, requestTimeoutMs: (opts.polling.timeoutSec + 10) * 1000 },
      );
      backoffMs = opts.polling.retryBackoffMs; // reset on success
      for (const update of updates) {
        if (opts.stopSignal.aborted) return;
        const dedupKey = extractDedupKey(update); // mid | callback_id | undefined
        if (dedupKey && opts.dedup.seen(dedupKey)) continue;
        try {
          await opts.dispatch(update);
        } catch (err) {
          opts.log.warn("dispatch threw, dropping update", { err, update_type: update.update_type });
        }
        if (dedupKey) opts.dedup.record(dedupKey);
      }
      const nextMarker = computeNextMarker(updates, marker);
      if (nextMarker !== marker) {
        marker = nextMarker;
        opts.markerStore.set(opts.account.accountId, opts.account.tokenHash, marker)
          .catch((err) => opts.log.warn("marker write failed", { err })); // dedup absorbs replay
      }
    } catch (err) {
      const action = classifyPollingError(err); // see polling-http.ts
      if (action.kind === "fatal") {
        opts.status.setStatus({ phase: "offline", reason: "unauthorized" });
        opts.log.error("max-messenger.polling.fatal", { err });
        return;
      }
      const sleepMs = action.retryAfterMs ?? backoffMs;
      opts.log.warn("max-messenger.polling.restart", { reason: action.kind, sleepMs });
      await abortableSleep(sleepMs, opts.stopSignal);
      if (action.retryAfterMs === undefined) {
        backoffMs = Math.min(backoffMs * 2, opts.polling.maxBackoffMs); // exponential
        backoffMs = applyJitter(backoffMs); // ±20%
      }
    }
  }
}
```

**HTTP wrapper (`polling-http.ts`).** Wraps the SDK's `Api` constructor with a `fetch` adapter that:

- Passes `AbortSignal` (caller-supplied) into `fetch(..., { signal })`.
- Sets a per-request timeout via `AbortSignal.timeout(requestTimeoutMs)` composed with the caller signal (whichever fires first).
- Captures `Retry-After` from 429 responses (parsing both seconds-int and HTTP-date forms) and re-throws a typed `RetryAfterError` so the loop can wait the exact duration.
- Maps 401 → typed `UnauthorizedError` (loop treats as `fatal`).
- Maps 5xx → typed `ServerError` (loop treats as transient → exponential backoff).
- Maps undici/Node `TypeError` (with `cause` of `AbortError`/`SocketError`/timeout) → typed `NetworkError` (loop treats as transient).
- Reused for non-polling MAX API calls (`send_message`, `set_webhook`, etc.) so error semantics stay uniform.

**Marker store (`marker-store.ts`).**

```typescript
type MarkerEntry = { tokenHash: string; marker: number };

export interface MarkerStore {
  load(accountId: string, currentTokenHash: string): Promise<{ marker?: number }>;
  set(accountId: string, tokenHash: string, marker: number): Promise<void>;
  clear(accountId: string): Promise<void>;
}
```

- `load` reads the per-account file under `~/.openclaw/state/channels/max-messenger/<accountId>.json`. If `tokenHash` differs from the stored one → returns `{ marker: undefined }` and emits `max-messenger.polling.marker_reset` (per §8 #17 / §9 N7).
- `set` writes atomically (write to `*.tmp`, rename) so a crash mid-write does not corrupt the file.
- `clear` removes the file (used by `gateway.logoutAccount` and `lifecycle.onAccountRemoved`).

**Dedup cache (`dedup-cache.ts`).** Plain bounded LRU; size 10000, TTL 1 h (per §8 #16). Keys: `msg:<mid>` for `message_*` events and `cb:<callback_id>` for `message_callback`. If neither id is present, log `dedup_key_missing` and process the update anyway.

**Restart contract.** The supervisor restarts the inner `runPollingLoop` only on transient errors (`network`, `429`, `5xx`); fatal errors (`401`) halt and surface to the gateway as `phase: "offline"`. Outer `runStoppablePassiveMonitor` handles SIGTERM via the abort signal already passed into the loop.

#### 6.1.7 Fake-MAX Test Harness (per §9 N6 — Phase 1B.0 prerequisite)

Lightweight HTTP server at `extensions/max-messenger/test/fake-max-server/` that mimics the MAX polling and basic outbound endpoints. Used for supervisor unit tests and for manual exploratory testing before the real bot token arrives.

**File layout.**

```
extensions/max-messenger/test/fake-max-server/
├── README.md                  # how to run scenarios; contract with supervisor tests
├── server.ts                  # fastify server (or whatever's in workspace already)
├── scenarios/
│   ├── happy-path.json
│   ├── 429-with-retry-after.json
│   ├── 5xx-then-success.json
│   ├── network-drop.json
│   ├── slow-response.json
│   ├── marker-replay.json
│   └── 401-revoked.json
└── scenarios.test.ts          # supervisor integration tests against fake server
```

**Scenario JSON shape.**

```jsonc
// scenarios/429-with-retry-after.json
{
  "description": "Two consecutive 429s with Retry-After=2s, then success.",
  "responses": [
    { "status": 429, "headers": { "Retry-After": "2" } },
    { "status": 429, "headers": { "Retry-After": "2" } },
    { "status": 200, "body": { "updates": [/* one message_created */] } }
  ]
}
```

**Required scenarios (Phase 1B.0).**

| Scenario | Verifies |
|---|---|
| `happy-path` | Marker advances; dispatch invoked; loop continues. |
| `429-with-retry-after` | Supervisor honors `Retry-After` exactly (sec-int and HTTP-date variants); does not double-back-off. |
| `5xx-then-success` | Exponential backoff doubles up to `maxBackoffMs`, resets on success. |
| `network-drop` | `fetch` throws `TypeError`/`AbortError`; supervisor classifies as transient and retries. |
| `slow-response` | Long-poll exceeds `timeoutSec + 10s`; supervisor's request timeout fires; loop treats as transient. |
| `marker-replay` | Same `mid` returned in two consecutive batches; dedup cache drops the duplicate. |
| `401-revoked` | Supervisor halts loop, sets status `unauthorized`, emits `polling.fatal`. |

**Server contract.** `server.ts` exports `start({ scenarioPath, port })` and `stop()`; tests start it on an ephemeral port, point the supervisor's `apiRoot` at `http://localhost:<port>`, run, and assert the supervisor's behavior + emitted telemetry. README documents the manual workflow: `pnpm tsx extensions/max-messenger/test/fake-max-server/server.ts scenarios/<name>.json --port 9999` so the plugin can be exercised locally without modifying tests.

This harness is the gating proof for the Phase 1B PR — supervisor lands when all seven scenarios pass against it.

### Phase 2 — Webhook transport

Owner decision (§8 #3): MAX webhooks are unsigned in public docs, so Phase 2 ships a defense-in-depth model — HTTPS-only, secret URL segment, optional IP allowlist — and tracks an explicit TODO to probe for an undocumented signature header against a live bot.

In scope:
- `monitor-webhook.runtime.ts` mirrors `extensions/nextcloud-talk/src/monitor.ts:228-385` (HTTP listener, body limit, rate limiter, healthz). HTTPS-only — config validation rejects plain `http://` `webhookUrl` outside loopback.
- New config field `channels.max-messenger.webhookSecret` (string, 32 chars). Generated by `openclaw onboard` and embedded into the public URL: `/webhook/max-messenger/<secret>`. Requests not matching the path-segment secret get a 404 (without timing leakage).
- New config field `channels.max-messenger.allowedIPs[]` (string[], default `[]` = disabled). When non-empty, requests from peers outside the list get a 403.
- `replay-guard.ts` mirrors `extensions/nextcloud-talk/src/replay-guard.ts` (in-memory dedupe by `(accountId, chatId, messageId)`; for MAX `messageId = message.body.mid` per §6.1.1 #10).
- `signature.ts` — placeholder. Phase 2 TODO: probe live MAX webhook headers for an undocumented signature; if present, wire HMAC verification here. Until verified absent or implemented, document plaintext POST limitation in `docs/channels/max-messenger.md`.
- Doctor warning when both `transport: "webhook"` and `webhookUrl` missing, or vice versa; also when `webhookUrl` is `http://` (non-loopback) or when `webhookSecret` is missing/short.
- Lifecycle: on switch from webhook → polling, call `delete_webhook` first (per MAX docs §Transports). Then start polling supervisor (§6.1).

Tests:
- Webhook handler unit tests (`monitor.replay.test.ts`-style).
- Path-secret rejection test (404 for wrong segment, success for right segment).
- IP allowlist test (403 for non-listed peer).
- E2E: BCAi pairs with a public Cloudflare tunnel, real MAX → tunnel → BCAi → reply.

Branch: `feat/max-messenger-webhook-transport`. PR title: `feat(max-messenger): webhook transport`.

### Phase 3 — Callback buttons + inline keyboard

In scope:
- `handlers.ts` route for `message_callback`.
- `send.ts` extension: `attachments` parameter accepts `CallbackButton[] | LinkButton[]` and serializes to MAX `attachments` schema (per `docs/max-plugin/max-api-reference.md` "Keyboards & buttons").
- `approvalCapability` wired through `createApproverRestrictedNativeApprovalCapability` (see `docs/plugins/sdk-channel-plugins.md:91`) so `/approve` flows can render MAX buttons. Alternatively, ship the simpler "no native approvals" path first and rely on text `/approve`.
- `groups.resolveRequireMention` and `groups.resolveToolPolicy` ported from `extensions/nextcloud-talk/src/channel.ts:99-120`.
- `setupWizard` (interactive): prompt for token, dmPolicy, allowFrom — port `extensions/nextcloud-talk/src/setup-surface.ts`.

Tests: callback round-trip unit test; approval render snapshot.

Branch: `feat/max-keyboards`. PR title: `feat(max): inline keyboards and callback buttons`.

### Phase 4 — Attachments (images, files)

In scope:
- `attachments.ts` implements MAX two-step upload (`POST /uploads` → put binary → reference token).
- `send.ts` `sendMedia(...)` wires `mediaUrl` into a downloaded buffer + uploaded token.
- Inbound: parse `attachments[]` in `message_created`, expose first image/file via `MaxInboundMessage.attachments`.
- Capability flag `media: true` flips on (was `false` in Phase 1).

Tests: mock `fetch` for upload presign; verify outbound serializes `attachments[{ token }]` correctly.

Branch: `feat/max-attachments`. PR title: `feat(max): attachments (image/file send and receive)`.

### Phase 5 — Multi-account support + standalone npm release

Owner decision (§8 #5, #10): Phase 5 is the natural home for both multi-account work and the first `@bccontrol/openclaw-max-messenger` npm publish (insurance ahead of the upstream PR). The two ship in the same phase because the secret-contract and config-prefix surface settles only once multi-account is real.

In scope (multi-account):
- Promote `account-config.ts` and `account-selection.ts` to use `accounts.*` and `defaultAccount` fully (Phase 1 stub becomes real).
- `secret-contract.ts` adds `channels.max-messenger.accounts.*.token` entries (mirror `extensions/nextcloud-talk/src/secret-contract.ts:11-55`).
- Status snapshot per-account.
- CLI: `openclaw max-messenger status [--account <id>]` lists configured accounts (via `registerCli` in `index.ts`).
- Marker persistence (per §6.1.1 #8 and §9 N2 once N2 is answered): per-account `marker` storage to enable `polling.resumeFromLastEvent` reliably.

In scope (standalone npm publish):
- Add `install.npmSpec: "@bccontrol/openclaw-max-messenger"` to `package.json` `openclaw` block.
- Add `release.publishToClawHub` if/when ClawHub catalog accepts it.
- Verify package contents under `Package Acceptance` workflow before first publish.

Tests: account merge / default-account fallback / disabled-account skip; marker round-trip across simulated restart; package acceptance smoke for the published artifact.

Branch: `feat/max-messenger-multi-account`. PR title: `feat(max-messenger): multi-account support and npm publish`.

> Long-term: after Phase 5–6 stabilize on real BCAi traffic, open a PR to `openclaw/openclaw` upstream that lifts `extensions/max-messenger/` into the bundled set. Until then the bundled+npm dual ship is the safety net.

### Phase 6 — Test sweep

Bring coverage up to nextcloud-talk levels (~10 test files). Targets:
- `accounts.test.ts` — token resolution sources.
- `config-schema.test.ts` — invalid configs rejected with helpful messages.
- `inbound.test.ts` — DM/group/pairing decisions.
- `inbound.replay.test.ts` — dedupe (Phase 2 carry-over).
- `send.test.ts` — chunking, reply-to threading.
- `setup.test.ts` — setup adapter validates inputs and writes config.
- `doctor.test.ts` — diagnostic messages for misconfig.
- `policy.test.ts` — group allowlist matching.
- `gateway.test.ts` — startAccount / logoutAccount.
- `e2e.test.ts` — opt-in (`OPENCLAW_LIVE_TEST=1`) full polling round-trip with a fake bot server.

Then update `docs/channels/max.md` and `docs/install/*` references; add MAX to plugin inventory.

Branch: `chore/max-tests`. PR title: `chore(max): add unit and integration tests`.

---

## 7. Open questions (need Mikhail's answers before Phase 1 codes)

Numbered so they can be answered inline as a PR comment.

1. **Bot registration timeline.** Phase 1 cannot be smoke-tested without a real `MAX_BOT_TOKEN`. Has the legal entity (ООО «Бизнес-Климат Контрол» or ООО «BS FM») already started moderation at dev.max.ru? Approximate ETA?

   **Resolution:** Registration starts immediately under **ООО «Бизнес-Климат Контрол»** (existing Минцифры registry experience → cleaner moderation than БС ФМ). Realistic ETA 5–10 working days. Phase 1 codes against a mocked SDK without a live token; live smoke is run after the token arrives.

2. **Channel id `"max"` vs `"max-messenger"`.** I propose `id: "max"` (short, matches user-facing branding). The aliases `["max-messenger"]` accept the longer form. If you'd prefer `"max-messenger"` as primary (to avoid clashing with future Anthropic "max" model labels in CLI completion), say so now — it's harder to rename later.

   **Resolution:** Use `id: "max-messenger"` as primary, `aliases: ["max"]` as shorthand. `"max"` is too generic to grep cleanly in logs/configs, conflicts with model labels, and upstream openclaw prefers fully-qualified channel ids (precedents: `nextcloud-talk` not `nc`, `google-chat` not `google`).

3. **Webhook signature.** `docs/max-plugin/max-api-reference.md` doesn't list a webhook signature header. Confirm that MAX webhook delivery is unsigned plaintext POST (in which case Phase 2 mandates HTTPS + secret URL path + IP allowlist) or point me at the signature spec if one exists.

   **Resolution:** Confirmed unsigned in public docs. Phase 2 ships defense-in-depth: HTTPS-only (config validation rejects `http://` outside loopback) + secret 32-char URL segment `/webhook/max-messenger/<secret>` (generated at `openclaw onboard`, stored in `channels.max-messenger.webhookSecret`) + optional `channels.max-messenger.allowedIPs[]` (empty default = disabled). Phase 2 TODO: probe a live webhook for an undocumented signature header.

4. **dmPolicy default.** Russian-language onboarding might want different defaults — should default `dmPolicy` be `"pairing"` (like nextcloud-talk and Telegram) or `"allowlist"` (more conservative)?

   **Resolution:** `"pairing"`. Consistency with nextcloud-talk and Telegram outweighs locale-specific tuning; Russian-language onboarding can explain the pairing flow without changing the security model.

5. **Multi-account in Phase 1.** Phase 1 ships single-account only; multi-account is Phase 5. OK to defer, or do you need prod + staging in parallel from day one?

   **Resolution:** Single-account in Phase 1; multi-account formally lands in Phase 5. Prod/staging parallelism is not needed until production traffic cutover, which is timed to land alongside Phase 5.

6. **MAX message length limit.** Listed as open question in `max-api-reference.md`. Phase 1 uses `textChunkLimit: 4000` (Telegram default). Is that right for MAX?

   **Resolution:** Phase 1 default `textChunkLimit: 4000`, exposed in code as the named constant `MAX_TEXT_CHUNK_LIMIT` with a `// TODO: verify empirically` comment. Unofficial sources cite ~4000 chars but no `dev.max.ru` confirmation; README marks `verified empirically: TODO` until first smoke test.

7. **Block-streaming default.** Nextcloud-talk sets `blockStreaming: true` (suppress streaming, send final block only) and Telegram defaults to streaming. MAX has no documented streaming UX — propose `blockStreaming: true` in Phase 1. Confirm?

   **Resolution:** Confirmed `blockStreaming: true` in Phase 1. MAX has no documented streaming UX; spamming `edit_message` every ~200 ms is risky until mobile-client rendering is verified. Streaming flip will be a separate PR after live UX testing.

8. **Reference to `docs/tools/plugin.md`.** That path doesn't exist in this repo; the actual authoring docs live at `docs/plugins/building-plugins.md`, `docs/plugins/sdk-channel-plugins.md`, and `docs/plugins/manifest.md`. Update CONTEXT.md when convenient. (Not blocking.)

   **Resolution:** Owner will fix `CONTEXT.md` paths in a separate PR (`docs/plugins/building-plugins.md`, `docs/plugins/sdk-channel-plugins.md`, `docs/plugins/manifest.md`). Not blocking Phase 1.

9. **`@maxhub/max-bot-api` version pin.** I plan to pin `^0.0.13` (current). Confirm acceptable, or pin tighter (e.g. exact version) until the SDK stabilizes.

   **Resolution:** Exact pin `"@maxhub/max-bot-api": "0.0.13"` (no caret). SDK is pre-1.0 (`0.0.x`) — every minor is a potential breaking change under semver. Upgrades go through `pnpm update` after explicit changelog review; relax to `^1.0.0` only once the SDK reaches `1.x`.

   **Superseded by §9 N1 Resolution:** the pin moved from `0.0.13` to `0.2.2` (still exact). The "exact pin, pre-1.0 caution" rationale stands; only the version target changed.

10. **Upstream contribution.** Is the eventual contribution path "PR to openclaw/openclaw" or "publish standalone `@openclaw/max` to npm/ClawHub"? Affects whether to add `install.npmSpec` in `package.json` (Phase 5) and whether to follow the bundled-plugin or external-plugin entrypoint pattern (currently planned: bundled).

   **Resolution:** Bundled in `extensions/max-messenger/` for Phases 1–5 (mirroring `nextcloud-talk`). Phase 5+ also publishes `@bccontrol/openclaw-max-messenger` on npm as release insurance. Long-term goal: PR to `openclaw/openclaw` upstream after stabilization on real BCAi traffic. Phase 1 omits `install.npmSpec`.

---

## 8. Decisions Locked for Phase 1

Locked from the PR #2 owner answers (https://github.com/mefodiytr/openclaw/pull/2#issuecomment-4365909719) and the SDK audit in §6.1.

| #  | Decision                                       | Value                                                                  | Rationale                                                                                                                              |
|----|------------------------------------------------|------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------|
| 1  | Bot legal entity                               | ООО «Бизнес-Климат Контрол»                                            | Existing Минцифры registry experience → cleaner moderation than the БС ФМ alternative. Phase 1 codes against mocked SDK without token. |
| 2  | Channel id (primary)                           | `max-messenger` (alias `max`)                                          | Avoids collision with model "max" labels; matches upstream convention (`nextcloud-talk`, `google-chat`); cleaner to grep in logs.      |
| 3  | Webhook security model (Phase 2)               | HTTPS-only + secret URL segment + optional IP allowlist                | MAX has no documented webhook signature; defense-in-depth until/unless an undocumented signature header is found in Phase 2 probe.     |
| 4  | dmPolicy default                               | `"pairing"`                                                            | Consistency with nextcloud-talk and Telegram outweighs locale-specific tuning.                                                         |
| 5  | Multi-account in Phase 1                       | Single-account only; multi-account → Phase 5                           | Prod/staging parallelism not needed until production traffic cutover.                                                                  |
| 6  | textChunkLimit                                 | `4000` (named constant `MAX_TEXT_CHUNK_LIMIT`, with TODO)              | Unverified upstream limit; revisit after first empirical smoke test.                                                                   |
| 7  | blockStreaming default                         | `true`                                                                 | MAX has no documented streaming UX; avoid spamming `edit_message` until live UX is verified on mobile clients.                         |
| 8  | CONTEXT.md docs path correction                | Owner will fix in a separate PR                                        | Not blocking Phase 1.                                                                                                                  |
| 9  | `@maxhub/max-bot-api` version pin              | Exact `0.2.2` (no caret) — updated from `0.0.13` per §9 N1             | `0.0.13` was a CONTEXT.md snapshot, not a deliberate choice. `0.2.2` has a more settled API; SDK bugs are mitigated by the custom supervisor (§6.1.6) regardless.                                                              |
| 10 | Upstream contribution path                     | Bundled in `extensions/max-messenger/` (Phases 1–5); npm `@bccontrol/openclaw-max-messenger` (Phase 5+); upstream PR after stabilization | Bundled = fastest iteration; npm = release insurance; upstream = long-term home.                                                       |
| 11 | Long-poll request timeout (`timeoutSec`)       | `30` seconds                                                           | Standard long-poll window; balances latency vs server load.                                                                            |
| 12 | Initial retry backoff (`retryBackoffMs`)       | `1000` ms                                                              | Conservative start; lets brief MAX glitches clear without retry-spam.                                                                  |
| 13 | Max retry backoff (`maxBackoffMs`)             | `30000` ms                                                             | Cap to avoid stalled bot during prolonged MAX outage.                                                                                  |
| 14 | Graceful shutdown timeout                      | `5000` ms                                                              | Balances UX (don't drop in-flight reply) vs gateway restart speed.                                                                     |
| 15 | Resume from last event (`resumeFromLastEvent`) | Default `true` via custom supervisor loop (per §9 N2)                  | Supervisor bypasses `bot.start()` and persists `marker` natively (§6.1.6); resuming becomes the sane default.                          |
| 16 | Inbound dedup (per §9 N3)                      | LRU 10000 entries, TTL 1 h, keyed on `message.mid` and `callback_id`   | Cheap insurance against marker-write race + replay; no DB needed in Phase 1.                                                           |
| 17 | Marker invalidation on token change (per §9 N7) | Yes — hash-keyed marker file `{ tokenHash, marker }`                  | Marker is per-bot state; rotating the token implies a possible identity change. Replay on first post-rotation poll absorbed by dedup (#16). |
| 18 | Test harness location (per §9 N6)              | `extensions/max-messenger/test/fake-max-server/`                       | JSON-configurable fake MAX polling server; blocks Phase 1B supervisor PR; unblocks supervisor verification before bot moderation finishes (§6.1.7). |

---

## 9. Phase 1 Long Polling — New Open Questions

Surfaced by the SDK audit in §6.1.1; resolved by the owner answers in PR #2 (https://github.com/mefodiytr/openclaw/pull/2#issuecomment-4366189435). Resolutions feed §6.1.6 (custom supervisor), §6.1.7 (test harness), and the §8 lock table.

**N1. SDK version sanity-check.** The audit in §6.1.1 was performed against `@maxhub/max-bot-api` `0.2.2` (latest published). Phase 1 pin is `0.0.13` (decision §8 #9). Should we (a) diff `0.0.13` source to confirm whether the loop-exits-after-one-error bug, missing `Retry-After` handling, missing `marker` persistence, and unwired `AbortSignal` described in §6.1.1 also exist in `0.0.13`; or (b) reconsider the version pin upward toward a release that fixes some of these? If (b), which version?

   **Resolution:** Pin to `0.2.2` instead of `0.0.13` (still exact, no caret). `0.0.13` was a snapshot from CONTEXT.md authoring, not a deliberate choice; `0.2.2` is more likely to have a settled API surface. SDK bugs are mitigated by the supervisor layer regardless. §2.1 package.json and §8 row #9 updated.

**N2. Marker persistence strategy.** The SDK keeps `marker` private and discards it on restart. Which approach for Phase 1?
- (a) Subclass / monkey-patch `Polling` to expose `marker` and call `markerStore.set` after each batch.
- (b) Bypass `bot.start()` entirely; call `api.getUpdates({ marker })` directly in a custom loop and feed updates into the SDK's `handleUpdate` ourselves.
- (c) Accept event replay or loss across restarts in Phase 1; defer real persistence to Phase 5.

   **Resolution:** Option (b). Bypass `bot.start()`; the supervisor owns the loop and dispatches updates through SDK parsers/handlers itself. Marker persisted at `channels.max-messenger.state.lastMarker`, modeled on Telegram's `extensions/telegram/src/polling-session.ts` offset persistence. Folds N4 into the same module. Architecture detailed in §6.1.6.

**N3. Inbound dedup at the openclaw layer.** If we restart with a stale marker (or without marker support at all), MAX will replay events. Should we dedupe at the plugin layer using `message.body.mid` for `message_created` and `callback.callback_id` for `message_callback`, with a short TTL (e.g. 1 hour) in-memory cache? Or rely on agent-side idempotency? Need a decision before N2.

   **Resolution:** Yes — bounded LRU (size 10000, TTL 1 h) keyed on `message.mid` for messages and `callback_id` for callbacks. Lives in the supervisor, not in handlers. If an event lacks both keys, log a warning and process anyway (better duplicate than silent drop). Verify the actual SDK event shape exposes these stable IDs before coding.

**N4. Custom HTTP fetch for `Retry-After` and request timeouts.** The SDK discards response headers and does not pass `AbortSignal` to `fetch`. To honor `Retry-After` and to bound a hung long-poll request, we need to override the SDK's `client.call`. OK to ship a small `client-override.ts` in Phase 1 (~50 LOC), or defer and accept worst-case behavior (5 s blanket backoff, sockets that hang for the OS default)?

   **Resolution:** Folded into N2. Since the supervisor writes its own polling loop, the HTTP client wrapper comes "free" in the same module. Honors `Retry-After` (parses sec-int and HTTP-date), per-request timeout = `polling.timeoutSec + 10` seconds, `AbortSignal` wired through `fetch`, 5xx → exponential backoff, 401 → halt + status `unauthorized`, network errors → backoff with logging every Nth retry. Reused for non-polling MAX API calls (e.g. `send_message`).

**N5. Polling-restart visibility.** `runtime.log` is fine for local debug. For production, do we want a structured event surfaced through the status sink so `openclaw status` shows "MAX channel restarted N times in last hour"? Or is silent self-healing fine until something explicitly fails?

   **Resolution:** Nice-to-have; ship in Phase 1B if it fits in &lt;2 h, else defer to Phase 5. Bare minimum: emit `polling.restart` telemetry (already in §6.1.5) with `reason` and consecutive-restart counter. Surface in `openclaw status` only if the existing infrastructure makes it trivial.

**N6. Empirical SDK behavior verification.** Several of §6.1.1's findings (HTTP 429 behavior in particular, and whether `bot.start()` actually exits as the source predicts) are read off the source. Should we set up a Phase 0.5 test harness — a fake MAX server that returns 401 / 429 / 5xx / network errors on demand — to validate the supervisor handles each correctly, before bot moderation finishes? This unblocks Phase 1 hardening without needing a real token.

   **Resolution:** Yes — build it as Phase 1B.0 (prerequisite for 1B), not a separate Phase 0.5. Lives at `extensions/max-messenger/test/fake-max-server/`, JSON-configurable scenarios, used in supervisor unit tests and in pre-token manual exploration. Spec in §6.1.7.

**N7. Bot instance restart vs full re-init on token rotation.** When `onAccountConfigChanged` sees a new token, do we (a) recreate the `Bot` in-place with stop+start, (b) invalidate the old persisted marker file, or (c) both? Option (a) risks the in-flight handler from the old instance racing the new one; option (b)+(a) is cleanest but means the new instance always replays the most recent batch. Need to confirm before §9 N2 lands.

   **Resolution:** Both — invalidate marker on token change. Marker state file stores `{ tokenHash, marker }`; startup compares stored hash to current config token hash and resets marker on mismatch (info-level log). The first poll after rotation replays one batch; dedup (N3) handles it gracefully. Same pattern extends to per-account markers in Phase 5.

---

## Summary

Phase 1 PR creates ~22 files (~1500 LOC) by translating nextcloud-talk's webhook plugin into a polling plugin that uses `@maxhub/max-bot-api` as the transport, plus a thin polling supervisor (§6.1) that compensates for the SDK's missing retry/backoff/marker plumbing. Subsequent phases each add one well-scoped feature in 200–400 LOC. The choice of nextcloud-talk over telegram as the structural template keeps the surface area small; we promote to telegram-style complexity only when MAX-specific needs require it (e.g. multi-account in Phase 5).

Total expected file count at Phase 6: roughly equal to nextcloud-talk's current ~30 files (production + tests).
