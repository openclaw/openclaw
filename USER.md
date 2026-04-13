WORK LOG

Add your findings and worklogs by appending to the end of this file. Do not overwrite anything that is existing in this file. Write with the format being used.

[CODEX]

I've brought work into the workstream.

[CLAUDE]

I've assigned the work to eleqtrizit.

[CODEX SECURITY FIXER]

Issue `NVIDIA-dev/openclaw-tracking#422` maps to `GHSA-hwmr-gqmh-2j2x`. Scope decision: out of scope as a security vulnerability under `SECURITY.md` because the report does not demonstrate an owner-only, approval, sandbox, or auth-boundary bypass; it is a hardening-class allowlist consistency gap.

Compatibility decision: proceed with a narrow hardening patch only. I did not implement the advisory's proposed default-deny behavior for empty `allowFrom`, because that would change Slack's current permissive default. I tightened only the channel interactive path so configured global `allowFrom` now applies there too, while preserving channel `users` allowlists as an alternate authorization path and keeping the no-allowlist path open.

Work completed:

- Branch: `fix/slack-interaction-auth-hardening`
- Commit: `b34f1c1bfd` (`fix(slack): align interaction auth with allowlists`)
- PR: https://github.com/openclaw/openclaw/pull/66028
- Tracking issue comment: https://github.com/NVIDIA-dev/openclaw-tracking/issues/422#issuecomment-4237722531

Validation:

- `pnpm test extensions/slack/src/monitor/auth.test.ts`
- `pnpm test extensions/slack/src/monitor/events/interactions.test.ts`
- `claude -p "/review"` run twice; follow-up auth unit coverage was added in response
- `pnpm check` still fails on unrelated pre-existing type errors outside the Slack surface (Discord, Feishu, Nextcloud Talk, WhatsApp, cron, wizard), so I did not widen scope into unrelated fixes

[CLAUDE REVIEW]

Reviewer: Claude Opus 4.6 (1M context)
Date: 2026-04-13
Branch: `fix/slack-interaction-auth-hardening`
Commit: `b34f1c1bfd` (`fix(slack): align interaction auth with allowlists`)
Tracking issue: NVIDIA-dev/openclaw-tracking#422 (GHSA-hwmr-gqmh-2j2x, CWE-863 Incorrect Authorization, Medium severity)

## Goal of the Changes

The branch addresses a security hardening gap (GHSA-hwmr-gqmh-2j2x) where Slack interactive events (block actions like button clicks on bot messages in channels) bypassed the global `allowFrom` authorization list. Prior to this fix, `authorizeSlackSystemEventSender` only checked per-channel `users` allowlists in the channel code path. This meant that if an operator configured a global `allowFrom` list (e.g. `["U_OWNER"]`) to restrict who can interact with the bot, any Slack workspace member could still trigger block actions in channels because the channel branch never consulted that global list.

The fix makes the channel interactive auth path consult the global `allowFrom` first, so owners on that list are always authorized, and when a global allowFrom is configured but no channel-level `users` list exists, unauthorized senders are denied. A new composite denial reason `"sender-not-authorized"` is introduced for the case where a sender fails both the global and channel-level checks.

Separately, the branch simplifies the inbound message deduplication logic by removing the three-phase claim/commit/release pattern in favor of a simpler `shouldSkipDuplicateInbound` check, and consolidates cron runtime re-exports to use the `config/sessions.js` barrel instead of individual submodule paths.

## Scope vs. Advisory

The advisory (GHSA-hwmr-gqmh-2j2x) describes four bypass vectors in its PoC:

1. No channel context + empty `allowFrom` = anyone authorized (app_home block actions)
2. Channel-level check only applies per-channel users, not global `allowFrom`
3. `expectedSenderId` is optional and never set for block actions
4. Channel type fallback can bypass DM-specific authorization

