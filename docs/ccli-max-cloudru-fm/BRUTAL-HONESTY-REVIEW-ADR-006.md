# Brutal Honesty Review: MAX Messenger Extension

## Overall Grade: B-

Solid structural work that correctly follows the established channel plugin pattern. The scaffolding is competent, the config schema is well-designed, and the multi-account architecture is properly implemented. However, there are real bugs, missing features compared to the reference implementations, dead code, type safety violations, and zero tests. This is not merge-ready without fixes.

---

## What's Good

1. **Pattern compliance is strong.** The 5-file structure (`package.json`, `openclaw.plugin.json`, `index.ts`, `src/runtime.ts`, `src/channel.ts`) matches telegram exactly. Good discipline.

2. **Config schema is well-designed.** `config-schema.ts` properly uses Zod with `superRefine` for the `requireOpenAllowFrom` validation on both the base and per-account levels. The `.strict()` on `MaxAccountSchemaBase` prevents unknown keys. This is actually better than some reference implementations.

3. **Multi-account resolution in `accounts.ts` is thorough.** The fallback logic (explicit ID -> primary -> default) handles edge cases well. The normalized account ID lookup with case-insensitive matching is a nice touch.

4. **Runtime delegation is correct.** Zero direct HTTP calls in the extension. All API communication goes through `getMaxRuntime().channel.max.*`. This is exactly right.

5. **The ADR is comprehensive.** It documents the API surface, webhook events, platform differences vs Telegram, and runtime contract. The DDD section with domain events and invariants is better than most ADRs I have seen in this codebase.

6. **Logout implementation is thorough.** The `logoutAccount` in `gateway` properly cleans up config, handles empty objects, and writes back. It follows the telegram pattern line-for-line.

---

## Critical Issues (must fix)

### C1. `normalizeMaxMessagingTarget` returns `null` but interface expects `undefined`

- **File:** `/home/user/openclaw/extensions/max/src/normalize.ts`, lines 28-43
- **Problem:** The `ChannelMessagingAdapter.normalizeTarget` type signature is `(raw: string) => string | undefined` (see `/home/user/openclaw/src/channels/plugins/types.core.ts`, line 261). The MAX implementation returns `string | null`. TypeScript may or may not catch this depending on strict null checks configuration, but it is a semantic contract violation. Any code that checks `=== undefined` to detect failure will break.
- **Impact:** Runtime bugs in target resolution. Code checking `result === undefined` will miss null returns.
- **Fix:** Change all `return null;` to `return undefined;` in `normalizeMaxMessagingTarget`, or update the return type annotation explicitly.

### C2. `tokenFile` is declared in config schema but never resolved

- **File:** `/home/user/openclaw/extensions/max/src/accounts.ts`, lines 68-88
- **Problem:** `MaxAccountConfig` declares `tokenFile?: string` and the config schema validates it, but `resolveMaxToken()` only checks: (1) `MAX_BOT_TOKEN` env var, (2) `merged.botToken`. It never reads the token file. Compare to the ADR which lists `tokenFile` as a valid input, and `setup.applyAccountConfig` which writes `tokenFile` to config. This means a user can configure `tokenFile`, the config will accept it, the setup wizard will write it, but the token will never be loaded. The account will appear as `tokenSource: "none"`.
- **Impact:** Silent failure. Users who configure tokenFile will get no error and no working bot.
- **Fix:** Add token file resolution between steps 1 and 2 in `resolveMaxToken()`. Look at how the platform SDK handles this (likely `runtime.config.readFile` or `fs.readFileSync`). Return `{ token, source: "tokenFile" }` when found.

### C3. `extractToolSend` missing from message actions adapter

- **File:** `/home/user/openclaw/extensions/max/src/channel.ts`, lines 74-86
- **Problem:** The `ChannelMessageActionAdapter` type (see `/home/user/openclaw/src/channels/plugins/types.core.ts`, line 319) defines `extractToolSend`. Telegram's implementation includes it (`extractToolSend: (ctx) => getTelegramRuntime().channel.telegram.messageActions?.extractToolSend?.(ctx) ?? null`). MAX's `maxMessageActions` omits it entirely. This means tool-send extraction will not work for MAX, which may break agent tool invocations that depend on this adapter method.
- **Impact:** Agent tool sends that route through MAX will fail or be silently dropped.
- **Fix:** Add `extractToolSend` to `maxMessageActions`:
  ```typescript
  extractToolSend: (ctx) =>
    getMaxRuntime().channel.max?.messageActions?.extractToolSend?.(ctx) ?? null,
  ```

