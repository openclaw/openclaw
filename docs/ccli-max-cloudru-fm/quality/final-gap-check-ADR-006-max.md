# Final Gap Check: ADR-006 MAX Messenger Extension

**Date:** 2026-02-16
**Checker:** Final Gap Check Specialist
**Scope:** MAX extension implementation vs ADR-006 specification vs Telegram reference
**Files reviewed:**

| Role           | File                                                                      |
| -------------- | ------------------------------------------------------------------------- |
| Implementation | `extensions/max/src/channel.ts`                                           |
| Implementation | `extensions/max/src/types.ts`                                             |
| Implementation | `extensions/max/src/accounts.ts`                                          |
| Implementation | `extensions/max/src/config-schema.ts`                                     |
| Implementation | `extensions/max/src/normalize.ts`                                         |
| Implementation | `extensions/max/src/runtime.ts`                                           |
| Implementation | `extensions/max/index.ts`                                                 |
| Implementation | `extensions/max/openclaw.plugin.json`                                     |
| Implementation | `extensions/max/package.json`                                             |
| Specification  | `docs/ccli-max-cloudru-fm/adr/ADR-006-max-messenger-extension.md`         |
| Quality report | `docs/ccli-max-cloudru-fm/quality/requirements-validation-ADR-006-max.md` |
| Reference      | `extensions/telegram/src/channel.ts`                                      |

---

## Checklist Results

### 1. Extension loads via openclaw.plugin.json

**Status: PASS**

`openclaw.plugin.json` is present with `"id": "max"` and `"channels": ["max"]`. The `package.json` declares `@openclaw/max` with `openclaw.extensions` pointing to `./index.ts`. The `index.ts` calls `setMaxRuntime(api.runtime)` and `api.registerChannel({ plugin: maxPlugin })`, matching the ADR-006 5-file pattern exactly.

---

### 2. Bot token storage is secure (not in git)

**Status: PASS**

Tokens are resolved through three sources in priority order: (1) `MAX_BOT_TOKEN` environment variable (default account only), (2) `botToken` in config, (3) fallback to `"none"`. The `logoutAccount` implementation properly deletes `botToken` from config and writes the cleaned config. Token values never appear in meta, descriptions, or log output.

**Note:** See Gap G-01 below regarding `tokenFile` resolution not being implemented.

---

### 3. Webhook endpoint planned

**Status: PASS**

The `MaxAccountConfig` type includes `webhookUrl`, `webhookSecret`, and `webhookPath`. The `gateway.startAccount` passes these to `monitorMaxProvider`. The config schema validates `webhookUrl` with `z.string().url().optional()`.

---

### 4. Rate limiting configuration present

**Status: PASS (delegated)**

Rate limiting is delegated to the runtime layer as specified in ADR-006 ("The extension contains zero direct HTTP calls"). The ADR documents MAX's 30 rps limit and the platform's `rate-limiter.ts` already documents `max: 20 rps, burstSize: 20`. The extension correctly delegates all outbound calls to `runtime.channel.max.sendMessageMax`, where rate limiting will be enforced.

---

### 5. Message formatting (markdown) configured

**Status: PASS**

`outbound.sendText` and `outbound.sendMedia` both pass `format: "markdown"` to the runtime `sendMessageMax` call. The config schema supports `format: z.enum(["markdown", "html"]).optional()`. The chunker is `"markdown"` mode using `runtime.channel.text.chunkMarkdownText`. The `textChunkLimit` is set to `4000`, consistent with Telegram and the ADR's conservative approach.

---

### 6. Inline keyboards referenced (callback support)

**Status: PASS (partial, delegated)**

The `actions` section is implemented via `maxMessageActions` which delegates `listActions`, `supportsAction`, and `handleAction` to `runtime.channel.max.messageActions`. ADR-006 documents inline keyboard support (210 buttons max, 30 rows, 7 per row, callback/link/request_contact/request_geo_location/open_app/message button types). However, the actual keyboard rendering and callback handling is in the runtime, not the extension, which is architecturally correct.