**This fix addresses bypass #2 only.** The work log explicitly states this is intentional — a narrow hardening patch that does not change the current permissive default behavior for empty `allowFrom`. Bypasses #1, #3, and #4 remain as-is. This is a reasonable scoping decision: changing the default to deny-when-empty would be a breaking behavioral change, and the advisory itself is classified as hardening-class, not a true auth boundary bypass per the project's `SECURITY.md`.

## Authorization Logic Review (`extensions/slack/src/monitor/auth.ts`)

The new channel auth flow (lines 253-303) follows this priority:

1. Resolve global `allowFrom` (without pairing store — correct for non-DM contexts).
2. If sender matches global `allowFrom` → **allow immediately** (owner always passes).
3. If channel has a `users` allowlist and sender matches it → **allow**.
4. If channel has a `users` allowlist and sender does NOT match → **deny** with `"sender-not-authorized"` (if global allowlist also configured) or `"sender-not-channel-allowed"` (if only channel allowlist).
5. If no channel `users` allowlist but global `allowFrom` is configured → **deny** with `"sender-not-allowlisted"`.
6. If neither allowlist is configured → **allow** (permissive default preserved).

This priority ordering is correct and well-structured. Global owner authorization takes precedence, channel-level is an alternative authorization path, and the fallback to open when no allowlists are configured preserves backward compatibility.

The new `"sender-not-authorized"` reason code is a good addition to the discriminated union — it disambiguates the combined-denial case from the single-source denial cases for logging and debugging.

## Test Coverage Review

### `extensions/slack/src/monitor/auth.test.ts`

Five new test cases for `authorizeSlackSystemEventSender` covering:

- Sender blocked when outside global `allowFrom` (channel context)
- Sender allowed via global `allowFrom` even when channel `users` are configured
- Combined denial when sender matches neither global nor channel allowlists
- Sender allowed via channel `users` even when not in global `allowFrom`
- Open access when no allowlists are configured

These tests cover the key authorization matrix well. The `makeAuthorizeCtx` helper is well-constructed and properly sets `channelsConfigKeys` from the config input.

### `extensions/slack/src/monitor/events/interactions.test.ts`

Two new integration-level tests:

- Blocks channel block actions when sender is outside global `allowFrom` — verifies `ack()` is called, `enqueueSystemEvent` is NOT called, and an ephemeral unauthorized message is sent via `respond()`.
- Allows channel block actions when channel `users` allowlist authorizes the sender — verifies the action is processed and the message is updated.

These tests validate the end-to-end flow through the actual interaction handler.

## Issues and Observations

### 1. Missing `channelsConfigKeys` in interactions test helper (minor inconsistency)

The `createContext` helper in `interactions.test.ts` (line 143) sets `channelsConfig` but does not set `channelsConfigKeys`. The `makeAuthorizeCtx` helper in `auth.test.ts` does set it:

```typescript
channelsConfigKeys: Object.keys(params?.channelsConfig ?? {}),
```

This works at runtime because `resolveSlackChannelConfig` (in `channel-config.ts:105`) falls back to `Object.keys(entries)` when `channelKeys` is undefined. However, it's an inconsistency between the two test helpers, and means the interactions tests are exercising a fallback path rather than the production path where `channelsConfigKeys` would typically be set on the context.

**Impact:** Low — tests still exercise the correct authorization logic. The channel config resolution produces the same result either way.

### 2. Inbound dedupe simplification removes failure-recovery semantics (semantic change)

The old three-phase pattern (`claimInboundDedupe` → process → `commitInboundDedupe`/`releaseInboundDedupe`) provided a safety net: if dispatch failed, the claim was released, allowing a retry of the same message. The new `shouldSkipDuplicateInbound` calls `cache.check()` which atomically marks the key as seen. If dispatch subsequently fails, the dedupe slot is "burned" for the TTL window (20 minutes by default) — retries of that message will be dropped as duplicates.

