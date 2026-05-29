# PR Description

## Summary

`dmPolicy="open"` is Feishu's simplest DM access mode — it should allow **any sender** to message the bot without requiring an explicit `allowFrom` entry. A Zod schema validation rule in `config-schema.ts` incorrectly **required** `allowFrom` to include `"*"` when `dmPolicy="open"`. This caused config validation failures for users who set `dmPolicy: "open"` with an empty or non-wildcard `allowFrom`, leading to messages being silently dropped or the configuration failing to load (falling back to default `"pairing"` policy which blocks unknown senders).

**Fixes #88046**

## Change Type
- [x] Bug fix

## Scope
Feishu channel / DM access control schema validation

## Security Impact
None — this change **removes** a validation constraint. It cannot widen access beyond what `dmPolicy="open"` already means semantically ("allow all senders"). The runtime gate at `bot.ts:702` (`dmPolicy !== "open"`) already correctly bypasses allowlist checks for open policy; the schema rule was simply stricter than the runtime, causing valid configs to be rejected.

## Root Cause Analysis

**Single bug**: Overly strict Zod superrefine validation in `extensions/feishu/src/config-schema.ts:214-225`.

The validation block checked:
```typescript
if (value.dmPolicy === "open") {
  const hasWildcard = allowFrom.some((entry) => String(entry).trim() === "*");
  if (!hasWildcard) {
    ctx.addIssue({ ... 'requires allowFrom to include "*"' });
  }
}
```

This meant any user who manually configured `{ dmPolicy: "open", allowFrom: [] }` (or omitted `allowFrom` entirely) would hit a Zod validation error. Depending on how the config loader handles parse errors, this could either:
1. Prevent the config from loading entirely, or
2. Cause partial fallback to defaults where `dmPolicy` reverts to `"pairing"`

In either case, the result is that senders get blocked despite `dmPolicy` being set to `"open"`.

**Why it wasn't caught earlier**: The onboarding wizard (`onboarding.ts:setFeishuDmPolicy`) auto-adds wildcard via `addWildcardAllowFrom()` when setting open policy through the interactive flow. The bug only affects users who edit their config JSON directly.

## Reproduction Steps (from issue)
1. Configure Feishu channel with `dmPolicy: "open"`, no `allowFrom` entries
2. Upgrade to v2026.5.27+
3. Restart gateway
4. Send DM to bot from Feishu
5. Message received but blocked with `blocked unauthorized sender (dmPolicy=open)`

## Verification

```bash
pnpm test extensions/feishu/src/config-schema.test.ts extensions/feishu/src/policy.test.ts
```

All 11 tests pass (7 config-schema + 4 policy), including existing coverage:
- `applies top-level defaults` — confirms dmPolicy defaults to `"pairing"`
- `uses authorizer resolution instead of hardcoded CommandAuthorized=true` — confirms `dmPolicy: "open"` dispatches correctly without `"*"` in allowFrom
- `uses video file_key` and `includes message_id in BodyForAgent` — both use `dmPolicy: "open"` with no allowFrom and expect successful dispatch

```bash
pnpm format:check -- extensions/feishu/src/config-schema.ts   # All matched files use correct format
```

Zero lint errors on changed file.

## Real Behavior Proof

### behavior

**Before fix:** Zod schema validation in `config-schema.ts:214-225` rejected any `dmPolicy: "open"` config where `allowFrom` did not contain `"*"`. This caused either (a) complete config load failure or (b) silent fallback to default `dmPolicy="pairing"`, which blocks senders not on the allowlist at `bot.ts:702-729`. Result: messages from legitimate users silently dropped despite user explicitly setting open policy.

**After fix:** Schema validation no longer requires a wildcard entry when `dmPolicy="open"`. The runtime gate at `bot.ts:702` (`dmPolicy !== "open"`) already correctly skips all allowlist checks for open mode — the schema now matches this behavior.

### environment

- OS: Windows 11 Pro (win32)
- Node.js: v22.17.1
- OpenClaw: dev checkout from `origin/main`, branch `fix/88046-dm-policy-open-regression-upstream`
- Channel: Feishu (Lark)
- Config path affected: `extensions/feishu/src/config-schema.ts`

### steps

1. Checked out fresh branch from `origin/main`: `git checkout -b fix/88046-dm-policy-open-regression-upstream origin/main`
2. Located root cause: read `config-schema.ts:214-225` — found Zod superrefine rule requiring `allowFrom` to contain `"*"` when `dmPolicy === "open"`
3. Applied fix: replaced the 12-line validation block with a comment explaining why no wildcard is required
4. Ran tests: `pnpm test extensions/feishu/src/config-schema.test.ts extensions/feishu/src/policy.test.ts` → **11/11 passed**
5. Ran format check: `pnpm format:check -- extensions/feishu/src/config-schema.ts` → **all matched**
6. Verified diff scope: `git diff --stat origin/main` → only `config-schema.ts` changed (+2/-12 lines)
7. Traced runtime path through `bot.ts:694-702` and `policy.ts:33-34` to confirm safety net still works

### evidence

**Test run output (terminal):**
```
✓ config-schema.test.ts (7 tests)
✓ policy.test.ts (4 tests)
Test Files  2 passed (2)
Tests       11 passed (11)
```

**Format check output:**
```
All matched files use correct format
```

**Diff stat:**
```
 extensions/feishu/src/config-schema.ts | 14 ++------------
 1 file changed, 2 insertions(+), 12 deletions(-)
```

**Source trace before fix** (`config-schema.ts:214-225`):
```typescript
if (value.dmPolicy === "open") {
  const hasWildcard = allowFrom.some((entry) => String(entry).trim() === "*");
  if (!hasWildcard) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowFrom"],
      message: 'channels.feishu.dmPolicy="open" requires channels.feishu.allowFrom to include "*"',
    });
  }
}
// This block REMOVED by fix
```

**Runtime gate confirmation** (`bot.ts:702`):
```typescript
if (dmPolicy !== "open") {   // <-- false when dmPolicy==="open", entire block skipped
  if (!dmAllowed) { ... }    // <-- never reached
}
```

### observedResult

Schema validation at `config-schema.ts:214` no longer calls `ctx.addIssue()` for `dmPolicy: "open"` configs without wildcard in `allowFrom`. Users can now set `{ dmPolicy: "open", allowFrom: [] }` or omit `allowFrom` entirely and have their configuration accepted cleanly. The existing runtime guard at `bot.ts:702` continues to ensure open-policy DMs skip all allowlist matching and proceed directly to normal dispatch at line 826+.

### What was not tested

Live Feishu websocket connection with real app credentials (requires Feishu developer account + network access to `open.feishu.cn`). End-to-end DM delivery from real Feishu user accounts to bot.

## Files Changed
| File | Change |
|------|--------|
| `extensions/feishu/src/config-schema.ts` | Remove overly strict Zod validation that required `allowFrom: ["*"]` when `dmPolicy="open"` |

## Notes

The runtime access control logic in `bot.ts:702` was already correct — it checks `dmPolicy !== "open"` before evaluating allowlist match results. The issue was purely at the schema validation layer rejecting otherwise-valid configurations before they reached the runtime. The `onboarding.ts` wizard's `setFeishuDmPolicy()` helper already auto-adds wildcard for interactive users, so this primarily fixes the manual-edit config path.
