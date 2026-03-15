---
summary: "OpenClaw Memory Graphiti plugin: knowledge graph memory with auto-capture and auto-recall via Graphiti"
read_when:
  - You want persistent knowledge graph memory in OpenClaw
  - You are configuring or developing the openclaw-memory-graphiti plugin
title: "OpenClaw Memory Graphiti Plugin"
---

# OpenClaw Memory Graphiti (plugin)

Persistent knowledge graph memory for OpenClaw via a plugin, powered by
[Graphiti](https://github.com/getzep/graphiti). Automatically captures
conversation context on session end and recalls relevant facts on agent start.

Key features:

- **Auto-capture** — saves conversation context to the knowledge graph when a conversation ends
- **Auto-recall** — retrieves relevant facts from the graph when an agent starts
- **Configurable** — API endpoint, group ID, and max facts per recall

## Where it runs

This plugin runs **inside the Gateway process**.

If you use a remote Gateway, install/configure it on the **machine running the Gateway**, then restart the Gateway.

## Install

### Option A: install from npm (recommended)

```bash
openclaw plugins install @happycastle/openclaw-memory-graphiti
```

Restart the Gateway afterwards.

### Option B: install from a local folder (dev)

```bash
git clone https://github.com/happycastle114/openclaw-memory-graphiti.git
openclaw plugins install ./openclaw-memory-graphiti
cd ./openclaw-memory-graphiti && npm install
```

Restart the Gateway afterwards.

## Prerequisites

A running [Graphiti](https://github.com/getzep/graphiti) server is required.
Follow the Graphiti documentation to set up the server before configuring this
plugin.

## Config

Set config under `plugins.entries.openclaw-memory-graphiti.config`:

```json5
{
  plugins: {
    entries: {
      "openclaw-memory-graphiti": {
        enabled: true,
        config: {
          // Graphiti server endpoint
          graphitiApiUrl: "http://localhost:8000",

          // Group ID for isolating knowledge graphs
          groupId: "default",

          // Maximum number of facts to recall per agent start
          maxFacts: 10,
        },
      },
    },
  },
}
```

## How it works

1. **On conversation end** — the plugin captures the conversation content and sends it to Graphiti, which extracts entities, relationships, and facts into the knowledge graph.
2. **On agent start** — the plugin queries Graphiti for facts relevant to the current context and injects them into the agent's system prompt.

This gives the agent persistent memory across conversations without manual context management.

## Links

- npm: [`@happycastle/openclaw-memory-graphiti`](https://www.npmjs.com/package/@happycastle/openclaw-memory-graphiti)
- GitHub: [happycastle114/openclaw-memory-graphiti](https://github.com/happycastle114/openclaw-memory-graphiti)