**See Gap G-02 below** regarding the missing `extractToolSend` method.

---

### 7. Group chat support (bot_added, bot_removed events)

**Status: PASS (partial)**

`capabilities.chatTypes` includes `"group"`. The `security.collectWarnings` handles `groupPolicy="open"`. ADR-006 Section 6 documents the full event mapping: `bot_added` -> GroupJoined, `bot_removed` -> GroupLeft, `user_added` -> MemberAdded, `user_removed` -> MemberRemoved. These events are handled at the runtime layer.

**See Gap G-03 below** regarding the missing `groups` section.

---

### 8. Error messages approach defined

**Status: PASS (delegated)**

Error handling follows the pattern of throwing descriptive `Error` objects when runtime methods are unavailable (e.g., `"MAX runtime sendMessageMax not available"`, `"MAX token not configured"`, `"MAX message actions not available"`). The `status.collectStatusIssues` surfaces runtime errors. Detailed error taxonomy (MaxApiError, retry vs no-retry classification) is deferred to the runtime as noted in CG-03 of the requirements validation.

---

### 9. Long Polling support referenced

**Status: PASS**

The `status.buildAccountSnapshot` determines mode via `runtime?.mode ?? (account.config.webhookUrl ? "webhook" : "polling")`, defaulting to polling when no webhook is configured. The `gateway.startAccount` passes `useWebhook: Boolean(account.config.webhookUrl)` to `monitorMaxProvider`. ADR-006 Section 4 documents `GET /updates?limit=100&timeout=30` for long polling.

---

### 10. Webhook support referenced

**Status: PASS**

`webhookUrl`, `webhookSecret`, and `webhookPath` are all part of the config type, config schema, and are passed through `gateway.startAccount` to `monitorMaxProvider`. ADR-006 documents `POST /subscriptions` for webhook setup.

---

### 11. Account probe (GET /me) delegates to runtime

**Status: PASS**

`status.probeAccount` calls `getMaxRuntime().channel.max.probeMax(account.token, timeoutMs, account.config.proxy)`. The `MaxProbe` type defines `{ ok: boolean; bot?: { id: number; name: string; username: string }; error?: string }` matching the `GET /me` response shape. The probe is also used in `gateway.startAccount` to log the bot username on startup.

---

### 12. Graceful shutdown (logoutAccount) implemented

**Status: PASS**

`gateway.logoutAccount` is fully implemented. It:

- Checks for environment token (`MAX_BOT_TOKEN`)
- Removes `botToken` from default account or named account config
- Cleans up empty `accounts` records and empty `max` sections
- Writes updated config via `getMaxRuntime().config.writeConfigFile`
- Re-resolves the account to confirm logout status
- Returns `{ cleared, envToken, loggedOut }` matching the Telegram pattern exactly

---

### 13. All ChannelPlugin sections present

