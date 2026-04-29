## Title

`telegram: honor configured max media size in Telegram message replies`

## Summary

Describe the problem and fix in 2–5 bullets:

If this PR fixes a plugin beta-release blocker, title it `fix(<plugin-id>): beta blocker - <summary>` and link the matching `Beta blocker: <plugin-name> - <summary>` issue labeled `beta-blocker`. Contributors cannot label PRs, so the title is the PR-side signal for maintainers and automation.

- Problem: Telegram reply delivery paths were not forwarding the configured media byte cap (`mediaMaxMb`) into media loading for message replies and native-command replies.
- Why it matters: Media replies could be loaded without the intended size guard, so large payloads bypassed Telegram upload limits and existing configuration expectations.
- What changed: Propagated `mediaMaxBytes` through the message processing/dispatch/native-command delivery path and into `loadWebMedia` for reply delivery, including both standard model replies and native-command progress/message flows.
- What did NOT change (scope boundary): API contracts and outbound send behavior outside Telegram’s reply pipeline; no config schema changes and no runtime transport/security model changes.

## Change Type (select all)

- [x] Bug fix
- [ ] Feature
- [x] Refactor required for the fix
- [ ] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [ ] Gateway / orchestration
- [ ] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [x] Integrations
- [ ] API / contracts
- [ ] UI / DX
- [ ] CI/CD / infra

## Linked Issue/PR

- Closes [#46023](https://github.com/openclaw/openclaw/issues/46023)
- Related #<issue-or-pr>
- [x] This PR fixes a bug or regression

## Root Cause (if applicable)

For bug fixes or regressions, explain why this happened, not just what changed. Otherwise write `N/A`. If the cause is unclear, write `Unknown`.

- Root cause: Telegram reply delivery had a parameter-path gap where `mediaMaxBytes` was computed but not threaded into reply delivery, so `loadWebMedia` calls used default/no-limit loading options.
- Missing detection / guardrail: no assertion in delivery-level tests that configured limits propagate from core/native command setup through `deliverReplies` to media loading.
- Contributing context (if known): send-style paths already propagated `mediaMaxBytes`, but message reply delivery path had a separate code path that had not adopted the same propagation.

## Regression Test Plan (if applicable)

For bug fixes or regressions, name the smallest reliable test coverage that should catch this. Otherwise write `N/A`.

- Coverage level that should have caught this:
  - [x] Unit test
  - [x] Seam / integration test
  - [ ] End-to-end test
  - [ ] Existing coverage already sufficient
- Target test or file:
  - `extensions/telegram/src/bot/delivery.test.ts`
  - `extensions/telegram/src/bot-message-dispatch.test.ts`
  - `extensions/telegram/src/bot-native-commands.test.ts`
  - `extensions/telegram/src/bot.create-telegram-bot.test.ts`
- Scenario the test should lock in: A configured `mediaMaxMb` must be translated to `maxBytes` passed into `loadWebMedia` for all Telegram reply flows.
- Why this is the smallest reliable guardrail: It validates propagation at the seam where behavior was previously missing, without requiring live Telegram API calls.
- Existing test that already covers this (if any): none; targeted tests were added/updated for this regression.
- If no new test is added, why not: N/A.

## User-visible / Behavior Changes

`mediaMaxMb` now governs outbound Telegram reply media loading consistently (including native command/progress/media reply delivery). Large media links are loaded with the configured byte cap instead of loading with an unconstrained default.

## Diagram (if applicable)

For UI changes or non-trivial logic flows, include a small ASCII diagram reviewers can scan quickly. Otherwise write `N/A`.

```text
Before:
[telegram update] -> [message dispatch/native command] -> [deliverReplies] -> loadWebMedia()
(no mediaMaxBytes passed)

After:
[telegram update] -> [message dispatch/native command] -> [deliverReplies] -> loadWebMedia(maxBytes)
```

## Security Impact (required)

- New permissions/capabilities? (`Yes/No`) No
- Secrets/tokens handling changed? (`Yes/No`) No
- New/changed network calls? (`Yes/No`) No
- Command/tool execution surface changed? (`Yes/No`) No
- Data access scope changed? (`Yes/No`) No
- If any `Yes`, explain risk + mitigation: N/A

## Repro + Verification

### Environment

- OS: macOS
- Runtime/container: Node 22, pnpm
- Model/provider: N/A
- Integration/channel (if any): Telegram
- Relevant config (redacted): `mediaMaxMb: 12` (Telegram account or bot options)

### Steps

1. Configure Telegram bot options or account with `mediaMaxMb`.
2. Trigger a model/native command that emits a reply with media.
3. Verify media loading is called with `maxBytes` matching the configured cap.
4. Run targeted tests and confirm no regressions in the Telegram unit suites.

### Expected

- Each Telegram reply path passes `mediaMaxBytes`/`mediaMaxMb` into media loading consistently.

### Actual

- Before fix: configured max was not consistently forwarded in reply paths.
- After fix: media loader receives the configured byte cap on delivery paths.

## Evidence

Attach at least one:

- [x] Failing test/log before + passing after
- [ ] Trace/log snippets
- [ ] Screenshot/recording
- [ ] Perf numbers (if relevant)

Verification run:

```text
pnpm test extensions/telegram/src/bot/delivery.test.ts extensions/telegram/src/bot-message-dispatch.test.ts extensions/telegram/src/bot-native-commands.test.ts extensions/telegram/src/bot.create-telegram-bot.test.ts
```

## Human Verification (required)

What you personally verified (not just CI), and how:

- Verified scenarios: `deliverReplies`, message dispatch, native command and bot creation tests all asserting `maxBytes` propagation.
- Edge cases checked: default path and explicit override path (`mediaMaxMb` set via test options) both cover propagation.
- What you did **not** verify: live end-to-end Telegram upload behavior with huge payloads in production bot runtime.

## Review Conversations

- [ ] I replied to or resolved every bot review conversation I addressed in this PR.
- [x] I left unresolved only the conversations that still need reviewer or maintainer judgment.

If a bot review conversation is addressed by this PR, resolve that conversation yourself. Do not leave bot review conversation cleanup for maintainers.

## Compatibility / Migration

- Backward compatible? (`Yes/No`) Yes
- Config/env changes? (`Yes/No`) No
- Migration needed? (`Yes/No`) No
- If yes, exact upgrade steps: N/A.

## Risks and Mitigations

List only real risks for this PR. Add/remove entries as needed. If none, write `None`.

- Risk: Large media replies now have explicit cap defaults via propagated `mediaMaxBytes`, which may change failure mode for oversized assets in reply paths that previously had no effective cap.
  - Mitigation: follows existing `mediaMaxMb` configuration semantics already used for send flows and adds targeted regression coverage.
