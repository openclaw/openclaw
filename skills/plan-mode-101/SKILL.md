---
name: plan-mode-101
description: Plan mode reference + self-test for OpenClaw. Use when the user asks how plan mode works, when to enter or exit, why a tool was blocked in plan mode, what `[PLAN_DECISION]` / `[QUESTION_ANSWER]` / `[PLAN_NUDGE]` and other `[PLAN_*]` tags mean, what `/plan` slash commands do, or to verify the local install end-to-end. Trigger phrases include "explain plan mode", "test plan mode", "plan mode help", "why was my tool blocked in plan mode", "what does [PLAN_DECISION] mean", "how do I approve a plan", "what does /plan accept do".
---

# Plan Mode 101

Plan mode is OpenClaw's user-approval-gated workflow for non-trivial multi-step changes. The agent investigates read-only, drafts a plan, submits it for user approval, and executes only after the user clicks Approve. Mutating tools (write / edit / exec / bash) are BLOCKED until approval lands.

## State diagram

```
┌──────────────────┐
│   NORMAL MODE    │   mutations (write/edit/exec/bash) ALLOWED
│  (mutations OK)  │
└────────┬─────────┘
         │ enter_plan_mode  (or user toggles via /plan on)
         │ ──► [PLAN_MODE_INTRO]: (one-shot, first-time only)
         ▼
┌──────────────────────────────────────────────┐
│   PLAN MODE — INVESTIGATION                  │
│   (mutations BLOCKED; read-only tools OK)    │
│                                              │
│  ↻ update_plan        — track progress       │
│  ↻ ask_user_question  — clarify, non-block   │
│  ↻ sessions_spawn     — research subagents   │
│  ↻ read/grep/glob/web_search/lcm_*           │
│                                              │
│  Possible nudges injected by runtime:        │
│  - [PLAN_NUDGE]:      cron wake-up if idle   │
│  - [PLAN_ACK_ONLY]:   if no tool call        │
│  - [PLANNING_RETRY]:  if narrating only      │
└─────────────────────┬────────────────────────┘
                      │ exit_plan_mode(title, plan, ...)
                      │ ──► STOP — no more chat this turn!
                      │ ──► tool-side gate blocks if
                      │     openSubagentRunIds.size > 0
                      ▼
┌──────────────────────────────────────────────┐
│   PLAN MODE — PENDING APPROVAL               │
│   (approval card visible to user)            │
│                                              │
│  - approval-side gate blocks approve/edit if │
│    subagents spawn DURING approval window    │
│  - [PLAN_NUDGE] suppressed when pending      │
└──┬─────────────┬─────────────┬───────────────┘
   │ approve     │ edit        │ reject + feedback
   │ /plan       │ /plan       │ /plan revise <text>
   │ accept      │ accept edits│
   ▼             ▼             ▼
[PLAN_DECISION]: approved      [PLAN_DECISION]: rejected
[PLAN_DECISION]: edited        feedback: "<text>"
   │             │                  │
   ▼             ▼                  ▼ ── back to INVESTIGATION
┌──────────────────┐
│   NORMAL MODE    │   mutations UNLOCKED, execute the plan
│  (mutations OK)  │   update_plan to mark steps completed
└────────┬─────────┘   all-terminal → auto-close + [PLAN_COMPLETE]:
         │
         ▼ (cycle done; user may /plan on for next cycle)
```

## Tool contract (one-line each)

- `enter_plan_mode()` — once per cycle. Arms mutation gate. No-op if already in plan mode.
- `update_plan(plan=[...])` — TRACKING ONLY. Does NOT submit. Mutations stay blocked.
- `exit_plan_mode(title, plan, ...)` — once per cycle when ready to propose. Submits for user approval. **STOP after this tool call (no chat text in same turn).**
- `ask_user_question(question, options)` — non-blocking clarification. Stays in plan mode.
- `sessions_spawn(...)` — research subagents. Tool-side gate WILL block exit_plan_mode until they return.

## `[PLAN_*]:` tag taxonomy (synthetic messages from runtime → agent)

These are user messages the AGENT receives, prefixed with a `[PLAN_*]:` tag so the agent can distinguish runtime-generated messages from real user input.