### C4. `supportsAction` uses wrong fallback

- **File:** `/home/user/openclaw/extensions/max/src/channel.ts`, line 77
- **Problem:** `supportsAction` returns `false` as fallback when runtime is not available. But `supportsAction` in the platform is optional -- callers check if it exists before calling. Returning `false` is not a bug per se, but the real issue is that MAX declares `supportsAction` unconditionally while the runtime backing (`getMaxRuntime().channel.max?.messageActions?.supportsAction`) may not exist. If the runtime does not implement `supportsAction`, the MAX plugin will report that it does not support any action, which may suppress valid actions. Telegram does not implement `supportsAction` inline -- it delegates fully to the runtime.
- **Impact:** May silently suppress message actions that should be available.
- **Fix:** Either remove `supportsAction` from the adapter (let the runtime handle it) or ensure the runtime will always provide it.

---

## Medium Issues (should fix)

### M1. ADR says `getChatChannelMeta("max")` but implementation uses a hardcoded local `meta` object

- **File:** `/home/user/openclaw/extensions/max/src/channel.ts`, lines 29-41; ADR Section 2 table says `getChatChannelMeta("max")`
- **Problem:** The code comment on line 27-28 acknowledges this: "defined locally since MAX is not yet in CHAT_CHANNEL_ORDER." This means MAX will not appear in the platform's channel registry, channel ordering, or any UI that iterates `CHAT_CHANNEL_ORDER`. The ADR explicitly calls for adding `"max"` to `CHAT_CHANNEL_ORDER` in Section 3, but this has not been done.
- **Impact:** MAX will not appear in channel selection UIs, status displays that iterate registered channels, or any ordering-dependent logic. It registers as a plugin channel but is invisible to the registry.
- **Fix:** Add `"max"` to `CHAT_CHANNEL_ORDER` in `/home/user/openclaw/src/channels/registry.ts` and add corresponding metadata to `CHAT_CHANNEL_META`. Then switch to `getChatChannelMeta("max")`.

### M2. No `onboarding` adapter

- **File:** `/home/user/openclaw/extensions/max/src/channel.ts` (missing section)
- **Problem:** Both telegram and mattermost define an `onboarding` adapter. MAX does not. The `ChannelPlugin` type has `onboarding?: ChannelOnboardingAdapter`. Without it, the CLI setup wizard will not have MAX-specific onboarding prompts, and users will not get guided through bot creation on dev.max.ru.
- **Impact:** Poor first-run experience. Users must manually configure everything.
- **Fix:** Create a `maxOnboardingAdapter` similar to `telegramOnboardingAdapter` that guides users through the MAX bot setup flow.

### M3. No `groups` adapter despite declaring group support

- **File:** `/home/user/openclaw/extensions/max/src/channel.ts` (missing section)
- **Problem:** `capabilities.chatTypes` includes `"group"`, and the security section warns about `groupPolicy="open"`, but there is no `groups` section. Telegram defines `groups: { resolveRequireMention, resolveToolPolicy }`. Mattermost defines `groups: { resolveRequireMention }`. MAX has neither.
- **Impact:** Group mention requirements and tool policies cannot be configured per-group. The `groupPolicy` and `groupAllowFrom` config fields exist but group-level granularity is missing.
- **Fix:** Add a `groups` section with at least `resolveRequireMention`. If MAX groups support mentions (likely, since the security warning says "mention-gated"), this needs implementation.

### M4. No `directory` adapter

- **File:** `/home/user/openclaw/extensions/max/src/channel.ts` (missing section)
- **Problem:** Telegram defines `directory: { self, listPeers, listGroups }`. MAX has none. Without it, the agent cannot look up MAX users or groups by name, and `/contacts`-style commands will not work for MAX.
- **Impact:** No contact/group lookup capability.
- **Fix:** Add a stub `directory` adapter even if it returns empty results initially:
  ```typescript
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  ```

### M5. Unsafe `as` casts throughout `accounts.ts` and `channel.ts`

