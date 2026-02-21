# PR Title (recommended)

`fix(discord): Discord status state machine 2.0 (follow-up to #18248)`

---

## Summary

Describe the problem and fix in 2–5 bullets:

- Problem:
  - v1 (authored by **@victorGPT**, merged as PR #18248) solved baseline transitions, but under stress it could still show **semantic/progress rollback** on the same message: eye emoji and active emojis could flip back and forth (`👀 ↔ 🧠`, or `⏳ -> 💻 -> ⏳`).
  - In bursty multi-message queues, v1 did not reliably provide a clear per-message waiting signal for every queued message.
- Why it matters:
  - This creates false progress signals: operators can see a message appear to "go backward" even though execution already moved forward.
- What changed:
  - v2 enforces semantic monotonic progression (no ACTIVE/WAITING rollback), keeps ACTIVE-internal icon switches valid, unifies deferred queue outcomes, adds explicit clear/cancel-before-start cleanup, and makes queued-message waiting visibility explicit for burst scenarios.
- What did NOT change (scope boundary):
  - No non-Discord behavior changes, no thread/channel rename strategy changes, no new slash command in this PR.

## Change Type (select all)

- [x] Bug fix
- [ ] Feature
- [x] Refactor
- [ ] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [x] Gateway / orchestration
- [ ] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [x] Integrations
- [x] API / contracts
- [ ] UI / DX
- [ ] CI/CD / infra

## Linked Issue/PR

- Closes #(fill-if-any)
- Related #18248 (v1 baseline)
- v1 PR (authored by @victorGPT): [#18248](https://github.com/openclaw/openclaw/pull/18248)

## User-visible / Behavior Changes

- v2 explicitly prevents semantic/progress rollback once a message reaches ACTIVE (blocks `ACTIVE -> WAITING`).
- v1-style thrash patterns such as `👀 ↔ 🧠` and `⏳ -> 💻 -> ⏳` are treated as invalid rollback and suppressed.
- ACTIVE internal switching (thinking/tool variants like `🧠 ↔ 💻/🛠️/🌐`) remains valid and is not treated as rollback.
- In multi-message bursts, each queued message now shows explicit WAITING (`⏳`) while queued, then transitions when processing actually starts.
- Off mode remains ack-oriented while handling deferred bookkeeping correctly (no premature ack-clear during queued/deferred lifecycle).
- Deferred state cleanup is explicit on queue clear/cancel-before-start paths to avoid stale status artifacts.

### Before vs After (v1 -> v2)

| Area                                       | v1 (#18248)                                                                  | v2 (this PR)                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Baseline behavior                          | Faster reaction status machine                                               | Semantic hardening under real queue/deferred stress                               |
| Semantic/progress rollback on same message | Could still thrash between eye + active emojis (`👀 ↔ 🧠`, `⏳ -> 💻 -> ⏳`) | Monotonic semantic phases block rollback; no false backward progress              |
| Deferred queue outcomes                    | Partial handling                                                             | Unified outcome model (`queued/skipped/dropped/merged/failed`) with cleanup hooks |
| Multi-message queue visibility             | Under burst load, some queued messages lacked clear waiting state            | Every queued message shows WAITING (`⏳`), then transitions when execution starts |
| Clear/cancel-before-start                  | Could leave stale deferred state                                             | Explicit failure outcome + deferred cleanup                                       |
| off mode + deferred                        | Could lose deferred context and clear ack too early in edge cases            | Keeps ack-only display while preserving deferred lifecycle bookkeeping            |

### Behavior Signatures (quick reviewer view)

- **V1 false rollback signature** (same message): `👀 -> 🧠 -> 💻 -> 👀 -> 🧠` or `⏳ -> 💻 -> ⏳`
- **V2 monotonic signature** (same message): WAITING `⏳` (if queued) -> ACTIVE (`🧠/💻/🛠️/🌐`) -> terminal (`✅/❌`) without semantic backward transition
- **Queue visibility in bursts**: for A/B/C stacked messages, B and C show `⏳` while waiting; each one switches out of `⏳` when its own execution actually begins

## Security Impact (required)

- New permissions/capabilities? (`No`)
- Secrets/tokens handling changed? (`No`)
- New/changed network calls? (`No`)
- Command/tool execution surface changed? (`No`)
- Data access scope changed? (`No`)
- If any `Yes`, explain risk + mitigation:
  - N/A

## Repro + Verification

### Environment

- OS: macOS (Darwin arm64)
- Runtime/container: Node.js + pnpm local workspace
- Model/provider: openai-codex/gpt-5.3-codex (coding/review workers)
- Integration/channel (if any): Discord
- Relevant config (redacted):
  - `messages.statusReactionMode = full|off`
  - `messages.removeAckAfterReply = true|false`

### Steps

1. Send multi-message burst to create queued/deferred transitions.
2. Observe status progression across waiting/active/terminal phases.
3. Test `statusReactionMode=off` with deferred queued flow and `removeAckAfterReply=true`.
4. Trigger clear/cancel-before-start path and ensure no stale deferred status remains.

### Expected

- No semantic rollback after ACTIVE starts.
- No `👀 ↔ 🧠` oscillation and no `⏳ -> 💻 -> ⏳` fallback for the same message.
- In burst sends, queued messages are clearly signaled as waiting and then promoted when execution starts.
- off mode remains ack-oriented without premature ack clear during deferred flow.
- No stale deferred state after queue-clear/cancel-before-start.

### Actual

- Matches expected in targeted regression tests and local verification commands.

## Evidence

Attach at least one:

- [x] Failing test/log before + passing after
- [x] Trace/log snippets
- [ ] Screenshot/recording
- [ ] Perf numbers (if relevant)

## Human Verification (required)

What you personally verified (not just CI), and how:

- Verified scenarios:
  - queued/deferred lifecycle correctness,
  - rollback prevention invariants,
  - off-mode deferred behavior,
  - queue clear/cancel cleanup behavior.
- Edge cases checked:
  - error/retry progression,
  - cancellation before lifecycle start.
- What you did **not** verify:
  - full production-scale long-duration multi-guild soak run.

## Compatibility / Migration

- Backward compatible? (`Yes`)
- Config/env changes? (`No`)
- Migration needed? (`No`)
- If yes, exact upgrade steps:
  - N/A

## Failure Recovery (if this breaks)

- How to disable/revert this change quickly:
  - Roll back this PR commit range.
- Files/config to restore:
  - `src/discord/monitor/message-handler.process.ts`
  - `src/discord/monitor/message-handler.process.test.ts`
  - `src/auto-reply/reply/queue/*` (outcome/cleanup related)
- Known bad symptoms reviewers should watch for:
  - `👀 ↔ 🧠` jitter on one message,
  - `⏳ -> tool -> ⏳` fallback,
  - ack disappearing too early in off-mode deferred runs,
  - stale deferred status after queue clear/cancel.

## Risks and Mitigations

- Risk:
  - Deferred cleanup timing tradeoff in rare delayed-retry scenarios.
  - Mitigation:
    - Unified outcome cleanup + targeted lifecycle regression tests.

- Risk:
  - Future call paths bypassing semantic invariants.
  - Mitigation:
    - Centralized semantic-phase guard in status controller + regression tests for observed live signatures.
