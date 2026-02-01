# Moltbot Overview — Context for the Web4 Governance Extension

This document explains how Moltbot works, from broad concepts to implementation
details, to help anyone evaluating what the web4-governance extension does and
where it fits in the architecture.

---

## What Is Moltbot?

**Moltbot is a personal AI assistant runtime** — think of it as "your own ChatGPT"
that you run locally, connected to all your messaging apps.

You message it on WhatsApp → Moltbot receives → Agent processes with Claude/GPT →
Response flows back to WhatsApp.

The key insight: Moltbot is not a chatbot — it's an **agent runtime** with tool
execution capabilities, which is why governance matters.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    YOUR MESSAGING APPS                        │
│  WhatsApp │ Telegram │ Slack │ Discord │ Signal │ iMessage   │
│  Teams │ Matrix │ WebChat │ Google Chat │ etc.               │
└────────────────────────┬─────────────────────────────────────┘
                         │ messages flow in/out
┌────────────────────────┴─────────────────────────────────────┐
│                      MOLTBOT GATEWAY                          │
│    (local daemon running on your machine)                     │
│    - Manages connections to all channels                      │
│    - Routes messages to the right agent/session               │
│    - Handles auth, pairing, security policies                 │
└────────────────────────┬─────────────────────────────────────┘
                         │
┌────────────────────────┴─────────────────────────────────────┐
│                       AGENT RUNTIME                           │
│    - Talks to LLM providers (Anthropic, OpenAI, etc.)        │
│    - Executes tools (browser, files, bash, canvas)           │
│    - Manages conversation sessions & context                  │
└────────────────────────┬─────────────────────────────────────┘
                         │
┌────────────────────────┴─────────────────────────────────────┐
│                       EXTENSIONS                              │
│    - Add channels, tools, hooks, CLI commands                │
│    - web4-governance hooks into tool execution here          │
└──────────────────────────────────────────────────────────────┘
```

---

## Layer 1: The Gateway (Control Plane)

The gateway is a **local WebSocket server** that runs as a daemon:

- **Connects to channels** — Each messaging platform has an adapter
- **Routes messages** — Decides which agent/session handles each message
- **Manages security** — DM pairing codes, allowlists, access policies
- **Runs persistently** — `launchd` on macOS, `systemd` on Linux

Source: `src/gateway/`

---

## Layer 2: Channels (Messaging Adapters)

Each channel translates between Moltbot's internal format and the platform's API:

| Channel  | Library     | Location              |
| -------- | ----------- | --------------------- |
| WhatsApp | Baileys     | `src/whatsapp/`       |
| Telegram | grammY      | `src/telegram/`       |
| Discord  | discord.js  | `src/discord/`        |
| Slack    | Bolt        | `src/slack/`          |
| Signal   | signal-cli  | `src/signal/`         |
| iMessage | imsg        | `src/imessage/`       |
| Matrix   | (extension) | `extensions/matrix/`  |
| MS Teams | (extension) | `extensions/msteams/` |

Channels implement a standard interface (`ChannelPlugin`) with adapters for
messaging, auth, groups, security, and status.

---

## Layer 3: Agent Runtime (The Brain)

When a message arrives, the agent processes it:

```
1. Message comes in
2. Load/create session (conversation context)
3. Build prompt with system instructions, history, tools
4. Call LLM provider (Anthropic, OpenAI, etc.)
5. If LLM wants to use a tool → execute tool → loop back to 4
6. Return final response to channel
```

Key components:

- `src/agents/pi-tools.ts` — Tool execution pipeline
- `src/providers/` — LLM provider integrations (Anthropic, OpenAI, etc.)
- `src/sessions/` — Conversation state management

---

## Layer 4: Tools (Agent Capabilities)

The agent can execute **tools** — this is where it becomes powerful (and risky):

| Tool         | Capability                             |
| ------------ | -------------------------------------- |
| Browser      | Navigate, click, screenshot web pages  |
| Canvas       | Visual workspace the agent can draw on |
| Bash         | Run shell commands (sandboxed)         |
| Files        | Read/write files on your system        |
| Cron         | Schedule tasks                         |
| Node actions | Control macOS/iOS/Android devices      |

Tools go through a hook system that extensions can intercept.

---

## Layer 5: Extensions (Plugins)

Extensions add capabilities without modifying core Moltbot:

```
extensions/
├── bluebubbles/      # iMessage via BlueBubbles
├── matrix/           # Matrix protocol
├── msteams/          # Microsoft Teams
├── memory-core/      # Conversation memory
├── voice-call/       # Phone calls via Twilio
├── web4-governance/  # ← THIS EXTENSION
└── ...
```

Extensions can:

- Add new channels (messaging platforms)
- Add new tools
- **Hook into tool execution** (before/after)
- Add CLI commands
- Register HTTP routes

---

## The Hook System (Where Web4 Plugs In)

This is the critical integration point. Moltbot exposes typed hooks:

```typescript
// src/agents/pi-tools.hooks.ts

