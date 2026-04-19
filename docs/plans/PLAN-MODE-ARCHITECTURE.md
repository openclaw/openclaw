# Plan-Mode Rollout — Architecture & Status

**Last updated:** nuclear-fix-stack integration complete on `feat/plan-channel-parity` (post `5a2f6255ff`, see "Nuclear-fix-stack integration" section below). Branch hosts the **umbrella PR #68939** which now carries the consolidation work + 7 review-loop waves + 9 nuclear-fix-stack commits + cleanup.
**Live install (pre-rebase):** `OpenClaw 2026.4.15` from `feat/plan-channel-parity`
**Total PRs (historical):** 10 individual PRs A/B/C/D/E/F/7/8/10/11 (now closed) + 1 umbrella PR (#68939) carrying the full 156-commit history (135 consolidation + 10 review-wave + 11 nuclear-fix integration)
**Backup branch:** `feat/plan-channel-parity-backup` at pre-rebase HEAD `bee5e8c364` (pushed to origin for rollback safety)

This document is the **single source of truth** for the plan-mode rollout. It survives Claude Code session compactions and is referenced by the umbrella PR + every closed PR's redirect comment.

---

## Nuclear-fix-stack integration — 2026-04-19 (post-wave-7)

After review-loop wave 7 converged at 100% thread resolution, another agent ([@eva@100yen.org](mailto:eva@100yen.org)) surfaced a **9-commit "nuclear-fix stack"** on `feat/plan-mode-nuclear-fix-stack` addressing 5 correctness gaps in PR #68939 that the review waves only partially covered. Stack landed via cherry-pick (Option A from the integration ask comment).

### The 5 bugs fixed

| #   | Bug                                                                                             | Wave-N coverage                                                                     | Nuclear-fix stack coverage                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `[PLAN_DECISION]: edited` injection had **no plan steps** (orphan `buildApprovedPlanInjection`) | Wave-5 codified `edit` action in schema                                             | Wires `buildApprovedPlanInjection` / `buildAcceptEditsPlanInjection` to actually carry plan steps in approve/edit injections                                                                               |
| 2   | `pendingAgentInjection: string` is **last-write-wins** (silent clobber race)                    | Wave-3 answer-guard catches mismatched approvalIds                                  | Replaces scalar with typed priority-ordered queue `pendingAgentInjections: PendingAgentInjectionEntry[]` (id-dedup, drain-once-per-turn)                                                                   |
| 3   | Post-approval ack-only turns are **never retried**                                              | (no fix shipped)                                                                    | Extends `resolvePlanModeAckOnlyRetryInstruction` to fire within `recentlyApprovedAt < 5min` grace                                                                                                          |
| 4   | Subagent announce-turns **race the approval-resume turn**                                       | Wave-1 `openSubagentRunIds.size === 0` check at exit_plan_mode + approval-side gate | Adds concurrency cap (1 in plan mode) + 10s `lastSubagentSettledAt` grace window + dual gates + new error code `PLAN_APPROVAL_WAITING_FOR_SUBAGENT_SETTLE`                                                 |
| 5   | `acceptEdits` action has **no runtime semantics**                                               | Wave-5 schema discriminated union codified `action: "edit"`                         | New `SessionEntry.postApprovalPermissions.acceptEdits` (scoped by approvalId) + 3-rule constraint gate (no destructive, no self-restart, no config changes) at `src/agents/plan-mode/accept-edits-gate.ts` |

### Integration commits (cherry-pick of side branch + cleanup)

```
5a2f6255ff chore(protocol): regenerate Swift bindings for nuclear-fix-stack additions
735aafea71 fix(plan-mode): post-cherry-pick test + lint cleanup (queue migration + iteration-budget bump)
834e5396cb test(plan-mode): wave-4 prompt-cache byte stability                    (+7 tests)
c91cad9db9 test(plan-mode): wave-3 integration regression coverage                (+15 tests)
70bd466589 fix(plan-mode): wave-1 adversarial review fixes                        (4 sub-fixes)
f5b6fbe47c feat(plan-mode): post-approval ack-only retry grace window             (bug #3)
436d308506 feat(plan-mode): subagent concurrency cap + grace window + dual gates  (bug #4)
7110953c0c feat(plan-mode): acceptEdits constraint gate + runtime wiring          (bug #5; WIP-stripped)
b33eeb4a3c feat(plan-mode): postApprovalPermissions schema + set/clear plumbing   (foundation for #5)
5bd5a52d3b feat(plan-mode): wire queue writers + approved/acceptEdits plan text   (bug #1)
70a6e4b23a feat(plan-mode): typed injection queue + auto-migrate legacy scalar    (bug #2 architecture)
```

### Resolution decisions during integration

- **Schema additions truly orthogonal**: both stacks coexist in `SessionEntry`. Field order: `pendingAgentInjection` (legacy/deprecated, auto-migrated) → `pendingAgentInjections` (queue) → `pendingQuestionApprovalId` → `pendingQuestionOptions` → `pendingQuestionAllowFreetext` → `postApprovalPermissions`.
- **`sessions-patch.ts` answer branch layered**: wave-3/4 answer-guard validation chain (approvalId match + option-membership for non-freetext) fires BEFORE `appendToInjectionQueue`. Both validations preserved.
- **`pending-injection.ts` full rewrite** taken from the side branch as a queue-shim; once-and-only-once docstring backported as a comment block.
- **WIP contamination strip on commit 4 (`b6b2783ba3`)**: ~150 lines of unrelated bootstrap refactor + ollama-runtime imports + dead-export removals dropped from `attempt.ts`. Only the ~3-line `getLatestAcceptEdits` threading kept. Same pattern applied in `pi-tools.ts` and `params.ts` where the cherry-pick removed our HEAD's existing `memberRoleIds` / `isCanonicalWorkspace` fields (restored).
- **`resolveSessionTotalTokens` rename**: the side branch's commit 1 renamed this export to `resolveFreshSessionTotalTokens` but didn't update the 2 consumers (`src/commands/sessions.ts`, `src/commands/status.summary.ts`). Updated both consumers — the rename is semantically meaningful (communicates the fresh-read pattern).
- **Pre-existing test repair**: `run.overflow-compaction.test.ts` asserted `mockedRunEmbeddedAttempt` was called 32 times (pre-PR-9-Tier-1 floor). Bumped to 500 to match `MIN_RUN_RETRY_ITERATIONS`. Same root cause flagged in the side branch's wave-5 disclosure.

### New surface (post-integration)

- **Files added**: `src/agents/plan-mode/injections.ts` (+ `.test.ts`), `src/agents/plan-mode/accept-edits-gate.ts` (+ `.test.ts`)
- **Types added**: `PendingAgentInjectionKind`, `PendingAgentInjectionEntry`, `PostApprovalPermissions`
- **Fields added on `AgentRunContext`**: `lastSubagentSettledAt: number`, `getLatestAcceptEdits: () => boolean`
- **Public exports from `src/agents/plan-mode/index.ts`**: `buildAcceptEditsPlanInjection`, `appendToInjectionQueue`, `enqueuePendingAgentInjection`, `consumePendingAgentInjections`, `composePromptWithPendingInjections`, `SUBAGENT_SETTLE_GRACE_MS` (= 10_000), `MAX_CONCURRENT_SUBAGENTS_IN_PLAN_MODE` (= 1)
- **New error code**: `ErrorCodes.PLAN_APPROVAL_WAITING_FOR_SUBAGENT_SETTLE` — returned from `sessions.patch { planApproval: approve | edit }` with `details.retryAfterMs` when the user clicks approve within 10s of a subagent completion
- **New constants**: `POST_APPROVAL_ACK_ONLY_GRACE_MS` (= 5 \* 60_000), `MAX_QUEUE_SIZE` (= 10, oldest eviction with warn log), `DEFAULT_INJECTION_PRIORITY`

### Test coverage delta

| Suite                                  | Pre-integration | Post-integration |
| -------------------------------------- | --------------- | ---------------- |
| `injections.test.ts`                   | (didn't exist)  | 27 tests         |
| `accept-edits-gate.test.ts`            | (didn't exist)  | 44 tests         |
| `sessions-patch.subagent-gate.test.ts` | 7               | 15               |
| `sessions-spawn-tool.test.ts`          | 12              | 15               |
| `incomplete-turn.test.ts`              | 29              | 33               |
| `approval.test.ts`                     | 32              | 39               |
| **Total touched-surface**              | **~92**         | **~187 (+95)**   |

Plus existing `sessions-patch.test.ts` (43 tests, including the queue-migration test update where `entry.pendingAgentInjection === "[QUESTION_ANSWER]: ..."` is now `entry.pendingAgentInjections[0].text === "..."`).

### Deferred items (carried over from side branch's adversarial review)

All disclosed in the agent's [architectural walkthrough](https://github.com/openclaw/openclaw/pull/68939#issuecomment-4276170359); kept deferred here as follow-ups:

1. **Retry re-hydration on empty-response failure** (>100 LoC) — pending-injection consumer drains before the first attempt; empty-response retry has no context. Workaround today: post-approval ack-only grace covers the common failure mode.
2. **Shell-escape destructive bypass** (pattern-limited) — env-var indirection / concat / alias redefinition can slip past the acceptEdits destructive denylist; prompt layer remains primary defense.
3. **Double-approve on legacy-scalar upgrade** (<50% probability) — narrow scenario with bounded impact (duplicate "I'll execute..." ack, not broken state).
4. **approvalRunId persister silent-bypass** (<0.1% probability).
5. **Debug log multi-tag recording** (observability only).
6. **Bootstrap context truncation** (AGENTS.md/SOUL.md diet) — separate PR.

### Rollback escalation path

Per side-branch disclosure (still applies):

- Commit 70a6e4b23a (queue) regression → revert nuclear-fix stack; `pendingAgentInjection` legacy scalar path still works via the queue-shim's auto-migrate-on-first-read.
- Commit 7110953c0c (acceptEdits gate) false-positive → revert that commit only; `action: "edit"` falls back to approve-path semantics.
- Commit 436d308506 (subagent grace window) too strict → set `SUBAGENT_SETTLE_GRACE_MS = 0`; no revert needed.
- Full feature regression → `agents.defaults.planMode.enabled: false` short-circuits everything.
- Catastrophic failure → `git push --force-with-lease origin feat/plan-channel-parity-backup:feat/plan-channel-parity` restores pre-rebase HEAD `bee5e8c364`.

---

## Consolidation pass — 2026-04-19

After 3+ weeks of iter-1/iter-2/iter-3 hardening on `feat/plan-channel-parity`, the 10 individual PRs reviewed against stale base branches were **consolidated into a single umbrella PR rebased onto current upstream/main**.

### Why consolidate

- Branch was **734 commits behind** `upstream/main` and **135 commits ahead**
- Latest upstream tag `v2026.4.19-beta.2` had landed ~24h before the rebase
- Review bots (Greptile, Copilot, Codex) were comparing PRs against 3-week-old main snapshots: re-firing on resolved threads, suggesting "fixes" for patterns that already landed elsewhere, drowning real signal in noise
- 10 dependent PRs forced maintainers to load the dependency graph just to start review

### What was preserved

- **Full 135-commit history** (no squash — `git blame` and the iter-1/2/3 narrative both stay readable)
- **240+ resolved review threads** from the original 10 PRs (rationale lives in this doc + commit messages)
- **All test coverage** (200+ tests across the touched surface — 81 scoped tests verified passing post-rebase)
- **All architecture decisions** documented in this file (sections below stay authoritative)

### What was closed

| Original PR  | Action                                                          |
| ------------ | --------------------------------------------------------------- |
| PR-A #67512  | Closed → redirect comment pointing to #68939                    |
| PR-B #67514  | Closed → redirect comment pointing to #68939                    |
| PR-C #67534  | Closed → redirect comment pointing to #68939                    |
| PR-D #67538  | Closed → redirect comment pointing to #68939                    |
| PR-E #67541  | Closed → redirect comment pointing to #68939                    |
| PR-F #67542  | Closed → redirect comment pointing to #68939                    |
| PR-7 #67721  | Closed → redirect comment pointing to #68939                    |
| PR-8 #67840  | Closed → redirect comment pointing to #68939                    |
| PR-10 #68440 | Closed → redirect comment pointing to #68939                    |
| PR-11 #68441 | Closed → redirect comment pointing to #68939 (used same branch) |

### Rebase mechanics — only 5 actual conflicts in 134 commits

Audit before rebase confirmed upstream had **zero plan-mode commits in the gap**. All conflicts were incidental file overlaps:

| File                                           | Type                                  | Resolution                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/agents/system-prompt.ts`                  | Import-only                           | Take both sets                                                                                                                                   |
| `ui/src/ui/views/chat.ts`                      | Import-only                           | Take HEAD (`SubagentBlockingStatus` is a strict superset)                                                                                        |
| `src/plugin-sdk/telegram.ts`                   | Modify/delete (upstream restructured) | `git rm` — PR-14 Telegram visibility deferred until plan-archetype-bridge re-wires to the new SDK location                                       |
| `ui/src/ui/app-render.helpers.ts`              | Function-level                        | Delete 530 lines of duplicated `renderChatModelSelect` — upstream moved it to `session-controls.ts:82` and re-exports `renderChatThinkingSelect` |
| `src/agents/pi-embedded-runner/run/attempt.ts` | Bootstrap-context refactor            | Drop our duplicated bootstrap blocks (upstream owns lines 654+); preserve `planModeAppendPrompt` + add `planModeFeatureEnabled` declaration      |

### Post-rebase residual fixes (`01ed63633e`)

Two type errors surfaced after the rebase landed and were fixed in a follow-on commit on the rebased branch:

- **`src/agents/plan-mode/plan-archetype-bridge.ts`** — replaced the `sendDocumentTelegram` call with a deferred no-op + `void` discards on the unused `caption`/`absPath`/`parseTelegramThreadId`. Plan markdown still persists to `~/.openclaw/agents/<id>/plans/`; Telegram attachment delivery awaits the PR-14 re-wire follow-up.
- **`src/gateway/server-runtime-subscriptions.ts`** — removed the `params.minimalTestGateway` conditional (the param was renamed/dropped in upstream's restructure). Persister always starts; tests pass `emitSessionsChanged: () => {}` to suppress.

The `parseTelegramThreadId` helper is preserved as commented-out code in `plan-archetype-bridge.ts` so the PR-14 re-wire follow-up can resurrect the parsing logic without rewriting it.

### Umbrella PR #68939 status

- **Branch:** `feat/plan-channel-parity` @ `01ed63633e`
- **Diff vs upstream/main:** 135 commits, 145 files changed
- **Greptile review:** SKIPPED (hit 100-file ceiling — known limitation; not actionable)
- **Copilot review:** triggered via `@copilot please review` comment
- **CI:** parity gate IN_PROGRESS at write-time
- **Mergeable:** ✅ MERGEABLE per `gh pr view`

### Long-term follow-ups (deferred — out of consolidation scope)

- **PR-14 Telegram visibility re-wire** — `plan-archetype-bridge.ts` needs to call into the new `extensions/telegram/` SDK location once the upstream restructure is mapped
- **Bug B** — stale approval card UI auto-dismiss + `PLAN_APPROVAL_EXPIRED` error code (deferred since iter-2)
- **R1/R2/R3/R4/R5** — robustness fixes (subagent cleanup on crash, cron-nudge suppression, plan title XSS audit, disk-full graceful, multi-channel approval dedup) (deferred since iter-3)
- **D5** — `/plan self-test` slash command (deferred since iter-3)

These do NOT block the umbrella PR landing. They land as follow-on commits on `feat/plan-channel-parity` after #68939 merges.

---

## Live testing iteration 1 — fixes (latest sprint)

Live webchat testing of the `9fb82673ac` build surfaced 4 issues. All fixed in the next commit on `feat/plan-channel-parity`:

| Bug | Surface                                     | Root cause                                                                                                                                                                                                                                                        | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Synthetic message tagging                   | 5 retry constants in `incomplete-turn.ts` and the plan-nudge wake-up in `plan-nudge-crons.ts` lacked the `[PLAN_*]:` prefix that `[PLAN_DECISION]:` / `[QUESTION_ANSWER]:` / `[PLAN_COMPLETE]:` already used                                                      | Prefixed: `[PLAN_ACK_ONLY]:`, `[PLAN_YIELD]:`, `[PLAN_NUDGE]:`, `[PLANNING_RETRY]:` — sets up a future PR to hide them from user-visible chat with a single regex                                                                                                                                                                                                                                                                                                                                             |
| 2   | Plan side panel header showed "Active plan" | `SessionEntry.planMode` had NO `title` field; `exit_plan_mode` carried it transiently in event payload but persister never captured it. UI fell back to a generic label                                                                                           | Added `planMode.title` + `planMode.approvalRunId` to `SessionEntry`. Persister captures from `agent_approval_event`. UI `buildPlanViewMarkdown` accepts `title` param + 3 call sites read `row.planMode.title`. Pre-`exit_plan_mode` shows `(planning)` honest signal                                                                                                                                                                                                                                         |
| 3   | Approve race when subagents in flight       | `sessions-patch.ts:572` approval handler had NO subagent check. If subagent return drained `openSubagentRunIds` between two `exit_plan_mode` retries, approval card showed; a NEW subagent during the user's approval window bypassed the tool-side gate entirely | Server: approval handler reads `getAgentRunContext(approvalRunId).openSubagentRunIds`, throws `PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS` (new ErrorCode) if non-empty for `approve`/`edit` (`reject` not gated). UI: catches the code, restores card + sets `subagentBlockingStatus` for a bottom-of-chat toast (mirrors `FallbackStatus` pattern at `chat.ts:renderFallbackIndicator`)                                                                                                                             |
| 4   | No way to debug plan-mode lifecycle live    | Sparse logs across `[gateway]` / `[agent/embedded]` / `[plugins]` made plan-mode debugging require manual run-id correlation across multiple files                                                                                                                | New `src/agents/plan-mode/plan-mode-debug-log.ts` helper + `OPENCLAW_DEBUG_PLAN_MODE=1` env-var gate. Discriminated event union: state_transition, gate_decision, tool_call, synthetic_injection, nudge_event, subagent_event, approval_event, toast_event. Instrumented at sessions-patch (state transitions + approval gates), exit-plan-mode-tool (gate decisions), plan-snapshot-persister (tool_call). Events tagged `[plan-mode/<kind>]` for `tail -F gateway.err.log \| grep '\[plan-mode/'` debugging |

**Activation for live debug session:**

```bash
OPENCLAW_DEBUG_PLAN_MODE=1 launchctl kickstart -k gui/$UID/ai.openclaw.gateway
tail -F ~/.openclaw/logs/gateway.err.log | grep '\[plan-mode/'
```

**Test coverage added:** 7 tests in `sessions-patch.subagent-gate.test.ts`, 12 tests in `plan-mode-debug-log.test.ts`. Pre-existing test suites (`incomplete-turn`, `mutation-gate`, `exit-plan-mode-tool`, `fresh-session-entry`) all still pass after the prefix changes (constants are imported by reference, not literal-asserted).

---

## Live testing iteration 3 — self-discovery + R6 subagent gate hardening (latest sprint)

Iter-3 closes the meta-gap surfaced by the user: "will plan mode work reliably for ANY install, on ANY agent, including agents that just installed the patch and have never seen plan mode before?" Plus a deeper subagent-gate race (R6) that survived iter-1's tool-side gate.

### Phase 1 — Self-discovery (commit `c262bffcbf`)

| #   | Surface                            | What changed                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | In-mode bootstrap reference card   | New `src/agents/plan-mode/reference-card.ts` injected on every plan-mode turn alongside `PLAN_ARCHETYPE_PROMPT`. ASCII state diagram + tool contract + `[PLAN_*]:` tag taxonomy + `/plan` slash commands + pitfalls + debug tips. Eliminates the iter-2 "2-turn learning curve"                                      |
| D2  | One-shot first-time intro          | `[PLAN_MODE_INTRO]:` synthetic injection on the very first `enter_plan_mode` per session (gated by new `SessionEntry.planModeIntroDeliveredAt` marker at root level). Agent's NEXT turn opens with quick lifecycle overview + pointer to `/plan self-test`. Composes with existing `pendingAgentInjection` consumers |
| D3  | Tool-description discovery pointer | All 3 plan-mode tool descriptions (`enter_plan_mode`, `update_plan`, `exit_plan_mode`) end with: "see the bootstrap-injected reference card OR run `/plan self-test`."                                                                                                                                               |
| D4  | User-facing concept doc            | New `docs/concepts/plan-mode.md` — when to use, lifecycle, slash commands, multi-channel, persistence, auto-mode, subagent gating, troubleshooting                                                                                                                                                                   |
| D7  | `plan-mode-101` skill              | New `skills/plan-mode-101/SKILL.md` — same content as the in-mode reference card, available on-demand in normal mode via trigger phrases ("explain plan mode", "what does [PLAN_DECISION] mean", etc.)                                                                                                               |

### Phase 2/3 — R6 subagent gate hardening + D6 introspection tool (commit pending)

| #   | Bug/Deliverable                                                                                                                          | Symptom                                                                                                                                                                                                                                                                               | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6a | Tool-side subagent gate at `exit_plan_mode` silently bypassed                                                                            | Live test 17:10-17:12: subagent `a1dc12d2` was running when agent called `exit_plan_mode`; gate didn't fire (silent bypass — likely race: subagent drained before tool ran, OR runId/ctx missing). User clicked Approve, agent stalled because subagent return arrived AFTER approval | Always-on `agents/exit-plan-gate` diagnostic logger emits `gate decision: result=blocked\|allowed runId=… sessionKey=… openSubagents=N reason=…` for EVERY `exit_plan_mode` call. Bypass cases (no runId, ctx not registered, openSubagentRunIds undefined) now emit explicit reason strings so operators can tell why the gate didn't fire. Operator can grep `agents/exit-plan-gate` in `gateway.err.log` to see every submission attempt                                   |
| R6b | Subagent announce-turn injection said "narrate the result" — agent treated the turn as TERMINAL and stopped, breaking the plan-mode flow | The announce reply instruction at `subagent-announce.ts:buildAnnounceReplyInstruction` told the agent "send that user-facing update now." Agent narrated the subagent result and stopped instead of calling `exit_plan_mode` after incorporating the result. Plan-mode cycle stalled  | The instruction is now plan-mode-aware: when the requester session's `planMode.mode === "plan"`, an explicit suffix is appended: "You are currently in PLAN MODE — do not stop after the user-facing update. Your next action MUST be either (a) call `exit_plan_mode(...)` if this subagent's result completes your investigation, OR (b) continue investigation with another tool call." Read at announce-build time from `loadRequesterSessionEntry`'s entry.planMode.mode |
| D6  | No agent-callable introspection of plan-mode state                                                                                       | Agent had to INFER plan-mode state from tool-rejection errors. No way to programmatically check `am I in plan mode?` / `what's the title?` / `how many subagents are in flight?` / `is debug log enabled?`                                                                            | New `plan_mode_status` tool (`src/agents/tools/plan-mode-status-tool.ts`) — read-only structured snapshot of every plan-mode field, plus the debug-log status. Self-resolves storePath via `resolveDefaultSessionStorePath` so it works without registry plumbing. Wired into the bundled toolset alongside `enter_plan_mode` / `exit_plan_mode` / `ask_user_question`                                                                                                        |

**Activation (already in place from iter-2):**

```bash
openclaw config set agents.defaults.planMode.debug true
launchctl kickstart -k gui/$UID/ai.openclaw.gateway

# Tail BOTH the env-gated structured stream AND the iter-3 always-on
# exit-plan-gate diagnostic in one tail:
tail -F ~/.openclaw/logs/gateway.err.log | grep -E '\[plan-mode/|plan-approval-gate|exit-plan-gate'
```

### Deferred to iter-3 commit 3 (next focused commit)

- **D5 — `/plan self-test` slash command** (synthetic plan-mode flow + pass/fail report)
- **R1 — Subagent cleanup on crash/timeout** (drain `openSubagentRunIds` on error paths)
- **R2 — Cron-nudge suppression when approval pending** (heartbeat path already does this via `buildActivePlanNudge:742`; cron-fire path needs same check)
- **R3 — Plan title XSS sanitization audit + test**
- **R4 — Disk-full graceful error in `sessions-patch.ts`**
- **R5 — Multi-channel approval dedup test**
- **Bug B (still deferred from iter-2)** — stale approval card UI auto-dismiss + `PLAN_APPROVAL_EXPIRED` error code

---

## Live testing iteration 2 — fixes (previous sprint)

Live webchat testing of the iter-1 build (commit `3024c6b215`) on 2026-04-19 surfaced 6 deeper edge cases. All addressed in the next commit on `feat/plan-channel-parity`:

| Bug | Symptom                                                                                                                                                                                               | Root cause                                                                                                                                                                                                                          | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Click "Approve" → agent's next turn fires `[PLAN_ACK_ONLY]` retries; mutation gate blocks `write` AFTER approval landed                                                                               | `sessions-patch.ts:751` DELETES `planMode` entirely on approve/edit (when no `autoApprove`); `getLatestPlanMode` returned `undefined` for that case; consumers fell back to stale "plan" cached snapshot via `?? args.ctx.planMode` | Added `resolveLatestPlanModeFromDisk` helper in `fresh-session-entry.ts` returning `"normal"` for the deletion case (deletion-as-normal contract). Updated both `getLatestPlanMode` callbacks in `agent-runner-execution.ts` to use it. Hardened consumers in `pi-tools.before-tool-call.ts:230` and `run.ts:1834` to prefer the helper's value (only fall back to cached snapshot when helper returns `undefined` from a true disk failure) |
| B   | (deferred) Stale approval card after planMode auto-cleared; double-popup; "planApproval requires an active plan-mode session" error after waiting                                                     | Server: `sessions-patch.ts:751` deletes planMode without checking `approval === "pending"`. UI: `app.ts` doesn't subscribe to "planMode went away" events to dismiss stale cards                                                    | Deferred to Phase 2 (next commit) — needs UI subscription model + new `PLAN_APPROVAL_EXPIRED` error code                                                                                                                                                                                                                                                                                                                                     |
| C   | Subagent-during-approve toast didn't visibly fire even when gate should have triggered                                                                                                                | Could not distinguish "gate didn't fire" vs "gate fired silently" vs "toast rendered but invisible" without server-side log                                                                                                         | Added always-on `gateway/plan-approval-gate` logger emitting `gate decision: action=approve sessionKey=… approvalRunId=… openSubagents=N result=blocked\|allowed` on every approve/edit. Also logs `gate disabled: …` when `approvalRunId` not persisted (Bug 2 wiring failure)                                                                                                                                                              |
| D   | `OPENCLAW_DEBUG_PLAN_MODE=1` set via `launchctl setenv` produced ZERO `[plan-mode/...]` lines in the test window                                                                                      | macOS `launchctl setenv` only affects FUTURE launchd-spawned processes, not running children of the OpenClaw Mac app                                                                                                                | Added config-flag path: `agents.defaults.planMode.debug: true`. Helper now reads BOTH env var and config (env wins). Set via `openclaw config set agents.defaults.planMode.debug true` then restart gateway                                                                                                                                                                                                                                  |
| E   | Agent received TWO different `[PLAN_DECISION]` formats — block format on rejection (`[PLAN_DECISION]\ndecision: rejected\n…\n[/PLAN_DECISION]`) vs one-line on approval (`[PLAN_DECISION]: approved`) | Two emission sites: `types.ts:buildPlanDecisionInjection` (block) for reject/timeout vs `sessions-patch.ts:606` (one-line) for approve/edit                                                                                         | Unified on one-line opener (`[PLAN_DECISION]: <decision>`) in `types.ts`. Adversarial-feedback sanitization preserved (closing-marker neutralization still active for defense-in-depth)                                                                                                                                                                                                                                                      |
| F   | Agent demonstrably misused tools: posted chat after `exit_plan_mode` (Bug A trigger), confused `update_plan` vs `exit_plan_mode`, read multi-MB logs from line 1                                      | Tool descriptions said WHAT but not WHEN/HOW; system prompt had no log-triage rule and no "stop after exit_plan_mode" rule                                                                                                          | Updated `describeExitPlanModeTool` (STOP-AFTER-TOOL-CALL as first line), `describeUpdatePlanTool` (TRACKING-ONLY clarification), `describeEnterPlanModeTool` (lifecycle 1-2-3-after pattern). Updated `attempt.ts:549-557` with log-triage hygiene rule + explicit "no chat after exit_plan_mode" reminder                                                                                                                                   |

**Test coverage added:** 8 tests in `fresh-session-entry.test.ts` (deletion-as-normal contract), 5 tests in `plan-mode-debug-log.test.ts` (config-flag gate), 6 tests in `approval.test.ts` (one-line format).

**Activation for live debug session (iter-2 path — RELIABLE on macOS):**

```bash
openclaw config set agents.defaults.planMode.debug true
launchctl kickstart -k gui/$UID/ai.openclaw.gateway

# Tail with the right filter
tail -F ~/.openclaw/logs/gateway.err.log | grep -E '\[plan-mode/|gate decision'
```

The `gate decision` filter catches the always-on Bug C log lines even when the env-gated `[plan-mode/...]` debug stream is off.

---

## 1. The 10-PR series — historical (all closed; consolidated into umbrella PR #68939)

> **STATUS:** All 10 PRs below were closed on 2026-04-19 in favor of the consolidated umbrella PR **#68939** (rebased onto upstream/main @ `v2026.4.19-beta.2`). See the "Consolidation pass — 2026-04-19" section above for the rationale. Table preserved for historical context — `git blame` and the iter-1/2/3 narrative still map back to these PR boundaries.

| Sprint    | Upstream PR                                               | Local branch                            | Latest head  | Net-new files                | Mergeable    | Final status                                                                              |
| --------- | --------------------------------------------------------- | --------------------------------------- | ------------ | ---------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| **PR-A**  | [#67512](https://github.com/openclaw/openclaw/pull/67512) | `final-sprint/gpt5-openai-prompt-stack` | `96e58ceedb` | 6                            | ⚠️ CONFLICTS | **closed (consolidated into #68939)** — 16 historical threads                             |
| **PR-B**  | [#67514](https://github.com/openclaw/openclaw/pull/67514) | `final-sprint/gpt5-task-system-parity`  | `c192d9ff49` | 8                            | ✅           | **closed (consolidated into #68939)** — 10 historical threads                             |
| **PR-C**  | [#67534](https://github.com/openclaw/openclaw/pull/67534) | `phase3/plan-rendering`                 | `6069a036fe` | 2                            | ✅           | **closed (consolidated into #68939)** — 14 historical threads                             |
| **PR-D**  | [#67538](https://github.com/openclaw/openclaw/pull/67538) | `phase3/plan-mode`                      | `4a3ddb98bc` | 29                           | ✅           | **closed (consolidated into #68939)** — 29 historical threads                             |
| **PR-E**  | [#67541](https://github.com/openclaw/openclaw/pull/67541) | `phase4/skill-plan-templates`           | `780aced7d2` | 11                           | ✅           | **closed (consolidated into #68939)** — 16 historical threads                             |
| **PR-F**  | [#67542](https://github.com/openclaw/openclaw/pull/67542) | `phase4/cross-session-plans`            | `689efe253b` | 2                            | ✅           | **closed (consolidated into #68939)** — 20 historical threads                             |
| **PR-7**  | [#67721](https://github.com/openclaw/openclaw/pull/67721) | `feat/ui-mode-switcher-plan-cards`      | `fb5a7fa05e` | 16                           | ❓           | **closed (consolidated into #68939)** — 49 historical threads                             |
| **PR-8**  | [#67840](https://github.com/openclaw/openclaw/pull/67840) | `feat/plan-mode-integration`            | `f866dfbb3c` | 39                           | ⚠️ CONFLICTS | **closed (consolidated into #68939)** — 41 historical threads                             |
| **PR-10** | [#68440](https://github.com/openclaw/openclaw/pull/68440) | `feat/plan-archetype-and-questions`     | `1bf9d7b4e7` | 115 cumulative / ~25 net-new | ❓           | **closed (consolidated into #68939)** — pass-1 + pass-2 complete pre-consolidation        |
| **PR-11** | [#68441](https://github.com/openclaw/openclaw/pull/68441) | `feat/plan-channel-parity`              | `ef56f0f2cf` | 127 cumulative / 32 net-new  | ⚠️ CONFLICTS | **closed (consolidated into #68939)** — was the live cumulative branch (rebased + reused) |

(PR-9, PR-12, PR-13, PR-14 are internal sprint commits riding on `feat/plan-channel-parity` and ride along with the umbrella PR.)

### PR-11 escalation cluster — pending maintainer decision

Four threads on PR-11 share the same root cause: post-approval/answer state transitions on `sessions.patch` clear runtime fields needed downstream. See escalation comment #68441 (issuecomment-4273877823). Decision needed:

- **`/plan answer` synthetic-message injection in non-webchat channels** (3 threads: #3105216364, #3105247854, #3105261556) — caller-side per-channel vs gateway-side single source of truth vs won't-fix-this-PR.
- **Post-approval yield retry detection** (1 thread: #3105311664 from re-review) — `resolveYieldDuringApprovedPlanInstruction` predicates unreachable because `planMode → "normal"` clears state. Same root cause cluster.

### "Too many files" structural issue

PR-11's diff vs `upstream/main` is 127 files because the branch was built sequentially on top of every prior PR. Greptile's 100-file review cap and Copilot's 127-of-126-files-reviewed apply to the cumulative diff, not PR-11's true scope (32 net-new files / 2,965 LoC since PR-10's branch tip).

**Resolution path:** land PRs in dependency order so each subsequent PR's diff naturally shrinks. Closing/reopening with main-rebased branches would lose review history without solving the underlying structural cumulative-rollout pattern.

---

## 2. Architecture — how the pieces fit together

### Layer 1: Renderer + parity (independent foundations)

```
┌─────────────────────────────┐  ┌─────────────────────────────┐  ┌───────────────────────────┐
│  PR-A (#67512)              │  │  PR-B (#67514)              │  │  PR-C (#67534)            │
│  GPT-5.4 prompt + injection │  │  Task system parity         │  │  Plan checklist renderer  │
│  scanner                    │  │  (cancelled status, merge,  │  │  (4 formats: html,        │
│                             │  │  activeForm, hydration)     │  │  markdown, plaintext,     │
│                             │  │                             │  │  slack-mrkdwn)            │
│  Files: 6                   │  │  Files: 8                   │  │  Files: 2                 │
└─────────────────────────────┘  └─────────────────────────────┘  └───────────────────────────┘
   independent                       PR-E depends on this              PR-D + PR-7 depend
```

### Layer 2: Plan-mode runtime + storage

```
┌─────────────────────────────┐  ┌─────────────────────────────┐  ┌───────────────────────────┐
│  PR-D (#67538)              │  │  PR-F (#67542)              │  │  PR-E (#67541)            │
│  Plan-mode runtime library  │  │  Cross-session plan store   │  │  Skill plan templates     │
│  (mutation gate, escalating │  │  (file-locking, security    │  │  (skill-driven planning)  │
│  retry, auto-continue)      │  │  hardened)                  │  │                           │
│                             │  │                             │  │  depends on PR-B          │
│  Files: 18                  │  │  Files: 2                   │  │  Files: 11                │
└─────────────────────────────┘  └─────────────────────────────┘  └───────────────────────────┘
```

### Layer 3: UI + integration

```
┌─────────────────────────────┐  ┌─────────────────────────────────────┐
│  PR-7 (#67721)              │  │  PR-8 (#67840)                      │
│  UI mode switcher chip +    │  │  Plan-mode integration bridge       │
│  clickable plan cards       │  │  - register enter_plan_mode +       │
│                             │  │    exit_plan_mode tools             │
│  depends on PR-C            │  │  - mutation gate hook in            │
│  Files: 16                  │  │    pi-tools.before-tool-call        │
│                             │  │  - sessions.patch planMode field    │
│                             │  │  - plan approval reply dispatch     │
│                             │  │                                     │
│                             │  │  depends on PR-D + PR-7             │
│                             │  │  Files: 39                          │
└─────────────────────────────┘  └─────────────────────────────────────┘
```

### Layer 4: User-facing features

```
┌─────────────────────────────────┐  ┌─────────────────────────────────┐
│  PR-10 (#68440)                 │  │  PR-11 (#68441)                 │
│  Plan archetype + ask_user_     │  │  Universal /plan slash commands │
│  question + auto mode           │  │  across ALL channels            │
│                                 │  │                                 │
│  - exit_plan_mode adds title +  │  │  - /plan accept | accept edits  │
│    analysis + assumptions +     │  │    | revise <feedback>          │
│    risks + verification +       │  │    | answer <text> | restate    │
│    references                   │  │    | auto on|off | on|off       │
│  - PLAN_ARCHETYPE_PROMPT        │  │    | status | view              │
│    system fragment              │  │  - works on Telegram, Discord,  │
│  - ask_user_question tool       │  │    Signal, iMessage, Slack,     │
│    (multi-choice + free-text)   │  │    Matrix, IRC, web, CLI, etc   │
│  - Plan ⚡ chip + /plan auto    │  │                                 │
│  - autoApprove flag persisted   │  │  +PR-12 cron-nudge fixes        │
│  - 5 deep-dive review fixes     │  │  +PR-13 vertical question       │
│                                 │  │   layout + inline Other         │
│  depends on PR-8                │  │  +PR-14 Telegram .md attachment │
│  Files: 25 net-new              │  │  +6 deep-dive review fixes      │
│                                 │  │  +13 review-loop pass 1 fixes   │
│                                 │  │                                 │
│                                 │  │  depends on PR-10               │
│                                 │  │  Files: 32 net-new              │
└─────────────────────────────────┘  └─────────────────────────────────┘
```

### Dependency graph (landing order)

```
                    ┌──────────────┐
                    │   main       │
                    └───┬───┬───┬──┘
                        │   │   │
        ┌───────────────┼───┼───┼────────────┐
        │       ┌───────┼───┘   └────┐       │
        │       │       │            │       │
       PR-A   PR-B    PR-C         PR-F    PR-7
       (#67512)(#67514)(#67534)    (#67542)(#67721)
        │       │       │            │       │
        │       │       │            │       │
        │       │       └─→ PR-D    │       │
        │       │       ┌─ (#67538)  │       │
        │       │       │            │       │
        │       └─→ PR-E│            │       │
        │           (#67541)         │       │
        │                            │       │
        │                            └───────┴──→ PR-8
        │                                        (#67840)
        │                                            │
        │                                            ▼
        │                                          PR-10
        │                                         (#68440)
        │                                            │
        │                                            ▼
        │                                          PR-11
        │                                         (#68441)
        │                                            ▲
        └───── (independent — lands any time) ──────┘
```

**Recommended landing waves:**

1. **Wave 1** (independent, no plan-mode deps): PR-B, PR-C, PR-F, PR-A
2. **Wave 2** (depend on wave 1): PR-E (after PR-B), PR-D (after PR-C)
3. **Wave 3** (co-merge — each is dead code alone): PR-7 + PR-8
4. **Wave 4**: PR-10 (after PR-8)
5. **Wave 5**: PR-11 (after PR-10)

Co-merge guidance: PR-7, PR-8 land in one merge window. Otherwise main carries dead code.

---

## 3. Feature behavior

### Plan mode lifecycle

```
[Idle] ──/plan on──→ [Plan: none] ──exit_plan_mode──→ [Plan: pending]
                          │                                  │
                          │                          ┌───────┼────────┐
                          │                          │       │        │
                       /plan off                  approve  edit    reject
                          │                          │       │   /plan revise
                          │                          ▼       ▼        │
                          │                       [Normal — mutations │
                          ▼                        unlocked]          ▼
                       [Idle]                                    [Plan: rejected
                                                                  (rejectionCount++)]
                                                                       │
                                                                  exit_plan_mode
                                                                       ▼
                                                                  [Plan: pending]
```

### Mutation gate (PR-D + PR-8 + PR-10/11 hardening)

When `planMode.mode === "plan"`:

- **Blocked tools** (default-deny + explicit blocklist): `apply_patch`, `bash`, `edit`, `exec` (unless read-only prefix), `gateway`, `message`, `nodes`, `process`, `sessions_send`, `subagents`, `write`
- **Allowed tools**: `read`, `web_search`, `web_fetch`, `memory_search`, `memory_get`, `update_plan`, `exit_plan_mode`, `enter_plan_mode`, `session_status`, `ask_user_question`, `sessions_spawn`
- **Read-only exec prefixes**: `ls`, `cat`, `pwd`, `git status|log|diff|show`, `which`, `find`, `grep`, `rg`, `head`, `tail`, `wc`, `file`, `stat`, `du`, `df`, `echo`, `printenv`, `whoami`, `hostname`, `uname`

**Critical PR-11 review fix**: `agent-runner-execution.ts` now threads `planMode: "plan"` into `runEmbeddedPiAgent`. Pre-fix the gate never activated from the auto-reply path.

### Auto-mode (PR-10)

`SessionEntry.planMode.autoApprove === true` → after every `exit_plan_mode`, `autoApproveIfEnabled` fires `sessions.patch { planApproval: { action: "approve", approvalId }}` immediately. Flag preserved across approve/edit/normal transitions.

### Universal `/plan` slash commands (PR-11)

| Subcommand                | Action                             | Backend route                                           |
| ------------------------- | ---------------------------------- | ------------------------------------------------------- |
| `/plan accept`            | approve current pending plan       | `sessions.patch { planApproval: { action: "approve" }}` |
| `/plan accept edits`      | approve with allow-edits           | `action: "edit"`                                        |
| `/plan revise <feedback>` | reject + provide feedback          | `action: "reject", feedback`                            |
| `/plan answer <text>`     | answer ask_user_question           | `action: "answer", answer`                              |
| `/plan auto on\|off`      | toggle autoApprove                 | `action: "auto", autoEnabled`                           |
| `/plan on\|off`           | enter/exit plan mode               | `planMode: "plan"\|"normal"`                            |
| `/plan status`            | show current state (read-only)     | (no patch)                                              |
| `/plan view`              | toggle UI sidebar (web only)       | (no patch)                                              |
| `/plan restate`           | re-render plan in chat / send file | (no patch)                                              |

### Telegram visibility (PR-14)

- Every `exit_plan_mode` → render full archetype as markdown → persist to `~/.openclaw/agents/<id>/plans/plan-YYYY-MM-DD-<slug>.md` (always, audit artifact)
- If session originated from Telegram → also send the .md file as a document attachment with caption containing universal `/plan` resolution commands
- Resolution stays text-based via PR-11's slash commands (sidesteps dual approval-id problem)
- Multi-cycle: collision suffix `-2.md`, `-3.md`, … preserves rejection-revise history

### Plan-nudge crons (PR-9 + PR-12 fixes)

Scheduled at 10/30/60 min after `enter_plan_mode` to prompt the agent if it stalls. Suppressed when:

- `planMode.approval === "pending"` (don't clobber pending approval popup)
- Agent active in last 5 min (`Date.now() - planMode.updatedAt < 5min`)
- Cleaned up on EVERY plan-mode close (approve/reject/edit/off/close-on-complete) to prevent orphan accumulation

---

## 4. Critical files reference

| Surface                              | File                                                                          | Owner PR                    |
| ------------------------------------ | ----------------------------------------------------------------------------- | --------------------------- |
| Plan checklist renderer (4 formats)  | `src/agents/plan-render.ts`                                                   | PR-C                        |
| Plan archetype markdown render       | `src/agents/plan-render.ts` (`renderFullPlanArchetypeMarkdown`)               | PR-14                       |
| Mutation gate                        | `src/agents/plan-mode/mutation-gate.ts`                                       | PR-D                        |
| Plan-mode runtime + retry            | `src/agents/pi-embedded-runner/run/incomplete-turn.ts`                        | PR-D                        |
| Cross-session plan store (file lock) | `src/agents/plan-store.ts`                                                    | PR-F                        |
| Skill plan templates                 | `src/agents/skills/skill-planner.ts`                                          | PR-E                        |
| Task parity + merge                  | `src/agents/tools/update-plan-tool.ts`                                        | PR-B                        |
| Plan archetype prompt                | `src/agents/plan-mode/plan-archetype-prompt.ts`                               | PR-10                       |
| Plan filename helpers                | `src/agents/plan-mode/plan-archetype-prompt.ts` (`buildPlanFilename`)         | PR-10                       |
| Plan markdown persist                | `src/agents/plan-mode/plan-archetype-persist.ts`                              | PR-14                       |
| Plan-mode → channel bridge           | `src/agents/plan-mode/plan-archetype-bridge.ts`                               | PR-14                       |
| `enter_plan_mode` tool               | `src/agents/tools/enter-plan-mode-tool.ts`                                    | PR-8                        |
| `exit_plan_mode` tool                | `src/agents/tools/exit-plan-mode-tool.ts`                                     | PR-8/PR-10                  |
| `ask_user_question` tool             | `src/agents/tools/ask-user-question-tool.ts`                                  | PR-10                       |
| Universal `/plan` handler            | `src/auto-reply/reply/commands-plan.ts`                                       | PR-11                       |
| Webchat `/plan` executor             | `ui/src/ui/chat/slash-command-executor.ts`                                    | PR-11                       |
| Mode switcher chip + Plan ⚡         | `ui/src/ui/chat/mode-switcher.ts`                                             | PR-7/PR-10                  |
| Inline approval card + question      | `ui/src/ui/views/plan-approval-inline.ts`                                     | PR-7/PR-10/PR-13            |
| Sessions patch planApproval routing  | `src/gateway/sessions-patch.ts`                                               | PR-8 + cumulative hardening |
| Plan snapshot persister              | `src/gateway/plan-snapshot-persister.ts`                                      | PR-8                        |
| Auto-approve runtime                 | `src/agents/pi-embedded-subscribe.handlers.tools.ts` (`autoApproveIfEnabled`) | PR-10                       |
| Plan archetype bridge from runtime   | `src/agents/pi-embedded-subscribe.handlers.tools.ts` (insertion at line 1659) | PR-14                       |
| Telegram document send               | `extensions/telegram/src/send.ts` (`sendDocumentTelegram`)                    | PR-14                       |
| GPT-5.4 friendly overlay             | `extensions/openai/prompt-overlay.ts` (`OPENAI_FRIENDLY_PROMPT_OVERLAY`)      | PR-A                        |
| Context-file injection scanner       | `src/agents/context-file-injection-scan.ts`                                   | PR-A                        |

---

## 5. Hardening status (review pass tracking) — historical (per-PR; superseded by umbrella PR review state)

> **STATUS:** The per-PR pass-tracking below is historical. After consolidation (2026-04-19), all bot review work happens on **umbrella PR #68939**. The 10-PR review history is preserved here so reviewers can see what was already addressed before consolidation.

| PR                    | Pass 1                                                                                          | Pass 2     | Bots re-triggered               | Final status                              |
| --------------------- | ----------------------------------------------------------------------------------------------- | ---------- | ------------------------------- | ----------------------------------------- |
| #67512                | ⏳ pending pre-consolidation                                                                    | n/a        | n/a                             | closed (consolidated #68939)              |
| #67514                | ⏳ pending pre-consolidation                                                                    | n/a        | n/a                             | closed (consolidated #68939)              |
| #67534                | ⏳ pending pre-consolidation                                                                    | n/a        | n/a                             | closed (consolidated #68939)              |
| #67538                | ⏳ pending pre-consolidation                                                                    | n/a        | n/a                             | closed (consolidated #68939)              |
| #67541                | ⏳ pending pre-consolidation                                                                    | n/a        | n/a                             | closed (consolidated #68939)              |
| #67542                | ⏳ pending pre-consolidation                                                                    | n/a        | n/a                             | closed (consolidated #68939)              |
| #67721                | ⏳ pending pre-consolidation                                                                    | n/a        | n/a                             | closed (consolidated #68939)              |
| #67840                | ⏳ pending pre-consolidation                                                                    | n/a        | n/a                             | closed (consolidated #68939)              |
| #68440                | ✅ done (9/10 fixed, 1 escalated → resolved this iteration)                                     | ⏳ pending | @-mentioned                     | closed (consolidated #68939)              |
| #68441                | ✅ done (13/13 fixed)                                                                           | ⏳ pending | @-mentioned                     | closed (consolidated #68939)              |
| **#68939 (umbrella)** | 🚦 first wave triggered (Copilot @-mentioned; Greptile hit 100-file ceiling — known limitation) | ⏳ pending | initial fire post-consolidation | **OPEN** (rebased on `v2026.4.19-beta.2`) |

### Escalated comment resolution (this iteration)

**#68440 #3104743333 (Codex P2 — `app-tool-stream.ts:519` — sidebar refresh in update_plan merge mode)**: User chose "best long-term hardened solution" — picked option (c) re-emit merged steps via the existing `agent_plan_event` channel. Lowest perf overhead (no hot-path SessionEntry read), no new event type (channel already exists), and persister already does the same thing for plan-snapshot work. Implementation: in `update-plan-tool.ts` after merge, fire `emitAgentPlanEvent({ phase: "update", steps: mergedPlan, runId })`. UI subscribes to `stream: "plan"` events and refreshes from those.

---

## 6. Cron upstream conflict (#67807)

Upstream main merged `fix(cron): clean up deleteAfterRun direct deliveries (#67807)` since fork. Touches `src/cron/isolated-agent/delivery-dispatch.ts` ONLY. **No conflict** with PR-12 cron-nudge fix (different surfaces — PR-12 touched `sessions-patch.ts` + `heartbeat-runner.ts`).

---

## 7. Process going forward (clean baseline)

### Naming convention

- **Sprint #**: `PR-A` ... `PR-11` (chronological internal order)
- **Upstream #**: `#NNNNN` (GitHub PR number on upstream openclaw/openclaw)
- 1:1 mapping except PR-9/12/13/14 which are internal sprints riding on `feat/plan-channel-parity`

### Branch policy

- Local branches on `100yenadmin/openclaw-1` (fork) ONLY — never push to upstream
- Each PR's local branch is the head of the upstream cross-repo PR
- `feat/plan-channel-parity` is the LIVE branch (cumulative; what runs locally)
- Other 9 branches are individual PR scopes

### Push & install loop

1. Make changes
2. `pnpm format:fix && pnpm lint && pnpm tsgo` (only flag NEW errors; pre-existing baseline OK)
3. `pnpm test <touched-files>` (must pass)
4. `pnpm build && pnpm ui:build` (order matters — build wipes dist/)
5. `FAST_COMMIT=1 scripts/committer "msg" file...` (scope to changed files only)
6. `git push` to `origin/<branch>`
7. `npm install -g .` to update global CLI
8. `launchctl kickstart -k gui/$UID/ai.openclaw.gateway`
9. `openclaw status --probe` to confirm live

### Review-loop policy

- Use `pr-review-loop` skill on each PR
- 95% confidence threshold (stricter than skill default 70%)
- Don't change agent prompts — flag for user
- Multiple sprints (2-3) per PR for hardening
- Mark stale comments "no longer relevant" when fix already shipped on cumulative branch

### Verification gates (release-bar)

- All scoped tests pass
- Lint 0 errors
- Tsgo no new errors (baseline pre-existing OK)
- Build + UI build clean
- Live install smoke-tests cleanly via webchat + Telegram

---

## 8. Beta-readiness checklist

> **STATUS:** Updated for the consolidated umbrella PR #68939 path (post-2026-04-19 consolidation).

- [x] Live install on `c9287908eb` (PR-11 review pass 1, pre-consolidation)
- [x] PR-10 + PR-11 review pass 1 complete (pre-consolidation)
- [x] Rebase `feat/plan-channel-parity` onto `upstream/main` @ `v2026.4.19-beta.2` (5 conflicts resolved)
- [x] All 10 individual PRs closed with redirect comments to #68939
- [x] Umbrella PR #68939 opened from rebased branch
- [x] Backup branch `feat/plan-channel-parity-backup` pushed to origin at pre-rebase HEAD `bee5e8c364`
- [x] Architecture doc updated with consolidation status
- [ ] Initial Copilot review wave on #68939 triaged via `pr-review-loop` skill
- [ ] Address PR-14 Telegram visibility re-wire (deferred follow-up)
- [ ] Address Bug B + R1/R2/R3/R4/R5 + D5 (deferred follow-up commits on `feat/plan-channel-parity`)
- [ ] #68939 merged to upstream main
- [ ] Beta tag cut on upstream main
