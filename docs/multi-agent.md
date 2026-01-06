---
summary: "Multi-agent routing: isolated agents, provider accounts, and bindings"
title: Multi-Agent Routing
read_when: "You want multiple isolated agents (workspaces + auth) in one gateway process."
status: active
---

# Multi-Agent Routing

Goal: multiple *isolated* agents (separate workspace + `agentDir` + sessions), plus multiple provider accounts (e.g. two WhatsApps) in one running Gateway. Inbound is routed to an agent via bindings.

## Concepts

- `agentId`: one “brain” (workspace, per-agent auth, per-agent session store).
- `accountId`: one provider account instance (e.g. WhatsApp account `"personal"` vs `"biz"`).
- `binding`: routes inbound messages to an `agentId` by `(provider, accountId, peer)` and optionally guild/team ids.
- Direct chats collapse to `agent:<agentId>:<mainKey>` (per-agent “main”; `session.mainKey`).

## Example: two WhatsApps → two agents

`~/.clawdbot/clawdbot.json` (JSON5):

```js
{
  routing: {
    defaultAgentId: "home",

    agents: {
      home: {
        workspace: "~/clawd-home",
        agentDir: "~/.clawdbot/agents/home/agent",
      },
      work: {
        workspace: "~/clawd-work",
        agentDir: "~/.clawdbot/agents/work/agent",
      },
    },

    // Deterministic routing: first match wins (most-specific first).
    bindings: [
      { agentId: "home", match: { provider: "whatsapp", accountId: "personal" } },
      { agentId: "work", match: { provider: "whatsapp", accountId: "biz" } },

      // Optional per-peer override (example: send a specific group to work agent).
      {
        agentId: "work",
        match: {
          provider: "whatsapp",
          accountId: "personal",
          peer: { kind: "group", id: "1203630...@g.us" },
        },
      },
    ],

    // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  whatsapp: {
    accounts: {
      personal: {
        // Optional override. Default: ~/.clawdbot/credentials/whatsapp/personal
        // authDir: "~/.clawdbot/credentials/whatsapp/personal",
      },
      biz: {
        // Optional override. Default: ~/.clawdbot/credentials/whatsapp/biz
        // authDir: "~/.clawdbot/credentials/whatsapp/biz",
      },
    },
  },
}
```