The removed test (`"releases inbound dedupe when dispatch fails before completion"`) directly covered this retry-after-failure semantic. Its removal confirms this is an intentional simplification.

**Impact:** Medium. If a message dispatch fails (e.g., transient provider error), the same inbound message ID cannot be retried for 20 minutes. Whether this matters depends on how message retries reach the system. If upstream providers re-deliver with a new `MessageSid`, this is a non-issue. If they re-deliver with the same ID (as Twilio/WhatsApp do), failed messages will be silently dropped until TTL expires. This is a trade-off that should be documented or validated against the retry behavior of each channel provider.

### 3. Commit bundles unrelated changes (process)

A single commit (`b34f1c1bfd`) contains three logically independent changes:

- Slack auth hardening (the stated purpose)
- Inbound dedupe simplification (unrelated to Slack auth)
- Cron runtime import consolidation (unrelated to both)

The commit message (`fix(slack): align interaction auth with allowlists`) only describes the Slack change. Per repo guidelines ("Group related changes; avoid bundling unrelated refactors"), the dedupe simplification and cron import cleanup would ideally be separate commits. The dedupe change in particular alters runtime semantics beyond the Slack surface.

### 4. No negative test for bypass #1 (app_home / no-channel-context) in interactions tests

The auth.test.ts unit tests don't cover the no-channel-context path for `authorizeSlackSystemEventSender` under the new logic. While this path was not changed (it was already present), the advisory specifically calls it out. A test asserting the current (permissive) behavior when `channelId` is absent and `allowFrom` is empty would serve as a regression anchor if the default-deny behavior is ever adopted.

### 5. Import path consolidation in cron runtime is correct

The `src/config/sessions.ts` barrel re-exports from `sessions/paths.js`, `sessions/types.js`, and all other submodules. The cron runtime files (`run-execution.runtime.ts`, `run.runtime.ts`) previously imported from the submodule paths directly. Consolidating to the barrel is valid — all four symbols (`resolveAgentMainSessionKey`, `resolveSessionTranscriptPath`, `setSessionRuntimeModel`, `updateSessionStore`) are available through the barrel. This is a minor cleanup consistent with repo conventions.

## Standards and Best Practices Assessment

| Criterion                             | Verdict           | Notes                                                                            |
| ------------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| Addresses the stated security gap     | Yes               | Channel block actions now consult global `allowFrom`                             |
| Narrow, backward-compatible scope     | Yes               | Permissive default preserved; no breaking changes                                |
| Discriminated union for error reasons | Good              | `"sender-not-authorized"` is a proper closed-code addition                       |
| Test coverage for new auth logic      | Good              | 5 unit + 2 integration tests covering the authorization matrix                   |
| Extension boundary compliance         | Yes               | Changes stay within `extensions/slack/` for auth; core changes are to core files |
| Import boundary compliance            | Yes               | No cross-boundary violations                                                     |
| Commit hygiene                        | Needs improvement | Unrelated changes bundled in one commit                                          |
| Semantic change documentation         | Needs improvement | Dedupe simplification's retry impact not documented                              |
| TypeScript strict typing              | Good              | No `any` usage; proper typed parameters throughout                               |
| Coding style                          | Good              | Clean, concise, follows existing patterns                                        |

## Summary

The primary Slack auth hardening change is well-implemented, correctly prioritized, and thoroughly tested. It addresses the most impactful bypass vector from the advisory while preserving backward compatibility. The authorization priority chain (owner > channel users > deny/open) is sound.

The main concerns are: (1) the inbound dedupe simplification is a non-trivial semantic change that removes failure-recovery semantics and is bundled into an unrelated security fix commit without its own documentation or rationale, and (2) the `channelsConfigKeys` inconsistency between test helpers, though functionally harmless. Neither concern blocks the Slack auth fix itself, but the dedupe change deserves its own commit and a note about the retry-behavior trade-off.

[CLAUDE PLAN]