| Section          | Present | Notes                                                                                                  |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| **meta**         | YES     | Locally defined (MAX not yet in CHAT_CHANNEL_ORDER)                                                    |
| **capabilities** | YES     | `["direct", "group"]`, media, nativeCommands, blockStreaming                                           |
| **pairing**      | YES     | `idLabel: "maxUserId"`, normalizeAllowEntry, notifyApproval                                            |
| **config**       | YES     | Full CRUD: list, resolve, default, setEnabled, delete, isConfigured, describe, allowFrom               |
| **configSchema** | YES     | Via `buildChannelConfigSchema(MaxConfigSchema)`                                                        |
| **security**     | YES     | `resolveDmPolicy` and `collectWarnings`                                                                |
| **groups**       | **NO**  | **Gap G-03**                                                                                           |
| **messaging**    | YES     | `normalizeTarget` and `targetResolver`                                                                 |
| **outbound**     | YES     | `sendText`, `sendMedia`, `chunker`, `textChunkLimit`, `deliveryMode`                                   |
| **status**       | YES     | `defaultRuntime`, `collectStatusIssues`, `buildChannelSummary`, `probeAccount`, `buildAccountSnapshot` |
| **setup**        | YES     | `resolveAccountId`, `applyAccountName`, `validateInput`, `applyAccountConfig`                          |
| **gateway**      | YES     | `startAccount` and `logoutAccount`                                                                     |
| **actions**      | YES     | `listActions`, `supportsAction`, `handleAction` (missing `extractToolSend`)                            |
| **reload**       | YES     | `configPrefixes: ["channels.max"]`                                                                     |
| **streaming**    | YES     | `blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 }`                                     |
| **onboarding**   | **NO**  | **Gap G-04**                                                                                           |
| **directory**    | **NO**  | **Gap G-05**                                                                                           |
| **threading**    | N/A     | Correct: MAX has no thread support per ADR-006                                                         |

**Sections present: 14/17 applicable** (82% coverage, up from 63% at validation time)

---

### 14. Types are properly defined (no `any`)

**Status: PASS**

All types in `types.ts` use explicit type definitions:

- `MaxProbe`: structured with `ok`, `bot?`, `error?`
- `MaxAccountConfig`: all 16 fields with specific types, using imported `DmPolicy`, `GroupPolicy`, `BlockStreamingCoalesceConfig`
- `MaxConfig`: extends `MaxAccountConfig` with `accounts` record
- `ResolvedMaxAccount`: explicit `tokenSource` union `"env" | "tokenFile" | "config" | "none"`

No usage of `any` found in any MAX extension file. The `channel.ts` uses `Record<string, unknown>` for dynamic config access, which is the correct pattern (matching Telegram).

---

### 15. Config schema covers all documented fields

**Status: PASS**

The `MaxConfigSchema` (via `MaxAccountSchemaBase`) covers:

| ADR-006 field | Schema field                      | Status |
| ------------- | --------------------------------- | ------ |
| token         | `botToken`                        | YES    |
| enabled       | `enabled`                         | YES    |
| webhookUrl    | `webhookUrl` (`.url()` validated) | YES    |
| webhookSecret | `webhookSecret`                   | YES    |
| webhookPath   | `webhookPath`                     | YES    |
| dmPolicy      | `dmPolicy` (DmPolicySchema)       | YES    |
| allowFrom     | `allowFrom` (string/number array) | YES    |
| proxy         | `proxy`                           | YES    |

Additional fields beyond ADR-006 (matching Telegram parity):

- `name`, `tokenFile`, `groupAllowFrom`, `groupPolicy`, `textChunkLimit`, `format`, `blockStreaming`, `blockStreamingCoalesce`

The `requireOpenAllowFrom` superRefine is applied at both account and top-level config, preventing `dmPolicy="open"` without `allowFrom: ["*"]`.

---

### 16. Account resolution follows platform pattern

**Status: PASS**

`resolveMaxAccount` follows the identical pattern to `resolveTelegramAccount`:

- Normalizes account ID via `normalizeAccountId`
- Merges base config with account-specific config
- Falls back to default account if explicit ID not provided and primary has no token
- Token resolution order: env -> config -> none
- `listMaxAccountIds` returns `[DEFAULT_ACCOUNT_ID]` if no accounts configured

---

### 17. Target normalization handles all MAX ID formats

**Status: PASS**

`normalizeMaxMessagingTarget` handles:

- Plain numerical IDs: `"12345"` -> `"12345"`
- Negative group IDs: `"-67890"` -> `"-67890"`
- Prefixed IDs (case-insensitive): `"max:12345"` -> `"12345"`, `"MAX:12345"` -> `"12345"`
- Empty/whitespace: returns `null`
- Non-numerical after strip: returns `null`

`looksLikeMaxTargetId` recognizes:

