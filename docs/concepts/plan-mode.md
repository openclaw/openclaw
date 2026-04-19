---
summary: "Plan mode: user-approval-gated workflow for non-trivial multi-step changes"
read_when:
  - You want to understand what plan mode does and when to use it
  - You are reviewing a plan-approval card and want to know what your options mean
  - You are debugging a session that seems stuck in plan mode
  - You are an agent running on OpenClaw and need a quick plan-mode reference
title: "Plan Mode"
---

# Plan Mode

**Plan mode** is OpenClaw's user-approval-gated workflow. The agent investigates read-only, drafts a plan, submits it for your approval, and executes only after you click Approve. Mutating tools (write / edit / exec / bash) are BLOCKED until the plan is approved.

## When to use plan mode

Use plan mode for **non-trivial multi-step changes** where you want to review the agent's intent before any mutations land:

- Refactors that touch multiple files
- Migrations (data, config, infrastructure)
- Anything that calls destructive tools (delete, rm, force-push)
- Cross-component changes where the agent's first guess might be wrong
- When you want a written audit trail of what the agent intended

Skip plan mode for **simple direct asks**:

- Single-file edits where the change is obvious
- Reads (the agent doesn't need approval to read your code)
- Quick questions
- Conversational replies

## Lifecycle at a glance

```
NORMAL MODE → /plan on → INVESTIGATION → exit_plan_mode → PENDING APPROVAL
                                                                  ↓
                              (you click Approve / Reject / Edit / let it Time Out)
                                                                  ↓
                          NORMAL MODE (executes) ← OR → INVESTIGATION (revising)
```

1. **Enter:** type `/plan on` (or the agent calls `enter_plan_mode` when you ask for a plan).
2. **Investigate:** agent uses read-only tools (read, grep, web_search, etc.) and tracks progress with `update_plan`. Mutations are BLOCKED.
3. **Submit:** agent calls `exit_plan_mode` with a title + plan steps + (optional) analysis / assumptions / risks / verification / references.
4. **Decide:** you see an approval card. Pick one:
   - **Approve** — mutations unlock, agent executes
   - **Approve with edits** — same as approve (you can pre-edit the plan in the side panel first)
   - **Reject with feedback** — agent stays in plan mode, revises based on your feedback
   - **Time out** — pretend it never happened; you can re-prompt
5. **Execute:** agent runs the plan, calls `update_plan` to mark steps completed/cancelled.
6. **Complete:** when all steps reach terminal status, the plan auto-closes.

## Slash commands

| Command                            | What it does                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `/plan on`                         | Toggle plan mode ON (mutations blocked)                                        |
| `/plan off`                        | Toggle plan mode OFF (mutations unblocked; pending approval dropped)           |
| `/plan status`                     | Show current state (mode, approval, title)                                     |
| `/plan view`                       | Open the active plan in the side panel                                         |
| `/plan accept`                     | Approve the pending plan                                                       |
| `/plan accept edits`               | Approve with edits                                                             |
| `/plan revise <feedback>`          | Reject with revision feedback                                                  |
| `/plan answer <text>`              | Answer a clarifying question the agent asked                                   |
| `/plan auto on` / `/plan auto off` | Toggle auto-approve mode (future plans auto-approved without showing the card) |
| `/plan self-test`                  | _(deferred — runtime not yet wired; tracked in PLAN-MODE-ARCHITECTURE.md)_     |

## What you see in webchat

When the agent submits a plan, an **inline approval card** appears in the chat with:

- **Title** (the agent-supplied plan name)
- **Step list** with checkboxes
- **Optional sections**: analysis, assumptions, risks, verification, references
- **Buttons**: Approve / Edit / Reject

You can also click "Plan view" in the chat controls to see the same plan in the right side panel — useful for reviewing edits before approving.

## Multi-channel behavior

Plan mode is multi-channel by design:

- **Webchat** — inline card with buttons + side-panel view
- **Telegram** — `/plan ...` text commands today; inline-button card + markdown document attachment delivery is _deferred to a follow-up PR_ (the bridge persists the markdown to disk under `~/.openclaw/agents/<id>/plans/` even on Telegram sessions, but document attachment + inline-keyboard wiring await re-rebasing onto the new plugin-sdk surface)
- **Slack** — inline-button card in the originating thread
- **Discord** — inline-button card with `/plan` slash commands as fallback
- **CLI** — `/plan accept` / `/plan revise` / `/plan answer` text commands

Approvals from any channel are deduplicated server-side by `approvalId`, so clicking Approve on Telegram while the webchat card is also open won't double-fire.

> **Doc accuracy note (2026-04-19, Copilot review #68939):** Telegram inline-button cards and markdown attachment delivery were both flagged as documented-but-deferred. The `/plan ...` text-command path is shipped and works on Telegram today; the richer UI surfaces land in a follow-up PR once the upstream plugin-sdk restructure is mapped. See "Long-term follow-ups (deferred)" in `docs/plans/PLAN-MODE-ARCHITECTURE.md`.

## Persisted plans

Every approved plan is persisted as markdown at:

```
~/.openclaw/agents/<agentId>/plans/plan-YYYY-MM-DD-<slug>.md
```

The slug is derived from the plan title. This gives you a searchable, datable audit trail of every plan the agent has executed.

## Auto-approve mode

If you trust the agent's planning quality on a particular session, type `/plan auto on` BEFORE entering plan mode. The next `exit_plan_mode` will auto-resolve as approved without showing the card. Useful for trusted workflows where you want the planning STRUCTURE (audit trail, archetype fields) but don't want to review every plan.

`/plan auto off` cancels future auto-approval. The flag persists across plan-mode toggles for the session.

## Subagent gating

If the agent spawns research subagents during plan-mode investigation (`sessions_spawn`), the runtime gates `exit_plan_mode` until ALL spawned subagents complete:

- **Tool-side gate**: at submission time, if any spawned subagent is still running, `exit_plan_mode` rejects with a message listing the in-flight child run IDs. The agent waits + retries.
- **Approval-side gate**: if a NEW subagent is spawned DURING the user's approval window, clicking Approve is blocked with a bottom-of-chat toast: "Subagents still running — try again after subagent results return."

This prevents the agent from acting on partial subagent results.

## Troubleshooting

**Click Approve but nothing happens / agent doesn't continue:**

- Likely the agent posted chat after `exit_plan_mode` in the same turn (a known anti-pattern). Re-prompt with "continue executing the approved plan."
- Run `/plan self-test` to verify the runtime is wired correctly.

**Approval card stays after you click Approve:**

- The card may have gone stale (session timed out, another channel resolved it, etc.). Refresh the page; the stale card auto-dismisses on the next session-state update.

**`Plan approval failed: planApproval requires an active plan-mode session`:**

- The card lifecycle is out of sync with server state. Refresh the page.
- If it persists, check the gateway log: `tail -F ~/.openclaw/logs/gateway.err.log | grep plan-approval-gate`

**Agent calls `update_plan` but never `exit_plan_mode`:**

- The agent may be confused — `update_plan` only TRACKS progress; only `exit_plan_mode` submits. Re-prompt: "submit the plan via exit_plan_mode."

**Tail the structured debug log:**

```bash
openclaw config set agents.defaults.planMode.debug true
# Restart gateway
tail -F ~/.openclaw/logs/gateway.err.log | grep '\[plan-mode/'
```

## See also

- `/plan-mode-101` skill — agent-facing reference card with the same lifecycle diagram
- `docs/plans/PLAN-MODE-ARCHITECTURE.md` — internal architecture + iteration history