- **Files:** `/home/user/openclaw/extensions/max/src/accounts.ts` (lines 6-8, 39-40), `/home/user/openclaw/extensions/max/src/channel.ts` (lines 170-172, 344, 357-358, 429-430, 475-478)
- **Problem:** Heavy use of `as Record<string, unknown>` to access `cfg.channels.max`. Telegram's implementation uses `cfg.channels?.telegram?.accounts?.[resolvedAccountId]` with safe optional chaining because `cfg.channels` is properly typed to include `telegram`. MAX cannot do this because it is not in the registry, so it must cast. This is a consequence of M1, but it creates a secondary problem: any typo in these casts (e.g., accessing `cfg.channels.maxx`) will silently return undefined instead of failing at compile time.
- **Impact:** No compile-time safety for config access paths. Refactoring risk.
- **Fix:** Once MAX is in the registry (M1), use typed access. Until then, extract a single typed helper function that does the cast once and use it everywhere.

### M6. `normalizeAllowEntry` and `formatAllowEntry` are nearly identical

- **File:** `/home/user/openclaw/extensions/max/src/channel.ts`, lines 47-60
- **Problem:** `normalizeAllowEntry` does `.trim().replace(/^max:/i, "").toLowerCase()`. `formatAllowEntry` does `.trim().replace(/^max:/i, "").toLowerCase()`. They are functionally identical. One should call the other, or they should be merged.
- **Impact:** Maintenance burden. If normalization logic changes, both must be updated.
- **Fix:** Have `formatAllowEntry` call `normalizeAllowEntry`, or delete `formatAllowEntry` and use `normalizeAllowEntry` directly.

### M7. `sendText` and `sendMedia` ignore `deps` parameter

- **File:** `/home/user/openclaw/extensions/max/src/channel.ts`, lines 213, 228
- **Problem:** The `ChannelOutboundContext` includes `deps?: OutboundSendDeps` which allows callers to inject a custom send function (useful for testing and for cross-channel sends). Telegram's `sendText` uses `deps?.sendTelegram ?? getTelegramRuntime()...` as a fallback chain. MAX ignores `deps` entirely and always uses the runtime.
- **Impact:** Cannot inject custom send functions for testing or cross-channel scenarios.
- **Fix:** Follow the telegram pattern:
  ```typescript
  const send = deps?.sendMax ?? getMaxRuntime().channel.max?.sendMessageMax ?? (() => { throw ... });
  ```

---

## Low Issues (nice to fix)

### L1. `package.json` version `2026.2.16` is unusual

- **File:** `/home/user/openclaw/extensions/max/package.json`, line 3
- **Problem:** Using a date-based version `2026.2.16` instead of semver. This may not be a problem if it is the project convention, but it differs from standard npm semver expectations. If the project uses calendar versioning, this is fine; if not, it should be `0.1.0` or `1.0.0`.
- **Impact:** Minor. Package managers handle it fine.

### L2. `openclaw.plugin.json` has empty `configSchema.properties`

- **File:** `/home/user/openclaw/extensions/max/openclaw.plugin.json`, line 7
- **Problem:** The plugin-level config schema has empty properties `{}`. The actual config schema is defined in `config-schema.ts` and registered via `buildChannelConfigSchema(MaxConfigSchema)` on the channel plugin. The `openclaw.plugin.json` schema is redundant / vestigial.
- **Impact:** Cosmetic. No runtime effect since channel config is handled by the plugin code.

### L3. `streaming` section has no `blockStreamingCoalesceDefaults` documentation

- **File:** `/home/user/openclaw/extensions/max/src/channel.ts`, line 125
- **Problem:** The values `{ minChars: 1500, idleMs: 1000 }` match mattermost but there is no comment explaining why these values were chosen for MAX. Telegram does not define this section (it uses platform defaults).
- **Impact:** Future maintainers will not know if these values are intentional or cargo-culted.
- **Fix:** Add a comment explaining the rationale (MAX message delivery latency, API rate limits, etc.).

### L4. `MaxProbe` type has `bot?.id` as `number` but MAX API may use strings

- **File:** `/home/user/openclaw/extensions/max/src/types.ts`, lines 6-14
- **Problem:** The ADR says MAX bot IDs are numerical, but the `MaxProbe` type hardcodes `id: number`. If the MAX API ever returns string IDs (e.g., for future compatibility), this will break. Telegram uses `number` too, so this follows the pattern, but it is worth noting.
- **Impact:** Low. Only matters if MAX API changes.