- Numerical IDs (positive and negative)
- `max:` prefixed IDs (case-insensitive)

This matches ADR-006 which describes MAX chat IDs as numerical (similar to Telegram).

---

### 18. Setup wizard validates input correctly

**Status: PASS**

`setup.validateInput` enforces:

- `useEnv` only allowed for `DEFAULT_ACCOUNT_ID` (prevents env token on named accounts)
- At least one of `token`, `tokenFile`, or `useEnv` must be provided
- Returns descriptive error messages

`setup.applyAccountConfig` correctly:

- Applies account name via `applyAccountNameToChannelSection`
- Migrates base name to default account for non-default IDs
- Sets `enabled: true`
- Stores token/tokenFile in correct config path (top-level for default, accounts path for named)

---

## Gaps Found

### G-01: `tokenFile` resolution not implemented in `resolveMaxToken`

**Severity: MEDIUM**

**Description:** The `MaxAccountConfig` type declares `tokenFile?: string`, the config schema includes `tokenFile: z.string().optional()`, and `setup.applyAccountConfig` writes `tokenFile` to config. However, `resolveMaxToken` in `accounts.ts` only checks (1) env variable and (2) `botToken` -- it never reads the token from the file path specified in `tokenFile`. The `ResolvedMaxAccount.tokenSource` type includes `"tokenFile"` as a valid value, but this source is never assigned.

**Impact:** Users who configure MAX with `--token-file` will have the path stored in config but the token will not be loaded, falling through to `source: "none"`. The bot will appear unconfigured.

**Resolution:** Add a step between env and config in `resolveMaxToken` that reads the file at `merged.tokenFile` (matching whatever pattern the platform SDK uses for Telegram). Estimated effort: 30 minutes.

---

### G-02: `extractToolSend` missing from message actions adapter

**Severity: LOW**

**Description:** The Telegram message actions adapter defines three methods: `listActions`, `extractToolSend`, and `handleAction`. The MAX adapter defines `listActions`, `supportsAction`, and `handleAction` but does not include `extractToolSend`. Instead, MAX has `supportsAction` which Telegram does not have.

**Impact:** If the platform expects `extractToolSend` for tool-based message sending (e.g., sending files via tool use), this capability will be unavailable on the MAX channel. The `supportsAction` method may be a valid alternative or addition, but parity with Telegram is incomplete.

**Resolution:** Add `extractToolSend` to the MAX message actions adapter, delegating to `runtime.channel.max.messageActions.extractToolSend`. Confirm whether `supportsAction` is an additional method or a replacement for some Telegram-side logic. Estimated effort: 15 minutes.

---

### G-03: `groups` section missing

**Severity: MEDIUM**

**Description:** The Telegram plugin includes a `groups` section with `resolveRequireMention` and `resolveToolPolicy`. The MAX plugin does not include this section despite `capabilities.chatTypes` declaring `"group"` support. ADR-006 documents bot_added/bot_removed group events and the security section handles `groupPolicy`, but there is no mechanism to configure per-group mention requirements or tool policies.

**Impact:** Group interactions will fall back to platform defaults. Operators cannot configure whether the bot requires an @mention in specific groups or restrict tool usage per group. This is functional but less configurable than Telegram.

**Resolution:** Add a `groups` section with `resolveRequireMention` and `resolveToolPolicy` methods, creating MAX-specific variants (e.g., `resolveMaxGroupRequireMention`, `resolveMaxGroupToolPolicy`) or reusing a generic implementation. Estimated effort: 1 hour.

---

### G-04: `onboarding` adapter missing

**Severity: MEDIUM**

**Description:** The Telegram plugin includes `onboarding: telegramOnboardingAdapter` which provides the CLI wizard integration for first-time setup. The MAX plugin has no `onboarding` section. While `setup` covers programmatic account configuration, `onboarding` typically provides the interactive wizard experience shown to new users.