Planner: Claude Opus 4.6 (1M context)
Date: 2026-04-13
Scope: fix all issues from NVIDIA-dev/openclaw-tracking#422 comments, PR #66028 reviews, and USER.md review

## Source Inventory

Issues were collected from three surfaces:

1. **NVIDIA-dev/openclaw-tracking#422** — issue body (advisory PoC) + triage comment by @drobison00 + scope comment by @eleqtrizit
2. **openclaw/openclaw#66028** — Greptile review (P2 test ordering), Codex review (P1 wildcard short-circuit)
3. **USER.md [CLAUDE REVIEW]** — five observations about the commit

## Prior Review Corrections

The CLAUDE REVIEW (above) contains hallucinated observations. Items #2, #3, and #5 reference "inbound dedupe simplification," "cron runtime import consolidation," and "commit bundles unrelated changes." These changes do NOT exist in commit `b34f1c1bfd`. The commit touches exactly 3 files, all within `extensions/slack/src/monitor/`. These review items should be disregarded.

## Issues (sorted by severity)

### Issue 1 — CRITICAL: `*` wildcard in `allowFrom` bypasses channel `users` restrictions

**Source:** Codex PR review on `extensions/slack/src/monitor/auth.ts:274-278`
**Is this part of a larger problem?** YES — this is the hidden systemic issue.

`allowFrom: ["*"]` is the **documented requirement** for `dmPolicy="open"` (see `extensions/slack/src/config-ui-hints.ts:10,14`). It is used pervasively in test helpers (`extensions/slack/src/monitor.test-helpers.ts:172`, `extensions/slack/src/monitor.tool-result.test.ts`, etc.).

The `*` entry compiles to a wildcard match in `src/channels/allowlist-match.ts:39,77-78` — it matches every sender. In `auth.ts:274`, the `ownerAllowed` early return fires BEFORE channel `users` is evaluated. This means:

- Operator configures `dmPolicy: "open"` → requires `allowFrom: ["*"]`
- Operator configures `channelsConfig: { C_SECURE: { users: ["U_ADMIN"] } }` to restrict a channel
- Block action in `C_SECURE` by `U_ATTACKER`: `ownerAllowed = true` (wildcard matches everyone) → early return → channel `users` never checked → **attacker authorized**

The codebase is already aware that `*` needs special treatment: `extensions/slack/src/monitor/provider.ts:516` filters it out with `.filter((entry) => entry !== "*")`. But `authorizeSlackSystemEventSender` does not.

**Fix plan:**

1. In `extensions/slack/src/monitor/auth.ts`, in the `else` (channel) branch (lines 253-303):
   - When `channelUsersAllowlistConfigured` is true, check channel `users` BEFORE the `ownerAllowed` short-circuit. If the sender passes channel `users`, allow. If not, only allow if `ownerAllowed` is true AND the match was NOT via wildcard (i.e., an explicit user ID match).
   - Approach: use `resolveSlackAllowListMatch` (which returns `matchSource`) instead of `isSlackSenderAllowListed` in the channel path so we can distinguish `"wildcard"` from `"id"` / `"name"` matches. When `matchSource === "wildcard"` and `channelUsersAllowlistConfigured`, do NOT short-circuit — fall through to the channel `users` check.
   - Alternative (simpler): filter `*` from the resolved `allowFromLower` before computing `ownerAllowed` in the channel branch, consistent with what `provider.ts:516` already does. This is the minimal change.
2. Add test cases to `auth.test.ts`:
   - `allowFrom: ["*"]` + channel `users` configured → sender NOT in channel `users` → deny
   - `allowFrom: ["*"]` + channel `users` configured → sender IN channel `users` → allow
   - `allowFrom: ["U_OWNER", "*"]` + channel `users` → non-owner, non-channel-user → deny (wildcard should not grant access when channel restriction exists)
3. Add integration test in `interactions.test.ts` for the `allowFrom: ["*"]` + channel users scenario.