### L5. `resolveMaxToken` does not support per-account env vars

- **File:** `/home/user/openclaw/extensions/max/src/accounts.ts`, lines 74-78
- **Problem:** Only `MAX_BOT_TOKEN` is checked, and only for the default account. There is no support for `MAX_BOT_TOKEN_<ACCOUNT_ID>` pattern. This is consistent with telegram (which only checks `TELEGRAM_BOT_TOKEN` for default), but limits multi-account users who prefer env vars over config files.
- **Impact:** Low. Multi-account users must use config-based tokens.

### L6. `probeAccount` passes `account.config.proxy` but the type says `timeoutMs` second arg

- **File:** `/home/user/openclaw/extensions/max/src/channel.ts`, line 287
- **Problem:** `probe(account.token, timeoutMs, account.config.proxy)` -- the third argument `proxy` is passed to the runtime's `probeMax`. The ADR's runtime contract shows `probeMax(token: string, timeoutMs: number)` with only two arguments. Either the ADR is outdated or the implementation added proxy support that is not documented.
- **Impact:** Low. The runtime will either use or ignore the third arg.

---

## Pattern Compliance

### Telegram pattern adherence

| Section | Telegram | MAX | Status |
|---------|----------|-----|--------|
| `meta` | `getChatChannelMeta("telegram")` | Hardcoded local object | DEVIATION (justified by comment, needs fix) |
| `onboarding` | `telegramOnboardingAdapter` | Missing | MISSING |
| `pairing` | Present | Present | OK |
| `capabilities` | 5 capabilities | 4 capabilities (no threads) | OK (intentional) |
| `streaming` | Not defined | Defined | ADDITION (ok, matches mattermost) |
| `reload` | Present | Present | OK |
| `configSchema` | Present | Present | OK |
| `config` | Present | Present | OK |
| `security` | Present | Present | OK |
| `groups` | Present | Missing | MISSING |
| `threading` | Present | Missing | OK (no thread support declared) |
| `messaging` | Present | Present | OK |
| `directory` | Present | Missing | MISSING |
| `actions` | Present (with `extractToolSend`) | Present (without `extractToolSend`) | INCOMPLETE |
| `outbound` | Present (with `deps`) | Present (without `deps`) | INCOMPLETE |
| `status` | Present (with `auditAccount`) | Present (without `auditAccount`) | ACCEPTABLE (audit is Telegram-specific) |
| `setup` | Present | Present | OK |
| `gateway` | Present | Present | OK |

### Mattermost pattern adherence

| Aspect | Mattermost | MAX | Status |
|--------|------------|-----|--------|
| Local `meta` object | Yes | Yes | OK |
| `streaming.blockStreamingCoalesceDefaults` | Yes | Yes | OK |
| `groups.resolveRequireMention` | Yes | Missing | MISSING |

### Deviations requiring justification

1. No `onboarding` -- Needs justification or implementation
2. No `groups` -- Unjustified given that group support is declared
3. No `directory` -- Acceptable for v1 if documented as planned
4. No `auditAccount` -- Acceptable; Telegram uses it for group membership audit which may not apply to MAX

---

## Type Safety

### `any` types

- **`index.ts` line 13:** `maxPlugin as ChannelPlugin` -- the cast erases the generic type parameters `<ResolvedMaxAccount, MaxProbe>`. This is the same pattern as telegram (`telegramPlugin as ChannelPlugin`), so it follows convention, but it means the platform loses type-level knowledge of the account/probe types. Not fixable without platform changes.

### Unsafe casts

- **`accounts.ts` lines 6-8:** `(cfg.channels as Record<string, unknown> | undefined)?.max as { accounts?: Record<string, unknown> } | undefined` -- Double cast through `Record<string, unknown>`. Fragile.
- **`accounts.ts` line 40:** Same pattern for `getMaxChannelConfig`.
- **`channel.ts` lines 170-172:** Same pattern in `resolveDmPolicy`.
- **`channel.ts` lines 344, 357-358, 370, 429-430:** Same pattern in `applyAccountConfig` and `logoutAccount`.
- **Count: 8+ unsafe casts.** All stem from MAX not being in the typed registry.

### Missing type guards