**Impact:** Users setting up MAX for the first time via the CLI interactive wizard will not have a guided onboarding flow. They must use CLI flags directly or manually edit config.

**Resolution:** Create a `maxOnboardingAdapter` following the `telegramOnboardingAdapter` pattern. This should prompt for bot token (from dev.max.ru), validate via probe, and optionally configure webhook vs polling. Estimated effort: 2 hours.

---

### G-05: `directory` section missing

**Severity: LOW**

**Description:** The Telegram plugin includes a `directory` section with `self`, `listPeers`, and `listGroups` for providing a contact/group directory. The MAX plugin has no `directory` section.

**Impact:** The `/contacts` or directory-related commands will not show MAX peers or groups. This is a convenience feature, not a functional requirement.

**Resolution:** Add a `directory` section with stub implementations or config-based directory listing similar to `listTelegramDirectoryPeersFromConfig` / `listTelegramDirectoryGroupsFromConfig`. Estimated effort: 30 minutes.

---

### G-06: `status.auditAccount` not implemented

**Severity: LOW**

**Description:** The Telegram plugin includes an `auditAccount` method in the `status` section that verifies bot membership in configured groups (checking if the bot is actually a member, has proper permissions, etc.). The MAX plugin's `status` section has `probeAccount` and `buildAccountSnapshot` but no `auditAccount`.

**Impact:** The status command cannot verify that the MAX bot is properly added to configured groups. Operators must manually verify group membership.

**Resolution:** Add `auditAccount` that delegates to a runtime method for verifying MAX group membership. Can be deferred until group features are fully implemented. Estimated effort: 1 hour.

---

### G-07: Platform registration (`CHAT_CHANNEL_ORDER`) not yet done

**Severity: LOW**

**Description:** ADR-006 Section 3 specifies adding `"max"` to `CHAT_CHANNEL_ORDER` in `src/channels/registry.ts` after `"telegram"`. The `meta` in `channel.ts` includes a comment: "defined locally since MAX is not yet in CHAT_CHANNEL_ORDER". The `meta` object is defined with hardcoded values including `order: 15` rather than using `getChatChannelMeta("max")`.

**Impact:** MAX will not appear in channel selection lists that iterate `CHAT_CHANNEL_ORDER`. The extension works via plugin registration, but platform-level channel discovery may not find it. This is a known deferred item per the ADR.

**Resolution:** Add `"max"` to `CHAT_CHANNEL_ORDER` and switch `meta` from local definition to `getChatChannelMeta("max")`. This is explicitly planned for Milestone M7. Estimated effort: 15 minutes.

---

## Summary of Gaps

| ID   | Description                            | Severity   | Status from Requirements Validation |
| ---- | -------------------------------------- | ---------- | ----------------------------------- |
| G-01 | `tokenFile` resolution not implemented | **MEDIUM** | Not previously identified           |
| G-02 | `extractToolSend` missing from actions | **LOW**    | Not previously identified           |
| G-03 | `groups` section missing               | **MEDIUM** | MG-03 (known gap)                   |
| G-04 | `onboarding` adapter missing           | **MEDIUM** | MG-02 (known gap)                   |
| G-05 | `directory` section missing            | **LOW**    | LG-01 (known gap)                   |
| G-06 | `status.auditAccount` not implemented  | **LOW**    | Not previously identified           |
| G-07 | Platform registration deferred         | **LOW**    | Planned for M7                      |

### Previously Identified Gaps Now Resolved

| Validation ID | Description                         | Resolution                                                     |
| ------------- | ----------------------------------- | -------------------------------------------------------------- |
| CG-02         | `gateway.logoutAccount` not defined | **RESOLVED** -- fully implemented                              |
| MG-01         | `messaging` section missing         | **RESOLVED** -- `normalizeTarget` and `targetResolver` present |
| LG-02         | `actions` section missing           | **RESOLVED** -- `maxMessageActions` implemented                |
| LG-03         | `reload` section missing            | **RESOLVED** -- `configPrefixes: ["channels.max"]` present     |