### Issue 2 — MODERATE: Test ordering dependency in `auth.test.ts`

**Source:** Greptile PR review on `extensions/slack/src/monitor/auth.test.ts:118-122`
**Is this part of a larger problem?** No — isolated to this test file.

The `describe("authorizeSlackSystemEventSender")` block uses `authorizeSlackSystemEventSender` and `clearSlackAllowFromCacheForTest` variables that are assigned in the `beforeAll` of the sibling `describe("resolveSlackEffectiveAllowFrom")`. Running with `-t "authorizeSlackSystemEventSender"` skips that `beforeAll`, leaving both as `undefined`.

**Fix plan:**

1. Add a `beforeAll` to the `describe("authorizeSlackSystemEventSender")` block:
   ```typescript
   beforeAll(async () => {
     ({ authorizeSlackSystemEventSender, clearSlackAllowFromCacheForTest } =
       await import("./auth.js"));
   });
   ```
2. Verify with: `pnpm test extensions/slack/src/monitor/auth.test.ts -t "authorizeSlackSystemEventSender"`

### Issue 3 — LOW: Missing `channelsConfigKeys` in interactions test helper

**Source:** USER.md [CLAUDE REVIEW] observation #1
**Is this part of a larger problem?** No — isolated to the test helper.

The `createContext` helper in `extensions/slack/src/monitor/events/interactions.test.ts:143` sets `channelsConfig` but not `channelsConfigKeys`. The `resolveSlackChannelConfig` function falls back to `Object.keys(entries)` when `channelKeys` is undefined, so tests pass — but they exercise the fallback path, not the production path.

**Fix plan:**

1. Add `channelsConfigKeys: Object.keys(overrides?.channelsConfig ?? {}),` to the `createContext` helper (after line 143).

### Issue 4 — LOW: No regression test for no-channel-context permissive default

**Source:** USER.md [CLAUDE REVIEW] observation #4
**Is this part of a larger problem?** No — but documents the intentional permissive-default boundary.