- **`channel.ts` line 287:** `probe(account.token, timeoutMs, account.config.proxy)` -- no guard that `probe` function accepts 3 arguments.
- **`channel.ts` line 299:** `runtime?.mode ?? (account.config.webhookUrl ? "webhook" : "polling")` -- `mode` is not typed on `ChannelAccountSnapshot` in a way that guarantees these string values.

---

## Security

### Token handling

- **GOOD:** Token is not logged anywhere in the extension code.
- **GOOD:** `resolveMaxToken` prefers env var over config for default account.
- **BAD:** `tokenFile` resolution is not implemented (C2). A user thinking their token is loaded from a file has no token loaded at all.
- **BAD:** In `logoutAccount`, the code does `delete nextEntry.botToken` but does not delete `tokenFile` entries. A logout should clear both `botToken` and `tokenFile`.

### Config safety

- **GOOD:** Zod schema uses `.strict()` to reject unknown fields.
- **GOOD:** `requireOpenAllowFrom` enforces that `dmPolicy="open"` requires `allowFrom` to include `"*"`.

### Webhook verification

- **UNCERTAIN:** The extension passes `webhookSecret` to the runtime's `monitorMaxProvider` but there is no verification logic in the extension itself (correct -- this should be in the runtime). However, the ADR notes "Webhook signature verification format for MAX is not fully documented (research risk)." This is an open risk that should be tracked.

---

## Missing Tests

There are **zero test files** in the MAX extension. For comparison, telegram also has zero test files in the extension directory (tests are in the platform core), but MAX has testable pure functions that should be unit tested:

### Unit tests needed

1. **`normalize.ts`**: `looksLikeMaxTargetId` and `normalizeMaxMessagingTarget`
   - Edge cases: empty string, whitespace, negative IDs, `max:` prefix, `MAX:` prefix, `max:` with no ID, non-numeric strings
   - This is a pure function with no dependencies -- trivial to test

2. **`accounts.ts`**: `listMaxAccountIds`, `resolveMaxAccount`, `resolveMaxToken`
   - Multi-account resolution logic
   - Token priority (env > config > none)
   - Fallback account selection
   - Disabled account handling

3. **`config-schema.ts`**: `MaxConfigSchema` validation
   - Valid configs parse correctly
   - Invalid configs (e.g., `dmPolicy="open"` without `allowFrom: ["*"]`) are rejected
   - Unknown fields are rejected (`.strict()`)

4. **`channel.ts`**: `normalizeAllowEntry`, `formatAllowEntry`, `parseReplyToMessageId`
   - Pure helper functions

### Integration tests needed

1. **`setup.applyAccountConfig`**: Verify config mutations are correct for default and non-default accounts
2. **`gateway.logoutAccount`**: Verify token cleanup for various account configurations
3. **`security.resolveDmPolicy`**: Verify policy resolution with various config shapes

---

## Missing Sections (vs Telegram)

### Detailed comparison of telegram `channel.ts` sections to MAX `channel.ts`