| Tag                                         | When fired                                                                           | Action expected                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `[PLAN_MODE_INTRO]:`                        | First plan-mode entry per session (one-shot)                                         | Read for context; start investigation              |
| `[PLAN_DECISION]: approved \| edited`       | User clicked Approve / Edit                                                          | Execute the plan immediately                       |
| `[PLAN_DECISION]: rejected` (with feedback) | User clicked Reject                                                                  | Revise plan based on feedback; resubmit            |
| `[PLAN_DECISION]: timed_out`                | Approval expired without user action                                                 | Stay in plan mode; may re-propose                  |
| `[QUESTION_ANSWER]: <text>`                 | User answered an `ask_user_question`                                                 | Incorporate answer into the plan                   |
| `[PLAN_COMPLETE]: <N> step(s) completed`    | All plan steps reached terminal status                                               | Post brief summary; stop                           |
| `[PLAN_NUDGE]:`                             | Cron wake-up while plan is active                                                    | Advance the next step (or schedule another resume) |
| `[PLAN_ACK_ONLY]:`                          | Runtime detected prior turn ended with chat text and no tool call (escalating retry) | CALL exit_plan_mode or an investigative tool       |
| `[PLAN_YIELD]:`                             | Runtime detected agent yielded immediately after approval (escalating retry)         | CONTINUE executing the approved plan               |
| `[PLANNING_RETRY]:`                         | Runtime detected planning narration without action (outside plan mode)               | TAKE the first concrete tool action                |

## `/plan` slash-command surface (user types these in chat)

| Command                            | Effect                                                           |
| ---------------------------------- | ---------------------------------------------------------------- |
| `/plan on`                         | Toggle plan mode ON                                              |
| `/plan off`                        | Toggle plan mode OFF (any pending approval is dropped)           |
| `/plan status`                     | Show current plan-mode state (mode, approval, title, etc.)       |
| `/plan view`                       | Open the active plan in the side panel                           |
| `/plan accept`                     | Approve the pending plan                                         |
| `/plan accept edits`               | Approve with edits (counts as approval)                          |
| `/plan revise <feedback>`          | Reject with revision feedback                                    |
| `/plan answer <text>`              | Answer a pending `ask_user_question`                             |
| `/plan auto on` / `/plan auto off` | Toggle auto-approve mode (future plans auto-resolve as approved) |
| `/plan self-test`                  | Run the synthetic plan-mode flow end-to-end + report pass/fail   |

## Common pitfalls

1. **Don't post chat after `exit_plan_mode` in the same turn.** Trailing assistant text breaks the approval card lifecycle and the user gets stuck.
2. **Wait for spawned subagents BEFORE `exit_plan_mode`.** The tool-side gate will reject your submission if any spawned subagents are still running. The error message lists their child run IDs.
3. **`update_plan` does NOT submit.** It only tracks progress. Use `exit_plan_mode` to propose to the user.
4. **Don't re-enter plan mode after approval.** Just continue executing. Re-enter only for a NEW planning cycle (different objective, separate user request).
5. **Provide a meaningful `title`.** It becomes the persisted markdown filename (`plan-YYYY-MM-DD-<slug>.md`) AND the side-panel header. Generic titles like "Test plan" make plans hard to find later.
6. **Don't submit empty plans.** A plan with zero steps will be rejected by the runtime.

## Debugging tips

If something goes wrong:

```bash
# Turn on structured plan-mode debug logging:
openclaw config set agents.defaults.planMode.debug true
# Restart gateway via menubar app or: launchctl kickstart -k gui/$UID/ai.openclaw.gateway

# Tail the structured debug stream:
tail -F ~/.openclaw/logs/gateway.err.log | grep '\[plan-mode/'

# Tail the always-on approval-gate log (no env var needed):
tail -F ~/.openclaw/logs/gateway.err.log | grep 'plan-approval-gate'
```

## Self-test

Run `/plan self-test` to verify the local install. The command:

1. Pre-checks gateway health + plan-mode config
2. Enters plan mode
3. Calls `update_plan` with a 2-step test plan
4. Calls `exit_plan_mode` with a synthetic plan + title `"plan-mode self-test"`
5. Verifies the approval card emits with correct title + plan steps
6. Auto-resolves approval
7. Verifies mutation gate unlocks
8. Verifies the markdown file written to `~/.openclaw/agents/<id>/plans/plan-YYYY-MM-DD-plan-mode-self-test.md`
9. Verifies debug log fires (when debug flag enabled)
10. Cleans up the test plan

A passing run means plan mode is correctly wired end-to-end on this install. A failing step lists the specific surface that's broken (tool wiring, persister, approval handler, mutation gate, etc.) so you can investigate.

## Related references

- `docs/concepts/plan-mode.md` — user-facing concept doc
- `docs/plans/PLAN-MODE-ARCHITECTURE.md` — internal architecture + iteration history
- `src/agents/plan-mode/reference-card.ts` — the in-mode bootstrap reference (same content as this skill, but always-on when plan mode is active)