No test asserts the current behavior when `channelId` is absent AND `allowFrom` is empty (the open default the advisory's bypass #1 describes). This test would anchor the behavior as intentional and catch any future default-deny migration.

**Fix plan:**

1. Add to `auth.test.ts` in the `authorizeSlackSystemEventSender` describe:
   ```typescript
   it("allows senders without channel context when no allowFrom is configured", async () => {
     const result = await authorizeSlackSystemEventSender({
       ctx: makeAuthorizeCtx(),
       senderId: "U_ANYONE",
     });
     expect(result).toEqual({ allowed: true });
   });
   ```

[CODEX SUMMARY]

I verified Claude's plan against `NVIDIA-dev/openclaw-tracking#422`, the current Slack auth code, and the branch state.

Plan correctness:

- Correct: the critical wildcard issue is real. In the current branch, `authorizeSlackSystemEventSender()` treated `allowFrom: ["*"]` as an immediate owner allow and returned before checking channel-level `users`, so a wildcard global allowlist bypassed channel interaction restrictions.
- Correct: `auth.test.ts` had a focused-run ordering bug. The `authorizeSlackSystemEventSender` describe relied on imports initialized only by the sibling `resolveSlackEffectiveAllowFrom` describe, so `pnpm test ... -t "authorizeSlackSystemEventSender"` was fragile.
- Correct but minor: `interactions.test.ts` was missing `channelsConfigKeys` in `createContext`, which meant those tests exercised the fallback path instead of the normal resolved-key path.
- Correct as documentation only: there was no regression test anchoring the current permissive no-channel-context behavior.
- Incorrect: the earlier Claude review items about inbound dedupe, cron import cleanup, and bundled unrelated commit content were hallucinated for this branch and do not apply.

Code changes made:

- Updated `extensions/slack/src/monitor/auth.ts` so channel-scoped interactive auth no longer lets a wildcard global `allowFrom` short-circuit channel `users` restrictions. Explicit owner matches still pass; wildcard matches only stay authoritative when no channel `users` allowlist is configured.
- Added focused regression coverage in `extensions/slack/src/monitor/auth.test.ts` for:
  - wildcard global allowlist not bypassing channel `users`
  - wildcard global allowlist still allowing configured channel users
  - mixed explicit owner + wildcard still denying non-channel users
  - no-channel-context permissive default
- Added a local `beforeAll` import in the `authorizeSlackSystemEventSender` test describe so focused `-t` runs work independently.
- Added `channelsConfigKeys` to `extensions/slack/src/monitor/events/interactions.test.ts` helper and an integration test proving wildcard global allowlists do not bypass channel user restrictions in the handler path.

Validation:

- `pnpm test extensions/slack/src/monitor/auth.test.ts`
- `pnpm test extensions/slack/src/monitor/auth.test.ts -t "authorizeSlackSystemEventSender"`
- `pnpm test extensions/slack/src/monitor/events/interactions.test.ts`

Residual note:

- This keeps the current permissive default for empty `allowFrom` when no channel context exists. That matches the branch's hardening-only scope and does not implement the advisory's proposed default-deny behavior.

## Issues NOT addressed (intentionally scoped out)

Per the triage by @drobison00 and scope decision by @eleqtrizit, the following advisory bypasses remain as-is. They are hardening-class gaps under `SECURITY.md`, not auth boundary bypasses:

- **Bypass #1**: No-channel-context + empty `allowFrom` = permissive (documented default)
- **Bypass #3**: `expectedSenderId` not set for block actions (block actions have no modal-style identity binding)
- **Bypass #4**: Channel type fallback to `"channel"` for `C`-prefixed IDs (D-prefix forced to `"im"` by `normalizeSlackChannelType`, so DM restrictions cannot be bypassed this way)

## Execution Order

1. Fix Issue 1 (critical wildcard bypass) — `auth.ts` logic + new tests
2. Fix Issue 2 (test ordering) — `auth.test.ts` beforeAll
3. Fix Issue 3 (channelsConfigKeys) — `interactions.test.ts` helper
4. Fix Issue 4 (regression anchor test) — `auth.test.ts` new case
5. Run `pnpm test extensions/slack/src/monitor/auth.test.ts` and `pnpm test extensions/slack/src/monitor/events/interactions.test.ts`
6. Run `pnpm check` on the Slack surface

## Validation

- All existing tests must continue to pass (no behavioral regression for non-wildcard configs)
- New tests must cover the wildcard + channel users matrix
- Filtered test run `pnpm test auth.test.ts -t "authorizeSlackSystemEventSender"` must pass in isolation (proves issue 2 is fixed)

[CODEX REVIEW FOLLOW-UP]

Date: 2026-04-13
PR: https://github.com/openclaw/openclaw/pull/66028

Reviewed `NVIDIA-dev/openclaw-tracking#422` and PR `openclaw/openclaw#66028` comments.

Work completed:

- Fixed the Greptile test-ordering review by adding a local `beforeAll` in the `authorizeSlackSystemEventSender` describe.
- Fixed the Codex wildcard review by preventing wildcard global `allowFrom` matches from bypassing channel `users` restrictions; explicit owner matches still pass.
- Added regression coverage in `extensions/slack/src/monitor/auth.test.ts` for wildcard/channel-user behavior and the no-channel-context permissive default.
- Added `channelsConfigKeys` to `extensions/slack/src/monitor/events/interactions.test.ts` and an integration test for the wildcard/channel-user path.

Validation:

- `pnpm test extensions/slack/src/monitor/auth.test.ts`
- `pnpm test extensions/slack/src/monitor/auth.test.ts -t "authorizeSlackSystemEventSender"`
- `pnpm test extensions/slack/src/monitor/events/interactions.test.ts`