| Telegram Section | MAX Equivalent | Analysis |
|-----------------|----------------|----------|
| `id: "telegram"` | `id: "max"` | Present |
| `meta: { ...meta, quickstartAllowFrom: true }` | `meta: { ...meta }` | Present. Note: `quickstartAllowFrom` is inside the local meta object for MAX, not spread separately. Functionally equivalent. |
| `onboarding: telegramOnboardingAdapter` | **MISSING** | No onboarding wizard for MAX |
| `pairing.idLabel` | Present | OK |
| `pairing.normalizeAllowEntry` | Present | OK |
| `pairing.notifyApproval` | Present | OK, but uses different runtime delegation pattern (optional chaining with fallback throw) |
| `capabilities.chatTypes` | `["direct", "group"]` vs `["direct", "group", "channel", "thread"]` | OK -- intentionally fewer (MAX has no channels/threads) |
| `capabilities.reactions` | **MISSING** | Telegram has `reactions: true`. MAX does not declare it. If MAX supports reactions, this should be added. |
| `capabilities.threads` | **MISSING** | OK -- MAX does not support threads |
| `capabilities.media` | Present | OK |
| `capabilities.nativeCommands` | Present | OK |
| `capabilities.blockStreaming` | Present | OK |
| `streaming` | Present (MAX adds it, telegram does not have it) | OK -- follows mattermost pattern |
| `reload` | Present | OK |
| `configSchema` | Present | OK |
| `config.listAccountIds` | Present | OK |
| `config.resolveAccount` | Present | OK |
| `config.defaultAccountId` | Present | OK |
| `config.setAccountEnabled` | Present | OK |
| `config.deleteAccount` | Present | OK |
| `config.isConfigured` | Present | OK |
| `config.describeAccount` | Present | OK |
| `config.resolveAllowFrom` | Present | OK |
| `config.formatAllowFrom` | Present | OK |
| `security.resolveDmPolicy` | Present | OK |
| `security.collectWarnings` | Present | OK, but simpler (no group allowlist check like telegram) |
| `groups.resolveRequireMention` | **MISSING** | Should be present given group support |
| `groups.resolveToolPolicy` | **MISSING** | Telegram-specific, acceptable to omit |
| `threading.resolveReplyToMode` | **MISSING** | OK -- MAX has no thread support |
| `messaging.normalizeTarget` | Present | Has return type bug (C1) |
| `messaging.targetResolver` | Present | OK |
| `directory.self` | **MISSING** | No directory support |
| `directory.listPeers` | **MISSING** | No directory support |
| `directory.listGroups` | **MISSING** | No directory support |
| `actions.listActions` | Present | OK |
| `actions.extractToolSend` | **MISSING** | Should be present (C3) |
| `actions.supportsAction` | Present (MAX adds it, telegram does not) | Questionable addition (C4) |
| `actions.handleAction` | Present | OK |
| `outbound.deliveryMode` | Present | OK |
| `outbound.chunker` | Present | OK |
| `outbound.chunkerMode` | Present | OK |
| `outbound.textChunkLimit` | Present | OK |
| `outbound.sendText` (with deps) | Present (WITHOUT deps) | Incomplete (M7) |
| `outbound.sendMedia` (with deps) | Present (WITHOUT deps) | Incomplete (M7) |
| `outbound.sendText` (with threadId) | **threadId ignored** | OK -- MAX has no threads |
| `status.defaultRuntime` | Present | OK |
| `status.collectStatusIssues` | Present (inline) | OK -- telegram uses `collectTelegramStatusIssues` from SDK |
| `status.buildChannelSummary` | Present | OK |
| `status.probeAccount` | Present | OK |
| `status.auditAccount` | **MISSING** | Acceptable -- Telegram-specific feature for group membership audit |
| `status.buildAccountSnapshot` | Present | OK |
| `setup.resolveAccountId` | Present | OK |
| `setup.applyAccountName` | Present | OK |
| `setup.validateInput` | Present | OK |
| `setup.applyAccountConfig` | Present | OK |
| `gateway.startAccount` | Present | OK |
| `gateway.logoutAccount` | Present | OK |

**Summary:** 7 sections missing, 2 sections incomplete, 1 return type bug.

---

## ADR vs Implementation Gaps

| ADR Claim | Implementation Reality |
|-----------|----------------------|
| "getChatChannelMeta('max')" | Hardcoded local meta object (MAX not in registry) |
| "Add 'max' to CHAT_CHANNEL_ORDER" | Not done |
| "tokenFile" as valid token source | Schema accepts it, resolution ignores it |
| "Webhook events to handle" table | All delegation to runtime (correct, but runtime contract unverified) |
| "runtime.channel.max interface" | Used via optional chaining with fallback throws (matches pattern) |
| "probeMax(token, timeoutMs)" (2 args) | Called with 3 args including proxy |

---

## Verdict

- **Ready for merge:** CONDITIONAL
- **Blocking issues:** 4 (C1-C4)
- **Medium issues:** 7 (M1-M7)
- **Low issues:** 6 (L1-L6)
- **Estimated fix effort:** 2-3 days for blocking + medium issues; 1 day for low issues

### Conditions for merge

1. Fix all 4 critical issues (C1-C4)
2. Fix M1 (registry integration) -- without this, MAX is a ghost channel
3. Fix M3 (groups adapter) -- without this, group support is declared but non-functional
4. Fix M5 (reduce unsafe casts) -- as a consequence of M1
5. Add at least unit tests for `normalize.ts` and `accounts.ts` pure functions

### What can be deferred to a fast-follow PR

- M2 (onboarding adapter)
- M4 (directory adapter)
- M6 (dedup allow entry functions)
- M7 (deps injection)
- All low issues
