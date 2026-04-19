# Plan-Mode Rollout — Architecture & Status

**Last updated:** live-test iteration 1 fixes complete on `feat/plan-channel-parity` (post `9fb82673ac`, see iteration-1 section below)
**Live install:** `OpenClaw 2026.4.15` from `feat/plan-channel-parity`
**Total PRs:** 10 (excluding deprecated #67518 Gemini)

This document is the **single source of truth** for the plan-mode rollout. It survives Claude Code session compactions and is referenced by the umbrella issue + every PR's series-overview comment.

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

## Live testing iteration 2 — fixes (latest sprint)

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

## 1. The 10-PR series

| Sprint    | Upstream PR                                               | Local branch                            | Latest head             | Net-new files                | Mergeable    | Pass-1 status                       | Pass-2 status                                        | Pass-3+ scope (next sprint)                                                             |
| --------- | --------------------------------------------------------- | --------------------------------------- | ----------------------- | ---------------------------- | ------------ | ----------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **PR-A**  | [#67512](https://github.com/openclaw/openclaw/pull/67512) | `final-sprint/gpt5-openai-prompt-stack` | `96e58ceedb`            | 6                            | ⚠️ CONFLICTS | not started — 16 unresolved threads | —                                                    | 2 REAL + 4 REAL-LARGE + 2 ESCALATE (security: regex flags + allowlist + multiline)      |
| **PR-B**  | [#67514](https://github.com/openclaw/openclaw/pull/67514) | `final-sprint/gpt5-task-system-parity`  | `c192d9ff49`            | 8                            | ✅           | not started — 10 unresolved threads | —                                                    | 3 REAL + 1 FIXED-IN-CUMULATIVE + 1 WONT-FIX                                             |
| **PR-C**  | [#67534](https://github.com/openclaw/openclaw/pull/67534) | `phase3/plan-rendering`                 | `6069a036fe`            | 2                            | ✅           | not started — 14 unresolved threads | —                                                    | 4 REAL + 3 REAL-LARGE + 1 ESCALATE (Slack escape alignment)                             |
| **PR-D**  | [#67538](https://github.com/openclaw/openclaw/pull/67538) | `phase3/plan-mode`                      | `4a3ddb98bc`            | 29                           | ✅           | not started — 29 unresolved threads | —                                                    | ~5 REAL (test inversion, find -fprint, approval state machine)                          |
| **PR-E**  | [#67541](https://github.com/openclaw/openclaw/pull/67541) | `phase4/skill-plan-templates`           | `780aced7d2`            | 11                           | ✅           | not started — 16 unresolved threads | —                                                    | ~3 REAL (docstring, test, snapshot fallback)                                            |
| **PR-F**  | [#67542](https://github.com/openclaw/openclaw/pull/67542) | `phase4/cross-session-plans`            | `689efe253b`            | 2                            | ✅           | not started — 20 unresolved threads | —                                                    | 1 FIXED + 6 REAL + 5 REAL-LARGE + 2 ESCALATE (security: PID liveness + symlink)         |
| **PR-7**  | [#67721](https://github.com/openclaw/openclaw/pull/67721) | `feat/ui-mode-switcher-plan-cards`      | `fb5a7fa05e`            | 16                           | ❓           | not started — 49 unresolved threads | —                                                    | 15 REAL + 8 FIXED + 4 WONT-FIX + 1 ESCALATE (i18n keyboard shortcuts)                   |
| **PR-8**  | [#67840](https://github.com/openclaw/openclaw/pull/67840) | `feat/plan-mode-integration`            | `f866dfbb3c`            | 39                           | ⚠️ CONFLICTS | not started — 41 unresolved threads | —                                                    | 12 REAL/REAL-LARGE + 4 ESCALATE (planMode threading, autoEnableFor wiring, schema gaps) |
| **PR-10** | [#68440](https://github.com/openclaw/openclaw/pull/68440) | `feat/plan-archetype-and-questions`     | `1bf9d7b4e7`            | 115 cumulative / ~25 net-new | ❓           | 9/10 fixed                          | **6/6 resolved** (`ef56f0f2cf`); **0 unresolved** ✅ | clean — ready for landing                                                               |
| **PR-11** | [#68441](https://github.com/openclaw/openclaw/pull/68441) | `feat/plan-channel-parity`              | **`ef56f0f2cf`** ← LIVE | 127 cumulative / 32 net-new  | ⚠️ CONFLICTS | 13/13 fixed                         | **2/5 resolved**, **3 escalated** (cross-component)  | needs maintainer decision on escalation cluster + main rebase                           |

(PR-9, PR-12, PR-13, PR-14 are internal sprint commits riding on `feat/plan-channel-parity`.)

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

## 5. Hardening status (review pass tracking)

| PR     | Pass 1                                                      | Pass 2     | Bots re-triggered | Status               |
| ------ | ----------------------------------------------------------- | ---------- | ----------------- | -------------------- |
| #67512 | ⏳ pending                                                  | ⏳ pending | ⏳ pending        | not started          |
| #67514 | ⏳ pending                                                  | ⏳ pending | ⏳ pending        | not started          |
| #67534 | ⏳ pending                                                  | ⏳ pending | ⏳ pending        | not started          |
| #67538 | ⏳ pending                                                  | ⏳ pending | ⏳ pending        | not started          |
| #67541 | ⏳ pending                                                  | ⏳ pending | ⏳ pending        | not started          |
| #67542 | ⏳ pending                                                  | ⏳ pending | ⏳ pending        | not started          |
| #67721 | ⏳ pending                                                  | ⏳ pending | ⏳ pending        | not started          |
| #67840 | ⏳ pending                                                  | ⏳ pending | ⏳ pending        | not started          |
| #68440 | ✅ done (9/10 fixed, 1 escalated → resolved this iteration) | ⏳ pending | @-mentioned       | live in `c9287908eb` |
| #68441 | ✅ done (13/13 fixed)                                       | ⏳ pending | @-mentioned       | live in `c9287908eb` |

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

- [x] Live install on `c9287908eb` (PR-11 review pass 1)
- [x] PR-10 + PR-11 review pass 1 complete
- [ ] PR-A through PR-8 review pass 1 (8 older PRs — unstarted)
- [ ] Pass 2 review across all PRs after bot re-trigger
- [ ] Conflict resolution: PR-A (#67512) vs main, PR-11 (#68441) vs main
- [ ] Wave 1 PRs (PR-B, PR-C, PR-F, PR-A) merged to upstream main
- [ ] Wave 2 PRs (PR-E, PR-D) merged to upstream main
- [ ] Wave 3 co-merge (PR-7 + PR-8) to upstream main
- [ ] PR-10 + PR-11 cumulative diff shrinks below Greptile 100-file cap
- [ ] PR-10 merged to upstream main
- [ ] PR-11 merged to upstream main
- [ ] Beta tag cut on upstream main
