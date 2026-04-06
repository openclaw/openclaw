---
summary: "How to wire multi-agent delegation correctly: session keys, tools, and the Manager to Worker to QA pattern."
title: Multi-Agent Telegram Delegation
read_when:
  - Your agents are not talking to each other
  - You want a manager agent to delegate to workers and run QA
  - You are confused about when to use sessions_spawn vs sessions_send
  - The message tool is not triggering agent responses
status: active
---

# Multi-Agent Telegram Delegation

So your agents will not talk to each other. You have tried `sessions_spawn`, you've tried the `message` tool, nothing works. This guide explains why, and how to wire it correctly.

These are hard-won discoveries from production fleet debugging, not theory.

---

## The Core Constraints (Read These First)

### 1. Subagents Cannot Spawn Subagents

`sessions_spawn` creates a **subagent session** with a reduced tool set. Session management tools — including `sessions_spawn` itself and `sessions_send` — are **not available** inside a subagent context.

This means: if your agent needs to delegate downstream (e.g., a dev manager spawning a QA reviewer), it **cannot** run as a subagent. It will silently fail or error when trying to call session tools.

**Rule:** Any agent that needs to coordinate other agents must run as a **top-level persistent session**, not as a spawned subagent.

### 2. The message Tool Is Outbound-Only

Sending a Telegram message via `message action=send` delivers a message through the bot's Telegram API. It appears in the chat. But the **target agent does not process it as an inbound task**.

The `message` tool is for human-facing notifications — letting Sir know something is done. It is not an inter-agent delegation mechanism.

```python
# ❌ This does NOT task an agent — it just sends a Telegram message
message(action="send", channel="telegram", target="YOUR_CHAT_ID", message="Do X")

# ✅ This tasks a persistent agent session
sessions_send(sessionKey="agent:code-monkey:main", message="Do X")
```

### 3. `sessions_send` to persistent sessions is the correct delegation path

Manager agents that need to coordinate teams should run as **top-level persistent sessions**. Use `sessions_send(sessionKey, message)` to task them. Persistent sessions have the full tool set, including `sessions_spawn` for spawning workers.

---

## Session Key Patterns

| Session type             | Key format                                   |
| ------------------------ | -------------------------------------------- |
| Persistent agent session | `agent:<agent-id>:main`                      |
| Telegram direct session  | `agent:<agent-id>:telegram:direct:<chat-id>` |
| Spawned subagent         | `agent:<agent-id>:subagent:<uuid>`           |

**Examples:**

- `agent:code-monkey:main` — Code Monkey's persistent session (has full tools)
- `agent:main:telegram:direct:YOUR_CHAT_ID` — Babbage's Telegram session with Sir
- `agent:ralph:subagent:d22a63f7-...` — a one-shot Ralph QA review (no session tools)

---

## The Manager to Worker to QA Pattern

This is the standard delegation pattern for a multi-agent fleet:

```
Orchestrator (Babbage)
  └─ sessions_send → Manager (Code Monkey, persistent)
       ├─ sessions_spawn → Worker (one-shot, no further delegation)
       └─ sessions_spawn → QA (Ralph, one-shot)
            ├─ APPROVED → Manager reports to Orchestrator + notifies Sir
            └─ REJECTED → Manager fixes → re-spawns Ralph (max 3 rounds)
```

### Step by step

**1. Orchestrator tasks the manager**

```python
sessions_send(
    sessionKey="agent:code-monkey:main",
    message="Build feature X. Run Ralph QA when done."
)
```

**2. Manager does work (or spawns workers)**

If the task is simple enough, the manager does it directly. If it needs a specialist:

```python
sessions_spawn(
    agentId="code-frontend",
    task="Build the UI component for feature X",
    mode="run"  # one-shot
)
```

**3. Manager spawns QA**

```python
sessions_spawn(
    agentId="ralph",
    task="QA review: feature X. Files: src/components/X.tsx",
    mode="run"
)
```

**4. QA returns APPROVED or REJECTED**

Ralph's result arrives as a push-based completion event. The manager reads it and acts:

- **APPROVED** → proceed to step 5
- **REJECTED** → fix all cited issues, re-spawn Ralph (up to 3 rounds). After 3 rejections, escalate to the orchestrator with all rejection notes.

**5. Manager delivers results**

```python
# Notify Sir on Telegram (human-facing)
message(action="send", channel="telegram", target="YOUR_CHAT_ID",
        message="✅ Feature X done and Ralph-approved.")

# Report back to orchestrator
sessions_send(
    sessionKey="agent:main:telegram:direct:YOUR_CHAT_ID",
    message="✅ Feature X done. [summary]"
)
```

---

## sessions_spawn vs sessions_send: When to Use Each

| Situation                                                     | Use                                                |
| ------------------------------------------------------------- | -------------------------------------------------- |
| One-shot task, agent doesn't need to delegate further         | `sessions_spawn`                                   |
| Agent needs full tools (session management, spawning workers) | `sessions_send` to persistent session              |
| Tasking a QA reviewer                                         | `sessions_spawn` (Ralph reviews, doesn't delegate) |
| Tasking a dev manager                                         | `sessions_send` to `agent:code-monkey:main`        |
| Human-facing notification                                     | `message` tool                                     |

**Quick rule:** If the agent you're tasking needs to call `sessions_spawn` or `sessions_send` itself, use `sessions_send` to a persistent session. If it's a leaf-node task (do work, return result), `sessions_spawn` is fine.

---

## Troubleshooting

### My Agent Is Not Responding to Messages

Check whether you're using the `message` tool or `sessions_send`. The `message` tool sends a Telegram message — the agent sees it in the chat log but does **not** process it as a new task. Use `sessions_send` with the correct `sessionKey`.

### sessions_spawn Fails Inside My Agent

Your agent is running as a subagent. Subagents don't have session tools. The agent that needs to spawn others must be a **persistent top-level session**. Check whether it was originally spawned with `sessions_spawn` — if so, restructure so it runs persistently and is tasked via `sessions_send`.

### I Do Not Know the Session Key for an Agent

Persistent sessions follow `agent:<agent-id>:main`. The `agent-id` is defined in your `openclaw.json` agents list. You can also call `sessions_list()` from a parent session to discover active session keys.

### Ralph Rejected Three Times

Escalate to the orchestrator. Send a `sessions_send` to Babbage's session with the subject "QA ESCALATION: [task]" and include Ralph's notes from all 3 rounds. Don't keep looping — 3 rejections means the task needs human judgment.

### The Completion Event Never Arrived

Push-based completion events arrive as inbound messages after `sessions_spawn`. Do **not** poll with `sessions_list`, `sessions_history`, or `exec sleep` — just wait. If a completion event arrives after you've already sent your final reply, respond with `NO_REPLY` (a bare signal to the runtime that tells it to suppress the duplicate delivery — it is not a message sent to any user or agent).

---

## Complete Wiring Example

A minimal end-to-end example: Babbage tasks Code Monkey, CM delegates to a worker and runs Ralph QA, then notifies both Sir and Babbage.

```
[Babbage → CM via sessions_send]
"Build the login form. Files in src/components/Login.tsx. Run Ralph when done."

[CM → Frontend worker via sessions_spawn]
task: "Build Login.tsx per spec"
mode: "run"
→ Worker completes, CM gets completion event

[CM → Ralph via sessions_spawn]
task: "QA review: src/components/Login.tsx. Check for accessibility, prop types, no console.log."
mode: "run"
→ Ralph returns APPROVED

[CM → Sir via message tool]
message(action="send", channel="telegram", target="YOUR_CHAT_ID",
        message="✅ Login form done, Ralph approved.")

[CM → Babbage via sessions_send]
sessions_send(sessionKey="agent:main:telegram:direct:YOUR_CHAT_ID",
              message="✅ Login form done. Ralph approved. Files: src/components/Login.tsx")
```

---

## See Also

- [Multi-Agent Routing](/concepts/multi-agent) — how agents are isolated and routed
- [sessions_spawn tool](/tools/sessions-spawn) — spawning subagents
- [sessions_send tool](/tools/sessions-send) — messaging persistent sessions
- [AGENTS.md reference](/concepts/agent-workspace) — workspace configuration
