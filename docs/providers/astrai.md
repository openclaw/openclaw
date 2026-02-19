---
summary: "Use Astrai intelligent inference router in OpenClaw"
read_when:
  - You want cost-optimized AI inference in OpenClaw
  - You want automatic model selection across providers
  - You want Astrai setup guidance
title: "Astrai"
---

# Astrai (Intelligent Inference Router)

**Astrai** is an AI inference router that automatically selects the optimal model and provider for each request based on cost, latency, and task complexity.

Instead of locking into a single provider, Astrai routes across OpenAI, Anthropic, Google, Groq, DeepInfra, and more — finding the cheapest equivalent model that meets quality requirements. One API key, all providers.

## Why Astrai in OpenClaw

- **Automatic model selection** — set model to `auto` and Astrai picks the best model per request
- **Cost optimization** — routes simple tasks to cheap models, complex tasks to frontier models
- **Multi-provider failover** — automatic retry chain across all providers
- **OpenAI-compatible API** — standard `/v1/chat/completions` endpoint
- **Task-aware routing** — detects task type (code, research, chat) and picks optimal models

## Routing Strategies

Astrai supports three routing strategies:

| Strategy   | Description                             |
| ---------- | --------------------------------------- |
| `balanced` | Balance cost and quality (default)      |
| `cheapest` | Minimize cost while maintaining quality |
| `fastest`  | Minimize latency                        |

## Setup

### 1. Get API Key

1. Sign up at [astrai-compute.fly.dev](https://astrai-compute.fly.dev)
2. Get your API key (format: `sk-astrai-...`)

### 2. Configure OpenClaw

**Option A: Environment Variable**

```bash
export ASTRAI_API_KEY="sk-astrai-xxxxxxxxxxxx"
```

**Option B: Config file**

```json5
{
  env: { ASTRAI_API_KEY: "sk-astrai-..." },
  agents: { defaults: { model: { primary: "astrai/auto" } } },
}
```

### 3. Verify Setup

```bash
openclaw chat --model astrai/auto "Hello, are you working?"
```

## Model Selection

| Model ID          | Description                                              |
| ----------------- | -------------------------------------------------------- |
| `auto`            | Let Astrai pick the best model per request (recommended) |
| `gpt-4o`          | Route to GPT-4o via cheapest available provider          |
| `claude-sonnet-4` | Route to Claude Sonnet 4 via cheapest provider           |

With `auto`, Astrai classifies each prompt's complexity and routes accordingly:

- **Simple chat/summarization** → cheap models (Groq Llama, DeepInfra)
- **Code generation** → Anthropic Claude or OpenAI Codex
- **Complex reasoning** → frontier models (GPT-4o, Claude Opus)

Change your default model anytime:

```bash
openclaw models set astrai/auto
openclaw models set astrai/gpt-4o
```

## Features

| Feature              | Support                            |
| -------------------- | ---------------------------------- |
| **Streaming**        | Supported                          |
| **Function calling** | Supported (model-dependent)        |
| **Vision/Images**    | Supported on vision-capable models |
| **JSON mode**        | Supported via `response_format`    |

## Config File Example

```json5
{
  env: { ASTRAI_API_KEY: "sk-astrai-..." },
  agents: { defaults: { model: { primary: "astrai/auto" } } },
  models: {
    mode: "merge",
    providers: {
      astrai: {
        baseUrl: "https://astrai-compute.fly.dev/v1",
        apiKey: "${ASTRAI_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "auto",
            name: "Astrai Auto (intelligent routing)",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Usage Examples

```bash
# Automatic model selection (recommended)
openclaw chat --model astrai/auto

# Route to GPT-4o via cheapest provider
openclaw chat --model astrai/gpt-4o

# Route to Claude via cheapest provider
openclaw chat --model astrai/claude-sonnet-4
```

## Links

- [Astrai GitHub](https://github.com/beee003/astrai-landing)
- [API Base URL](https://astrai-compute.fly.dev)