### Gaps Not Addressable by Extension (Runtime Responsibility)

| Validation ID | Description                               | Responsibility |
| ------------- | ----------------------------------------- | -------------- |
| CG-01         | Webhook signature verification            | Runtime layer  |
| CG-03         | Error code mapping / MaxApiError taxonomy | Runtime layer  |
| MG-04         | Message deduplication                     | Runtime layer  |
| MG-05         | Reconnection strategy for polling         | Runtime layer  |
| LG-04         | Bot command registration                  | Runtime layer  |

---

## Structural Comparison: MAX vs Telegram

| Aspect              | Telegram                                         | MAX                                             | Match           |
| ------------------- | ------------------------------------------------ | ----------------------------------------------- | --------------- |
| File count          | 5 core files                                     | 7 files (5 core + types + normalize)            | OK (decomposed) |
| Plugin registration | `register(api)`                                  | `register(api)`                                 | Identical       |
| Runtime singleton   | `setTelegramRuntime` / `getTelegramRuntime`      | `setMaxRuntime` / `getMaxRuntime`               | Identical       |
| Config CRUD methods | 8 methods                                        | 8 methods                                       | Identical       |
| Security section    | `resolveDmPolicy` + `collectWarnings`            | `resolveDmPolicy` + `collectWarnings`           | Identical       |
| Outbound section    | `sendText`, `sendMedia`, chunker                 | `sendText`, `sendMedia`, chunker                | Identical       |
| Gateway section     | `startAccount` + `logoutAccount`                 | `startAccount` + `logoutAccount`                | Identical       |
| Status section      | 5 methods incl. `auditAccount`                   | 4 methods (no `auditAccount`)                   | Minor gap       |
| Setup section       | 4 methods                                        | 4 methods                                       | Identical       |
| Groups section      | `resolveRequireMention` + `resolveToolPolicy`    | Missing                                         | Gap             |
| Directory section   | `self`, `listPeers`, `listGroups`                | Missing                                         | Gap             |
| Onboarding section  | `telegramOnboardingAdapter`                      | Missing                                         | Gap             |
| Threading section   | `resolveReplyToMode`                             | N/A (no threads in MAX)                         | Correct         |
| Streaming section   | Not present in telegram channel.ts               | Present in MAX                                  | MAX has extra   |
| Actions             | `listActions`, `extractToolSend`, `handleAction` | `listActions`, `supportsAction`, `handleAction` | Slight mismatch |

---

## Final Verdict

### CONDITIONAL PASS

The MAX extension implementation is architecturally sound and follows the Telegram reference pattern with high fidelity. Of the 18 checklist items, 18 pass (some with caveats). The extension correctly delegates all HTTP communication to the runtime layer, implements the full config CRUD lifecycle, and covers the critical path: meta, capabilities, config, security, outbound messaging, gateway (start + logout), status/probing, setup, pairing, messaging normalization, actions, reload, and streaming.

**Conditions for full PASS:**

1. **G-01 (MEDIUM):** Implement `tokenFile` resolution in `resolveMaxToken` -- this is a functional bug where a documented and configurable feature does not work.
2. **G-03 (MEDIUM):** Add `groups` section for group mention/tool policy configuration.
3. **G-04 (MEDIUM):** Add `onboarding` adapter for interactive CLI wizard.

**Acceptable deferrals (LOW severity, can ship without):**

- G-02: `extractToolSend` (minor action adapter method)
- G-05: `directory` section (convenience feature)
- G-06: `auditAccount` (operational audit feature)
- G-07: Platform registration (explicitly planned for M7)

**No CRITICAL gaps found.** The 3 critical gaps from the requirements validation (CG-01: webhook verification, CG-02: logoutAccount, CG-03: error mapping) have been either resolved (CG-02) or correctly scoped to the runtime layer (CG-01, CG-03).
