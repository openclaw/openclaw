---
title: "Honcho Memory"
summary: "AI-native cross-session memory via the Honcho plugin"
read_when:
  - You want persistent memory that works across sessions and channels
  - You want AI-powered recall and user modeling
---

# Honcho Memory

[Honcho](https://honcho.dev) adds AI-native memory to OpenClaw. It persists
conversations to a dedicated service and builds user and agent models over time,
giving your agent cross-session context that goes beyond workspace Markdown
files.

## What it provides

- **Cross-session memory** -- conversations are persisted after every turn, so
  context carries across session resets, compaction, and channel switches.
- **User modeling** -- Honcho maintains a profile for each user (preferences,
  facts, communication style) and for the agent (personality, learned
  behaviors).
- **Semantic search** -- search over observations from past conversations, not
  just the current session.
- **Multi-agent awareness** -- parent agents automatically track spawned
  sub-agents, with parents added as observers in child sessions.

## Available tools

Honcho registers tools that the agent can use during conversation:

**Data retrieval (fast, no LLM call):**

| Tool             | What it does                             |
| ---------------- | ---------------------------------------- |
| `honcho_session` | Conversation history and summaries       |
| `honcho_profile` | User profile with key facts              |
| `honcho_search`  | Semantic search over past observations   |
| `honcho_context` | Full user representation across sessions |

**Q&A (LLM-powered):**

| Tool             | What it does                                 |
| ---------------- | -------------------------------------------- |
| `honcho_recall`  | Factual questions with minimal reasoning     |
| `honcho_analyze` | Complex synthesis requiring deeper reasoning |

## Getting started

Install the plugin and run setup:

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
openclaw honcho setup
openclaw gateway --force
```

The setup command prompts for your API credentials, writes the config, and
optionally migrates existing workspace memory files.

<Info>
Honcho can run entirely locally (self-hosted) or via the managed API at
`api.honcho.dev`. No external dependencies are required for the self-hosted
option.
</Info>

## Configuration

Settings live under `plugins.entries["openclaw-honcho"].config`:

```json5
{
  plugins: {
    entries: {
      "openclaw-honcho": {
        config: {
          apiKey: "your-api-key", // omit for self-hosted
          workspaceId: "openclaw", // memory isolation
          baseUrl: "https://api.honcho.dev",
        },
      },
    },
  },
}
```

For self-hosted instances, point `baseUrl` to your local server (for example
`http://localhost:8000`) and omit the API key.

## How it works

After every AI turn, the conversation is persisted to Honcho. Both user and
agent messages are observed, allowing Honcho to build and refine its models over
time.

During conversation, Honcho tools query the service in the `before_prompt_build`
phase, injecting relevant context before the model sees the prompt. This ensures
accurate turn boundaries and relevant recall.

## Honcho vs builtin memory

|                   | Builtin / QMD                | Honcho                              |
| ----------------- | ---------------------------- | ----------------------------------- |
| **Storage**       | Workspace Markdown files     | Dedicated service (local or hosted) |
| **Cross-session** | Via memory files             | Automatic, built-in                 |
| **User modeling** | Manual (write to MEMORY.md)  | Automatic profiles                  |
| **Search**        | Vector + keyword (hybrid)    | Semantic over observations          |
| **Multi-agent**   | Not tracked                  | Parent/child awareness              |
| **Dependencies**  | None (builtin) or QMD binary | Plugin install                      |

Honcho and the builtin memory system can work together. When QMD is configured,
additional tools become available for searching local Markdown files alongside
Honcho's cross-session memory.

## Further reading

- [Honcho documentation](https://docs.honcho.dev)
- [Honcho OpenClaw integration guide](https://docs.honcho.dev/v3/guides/integrations/openclaw)
- [Memory](/concepts/memory) -- OpenClaw memory overview
- [Context Engines](/concepts/context-engine) -- how plugin context engines work
