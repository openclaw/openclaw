## What and why

Anthropic Max (and other OAuth/token-subscription users) hit a billing limit and see:

> ⚠️ Anthropic (claude-sonnet-4-5) returned a billing error — **your API key** has run out of
> credits or has an insufficient balance. Check your Anthropic billing dashboard and **top up or
> switch to a different API key.**

Max users authenticate via OAuth — they have **no API key** to top up. The copy is misleading and
creates support confusion. The recommended Anthropic onboarding path (`/api-key` → Max plan) makes
this a common case.

This PR adds an optional `authMode` parameter to `formatBillingErrorMessage` and threads it from
`credential.type` (already computed at the call sites) through `formatAssistantErrorText` opts.
When `authMode` is `"oauth"` or `"token"`, the message becomes:

> ⚠️ Anthropic (claude-sonnet-4-5) returned a billing error — check your account for subscription
> or usage limits, then try again.

API-key and aws-sdk modes are **unchanged** (regression-guarded by test).

The diff is intentionally minimal to avoid conflicting with the string rewording in the open i18n
PR #90611 — only the new auth-mode branch is added; no existing api-key strings are reworded.

Fixes #80877

## Changes

| File                                                                 | Change                                                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/embedded-agent-helpers/sanitize-user-facing-text.ts`     | Add optional `authMode?` param to `formatBillingErrorMessage`; emit neutral copy for `"oauth"` / `"token"`                                        |
| `src/agents/embedded-agent-helpers/errors.ts`                        | Add `authMode?` to `formatAssistantErrorText` + `formatUserFacingAssistantErrorText` opts; thread to all 3 `formatBillingErrorMessage` call sites |
| `src/agents/embedded-agent-runner/run/assistant-failover.ts`         | Add `authMode?` to `handleAssistantFailover` params + `resolveAssistantFailoverErrorMessage` params; pass to both formatter calls                 |
| `src/agents/embedded-agent-runner/run/payloads.ts`                   | Add `authMode?` to `buildEmbeddedRunPayloads` params; pass to both error-text formatters                                                          |
| `src/agents/embedded-agent-runner/run.ts`                            | Pass `attemptAuthProfileStore.profiles?.[lastProfileId]?.type` as `authMode` at both formatter call sites                                         |
| `src/agents/embedded-agent-helpers.formatassistanterrortext.test.ts` | 5 new tests: oauth neutral copy, token neutral copy, api_key regression guard, undefined regression guard, no-provider regression guard           |

## Real behavior proof

**Behavior or issue addressed:** `formatBillingErrorMessage("Anthropic", "claude-sonnet-4-5", "oauth")` must NOT
contain "API key" or "top up" language. API-key mode must still emit the original copy.

**Real environment tested:** main `3d05da9a`, Node 24, pnpm 11.2.2, macOS; real formatter module — not
mocked. Tests import and call the actual `formatBillingErrorMessage` function from
`embedded-agent-helpers.js`.

**Exact steps or command run after this patch:**

```
node scripts/run-vitest.mjs run src/agents/embedded-agent-helpers.formatassistanterrortext.test.ts
```

**Before evidence (RED — 2 failures):**

```
 FAIL  |unit-fast| src/agents/embedded-agent-helpers.formatassistanterrortext.test.ts
  > formatBillingErrorMessage — authMode neutral copy (#80877)
    > returns neutral copy for oauth authMode — no 'API key' text

AssertionError: expected '⚠️ Anthropic (claude-sonnet-4-5) returned a billing error — your API key
has run out of credits or has an insufficient balance. Check your Anthropic billing dashboard and
top up or switch to a different API key.' not to match /api key/i

 FAIL  |unit-fast| src/agents/embedded-agent-helpers.formatassistanterrortext.test.ts
  > formatBillingErrorMessage — authMode neutral copy (#80877)
    > returns neutral copy for token authMode — no 'API key' text

AssertionError: expected '⚠️ Anthropic (claude-sonnet-4-5) returned a billing error — your API key
has run out of credits...' not to match /api key/i

 Test Files  1 failed (1)
       Tests  2 failed | 84 passed (86)
    Start at  20:45:10
    Duration  1.07s
```

**Evidence after fix (GREEN — all 86 pass):**

```
cd /tmp/oc-wt-80877 && corepack pnpm exec vitest run src/agents/embedded-agent-helpers.formatassistanterrortext.test.ts

 RUN  v4.1.8 /private/tmp/oc-wt-80877

 Test Files  1 passed (1)
      Tests  86 passed (86)
   Start at  20:55:03
   Duration  1.17s (transform 695ms, setup 0ms, import 1.08s, tests 18ms, environment 0ms)
```

**Observed result:** OAuth users see neutral copy ("check your account for subscription or usage
limits, then try again") — no "API key" or "top up" language. API-key mode is unchanged (regression
guards pass).

**What was not tested:** A live Anthropic Max OAuth account hitting a real 402/429 billing limit
is the gold reproduction — that path is not available in CI. The formatter branch (`authMode ===
"oauth"`) is the testable proof, and the credential threading (run.ts → handleAssistantFailover →
resolveAssistantFailoverErrorMessage / buildEmbeddedRunPayloads) is statically verifiable. The 5
new tests cover the formatter contract exhaustively.

---

> **AI-assisted:** This fix was drafted with Claude Code (Sonnet 4.6). All code reviewed for
> correctness and minimal diff. Allow edits by maintainers: yes.