before_tool_call(context) {
  // Can inspect, modify, or BLOCK tool execution
  return { block: false }
  // or: return { block: true, blockReason: "Policy denied this action" }
}

after_tool_call(context, result) {
  // Fire-and-forget — log, audit, update metrics
  // Cannot block (tool already executed)
}
```

**This is the same pattern as Claude Code's hooks** (`pre_tool_use` / `post_tool_use`),
which is why the governance approach is identical across both runtimes.

---

## What Web4-Governance Does

The extension hooks into tool execution to provide:

```
┌─────────────────────────────────────────────────────────┐
│             MOLTBOT TOOL EXECUTION                       │
│                                                          │
│  User: "Delete all files in /tmp"                       │
│                    ↓                                     │
│  Agent decides: use Bash tool with rm -rf /tmp/*        │
│                    ↓                                     │
│  ┌─────────────────────────────────────────────────┐    │
│  │         WEB4-GOVERNANCE HOOK                     │    │
│  │                                                   │    │
│  │  before_tool_call:                               │    │
│  │    1. Classify: tool=Bash, category=command      │    │
│  │    2. Extract target: "rm -rf /tmp/*"            │    │
│  │    3. Evaluate policy: DENY (destructive)        │    │
│  │    4. Return { block: true, blockReason: "..." } │    │
│  │                                                   │    │
│  │  after_tool_call (if not blocked):               │    │
│  │    5. Create R6 audit record                     │    │
│  │    6. Append to hash-linked chain                │    │
│  └─────────────────────────────────────────────────┘    │
│                    ↓                                     │
│  Tool blocked → Agent gets error → Explains to user     │
└─────────────────────────────────────────────────────────┘
```

### Why This Matters

Without governance, an agent can:

- Delete files (`rm -rf`)
- Read secrets (`.env`, credentials)
- Make network requests (exfiltration)
- Execute arbitrary code
- Modify system configuration

The web4-governance extension provides:

1. **Visibility** — Every action is logged in a tamper-evident audit chain
2. **Policy** — Configurable rules to allow/deny/warn on specific actions
3. **Identity** — Session-bound tokens for attribution
4. **Upgrade path** — From observation (Tier 1) to full authorization (Tier 2)

---

## Connection to Web4 Ecosystem

This extension is part of a broader governance architecture:

| Tier                  | Implementation      | Capabilities                                    |
| --------------------- | ------------------- | ----------------------------------------------- |
| **1 — Observational** | This extension      | R6 audit, hash chain, soft LCT                  |
| **1.5 — Policy**      | This extension      | Rule-based allow/deny/warn                      |
| **2 — Authorization** | Hardbound (planned) | T3 trust tensors, ATP economics, hardware LCT   |
| **3 — Training**      | HRM/SAGE (research) | Meta-cognitive training with trust trajectories |

The same R6 framework runs in:

- **Moltbot** — This extension
- **Claude Code** — `web4/claude-code-plugin/`
- **Hardbound** — Full Rust implementation (Tier 2)

---

## Why We Built This

Moltbot is a powerful agent runtime. Power requires accountability.

The web4-governance extension answers:

- **What did the agent do?** — R6 audit records
- **Why did it do that?** — Request context and reasoning
- **Should it have been allowed?** — Policy evaluation
- **Can we prove it?** — Hash-linked provenance chain
- **Who was responsible?** — Session identity (Soft LCT)

This is governance as infrastructure, not governance as afterthought.

---

## Further Reading

- [README.md](./README.md) — Configuration, CLI commands, policy rules
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Technical implementation details
- [Web4 R6 Framework](https://github.com/dp-web4/web4/tree/main/web4-standard/core-spec) — Core specification

---

_"An agent without governance is just automation with plausible deniability."_
