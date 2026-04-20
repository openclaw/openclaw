/**
 * Plan-mode reference card — the bootstrap-injected, persistent
 * reference an in-mode agent sees on every turn alongside the
 * decision-completeness archetype prompt.
 *
 * # Why this exists (iter-3 D1)
 *
 * Without this, a fresh agent that just installed the plan-mode
 * patches has a 2-turn learning curve:
 *   - Turn 1: sees only the tool descriptions on the request
 *   - Turn 2: finally sees the in-mode system prompt with the full
 *     archetype contract
 *
 * On turn 1 it has to GUESS the lifecycle (enter → update → exit →
 * approve → execute → complete), the [PLAN_*]: tag taxonomy, the
 * `/plan` slash-command surface, and common pitfalls (no chat after
 * exit_plan_mode; wait for subagents).
 *
 * The reference card collapses the learning curve to ZERO turns: as
 * soon as plan mode is active, the agent sees the diagram, contract,
 * tag taxonomy, and pitfalls — all on the SAME turn the runtime
 * decides plan mode is active.
 *
 * # Companion artifact
 *
 * The same content (in markdown form) ships as the `plan-mode-101`
 * skill (D7) so an agent in NORMAL mode that's asked "explain plan
 * mode" can invoke the skill on demand. Keep both surfaces in sync
 * — when this file changes, update the SKILL.md too.
 *
 * # Token budget note
 *
 * The card is INTENTIONALLY compact (~80 lines). It supplements but
 * does not replace `PLAN_ARCHETYPE_PROMPT` (~120 lines, decision-
 * completeness standard). Combined they fit comfortably in the
 * in-mode system prompt without measurable cache impact.
 */
export const PLAN_MODE_REFERENCE_CARD = [
  "═══ PLAN MODE — REFERENCE CARD ═══",
  "",
  "## State diagram",
  "",
  "```",
  "┌──────────────────┐",
  "│   NORMAL MODE    │   mutations (write/edit/exec/bash) ALLOWED",
  "│  (mutations OK)  │",
  "└────────┬─────────┘",
  "         │ enter_plan_mode  (or user toggles via /plan on)",
  "         │ ──► [PLAN_MODE_INTRO]: (one-shot, first-time only)",
  "         ▼",
  "┌──────────────────────────────────────────────┐",
  "│   PLAN MODE — INVESTIGATION                  │",
  "│   (mutations BLOCKED; read-only tools OK)    │",
  "│                                              │",
  "│  ↻ update_plan        — track progress       │",
  "│  ↻ ask_user_question  — clarify; next turn   │",
  "│  ↻ sessions_spawn     — research subagents   │",
  "│  ↻ read/grep/glob/web_search/lcm_*           │",
  "│                                              │",
  "│  Possible nudges injected by runtime:        │",
  "│  - [PLAN_NUDGE]:      cron wake-up if idle   │",
  "│  - [PLAN_ACK_ONLY]:   if no tool call        │",
  "│  - [PLANNING_RETRY]:  if narrating only      │",
  "└─────────────────────┬────────────────────────┘",
  "                      │ exit_plan_mode(title, plan, ...)",
  "                      │ ──► STOP — no more chat this turn!",
  "                      │ ──► tool-side gate blocks if",
  "                      │     openSubagentRunIds.size > 0",
  "                      ▼",
  "┌──────────────────────────────────────────────┐",
  "│   PLAN MODE — PENDING APPROVAL               │",
  "│   (approval card visible to user)            │",
  "│                                              │",
  "│  - approval-side gate blocks approve/edit if │",
  "│    subagents spawn DURING approval window    │",
  "│  - [PLAN_NUDGE] suppressed when pending      │",
  "└──┬─────────────┬─────────────┬───────────────┘",
  "   │ approve     │ edit        │ reject + feedback",
  "   │ /plan       │ /plan       │ /plan revise <text>",
  "   │ accept      │ accept edits│",
  "   ▼             ▼             ▼",
  "[PLAN_DECISION]: approved      [PLAN_DECISION]: rejected",
  '[PLAN_DECISION]: edited        feedback: "<text>"',
  "   │             │                  │",
  "   ▼             ▼                  ▼ ── back to INVESTIGATION",
  "┌──────────────────┐",
  "│   NORMAL MODE    │   mutations UNLOCKED, execute the plan",
  "│  (mutations OK)  │   update_plan to mark steps completed",
  "└────────┬─────────┘   all-terminal → auto-close + [PLAN_COMPLETE]:",
  "         │",
  "         ▼ (cycle done; user may /plan on for next cycle)",
  "```",
  "",
  "## Tool contract (one-line each)",
  "",
  "- `enter_plan_mode()` — once per cycle. Arms mutation gate. No-op if already in plan mode.",
  "- `update_plan(plan=[...])` — TRACKING ONLY. Does NOT submit. Mutations stay blocked.",
  "- `exit_plan_mode(title, plan, ...)` — once per cycle when ready to propose. Submits for user approval. STOP after this tool call (no chat text in same turn).",
  "- `ask_user_question(question, options)` — non-blocking clarification. Stays in plan mode.",
  "- `sessions_spawn(...)` — research subagents. Tool-side gate WILL block exit_plan_mode until they return.",
  "",
  "## [PLAN_*]: tag taxonomy (synthetic messages from runtime → agent)",
  "",
  "- `[PLAN_MODE_INTRO]:` — one-shot at first plan-mode entry per session (lifecycle + reminders)",
  "- `[PLAN_DECISION]: approved | edited | rejected | timed_out` — user resolved the approval card",
  "- `[QUESTION_ANSWER]: <text>` — user answered an ask_user_question",
  "- `[PLAN_COMPLETE]: <N> steps completed` — auto-fired when all plan steps reach terminal status post-approval",
  "- `[PLAN_NUDGE]:` — cron wake-up nudge (suppressed when approval pending)",
  "- `[PLAN_ACK_ONLY]:` — runtime detected the prior turn ended with chat text and no tool call (escalating retry)",
  "- `[PLAN_YIELD]:` — runtime detected the agent yielded immediately after approval (escalating retry)",
  "- `[PLANNING_RETRY]:` — runtime detected a planning-narration-only turn outside plan mode (escalating retry)",
  "",
  "## /plan slash-command surface (user types these in chat)",
  "",
  "- `/plan on` / `/plan off` — toggle plan mode",
  "- `/plan status` — show current state",
  "- `/plan view` — open the active plan in the side panel",
  "- `/plan accept [edits]` — approve the pending plan",
  "- `/plan revise <feedback>` — reject with revision feedback",
  "- `/plan answer <text>` — answer a pending ask_user_question",
  "- `/plan auto on|off` — toggle auto-approve mode",
  "",
  "## Common pitfalls",
  "",
  "1. **Don't post chat after `exit_plan_mode` in the same turn.** Trailing chat breaks the approval card lifecycle.",
  "2. **Wait for spawned subagents BEFORE `exit_plan_mode`.** The tool-side gate will reject if any are still running.",
  "3. **`update_plan` does NOT submit.** It only tracks progress. Use `exit_plan_mode` to propose.",
  "4. **Don't re-enter plan mode after approval.** Just continue executing. Re-enter only for a NEW planning cycle.",
  "5. **Provide a meaningful `title`.** It becomes the persisted markdown filename (`plan-YYYY-MM-DD-<slug>.md`) AND the side-panel header.",
  "",
  "## Debugging tips",
  "",
  "- Turn on plan-mode debug logging: `openclaw config set agents.defaults.planMode.debug true` then restart gateway.",
  "- Tail the structured event log: `tail -F ~/.openclaw/logs/gateway.err.log | grep '\\[plan-mode/'`",
  "- Always-on gate-decision log: `tail -F ~/.openclaw/logs/gateway.err.log | grep 'plan-approval-gate'`",
  "- Call `plan_mode_status` to inspect the active cycle, pending interaction, and subagent gate state.",
  "",
  "═════════════════════════════════════",
].join("\n");
