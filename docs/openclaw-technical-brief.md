# OpenClaw — Technical Brief

## 1. Technical Overview

OpenClaw is a personal AI assistant that runs as a single background daemon — the Gateway — on your own hardware. The Gateway owns all channel connections, session state, and tool execution. It routes messages from 12+ channels (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Feishu, and others) into a unified agent runtime, serializing each conversation so only one turn runs at a time.

The agent follows a think-act-observe loop:

```
Message In → [Assemble Context] → [Send to LLM]
                                       |
                              Reply? ──Yes──→ Stream reply out
                                       |
                                      No
                                       ↓
                              [Execute Tool] → [Observe Result] → back to LLM
```

The model reads the assembled context — persona, memory, conversation history — and decides whether to reply or take action. Tool results feed back into the model for continued reasoning until a final reply streams out.

**Model flexibility.** OpenClaw supports 10+ cloud providers (Anthropic, OpenAI, Google, DeepSeek, Qwen, Mistral, OpenRouter) and local inference engines (Ollama, vLLM, LM Studio). Hybrid mode designates a primary model with automatic fallback — cooldown and probe-based recovery happen without manual intervention.

**Memory system.** Three layers provide continuity: (1) bootstrap files — Markdown files loaded at session start containing persona, instructions, user profile, and accumulated notes; (2) session history — conversation transcripts with automatic compaction that flushes important notes to memory before trimming; (3) semantic search — vector embeddings over workspace files enabling cross-session recall via hybrid keyword (30%) + vector similarity (70%) search.

**Scheduling.** Per-session serial queues ensure one turn at a time per conversation. A global concurrency limit caps parallel sessions. Rapid-fire messages are debounced and batched into a single delivery.

**Tool system.** Shell commands, file operations, browser automation, media understanding, scheduled tasks (cron), and webhooks — all sandboxed with per-channel policies that control what each conversation is allowed to do.

---

## 2. Comparison with Alternatives

A one-sentence mental model for each project:

- **Auto-GPT** — autonomous task runner that launches one-shot missions to completion.
- **LangChain Agent** — developer toolkit for building custom agents, not a ready-to-use product.
- **Open Interpreter** — smart terminal with session-scoped CLI interaction.
- **Claude Code** — AI pair programmer integrated into IDE and command line.
- **OpenClaw** — personal assistant that lives in your messaging apps.

| Dimension | OpenClaw | Auto-GPT | Open Interpreter | LangChain Agent | Claude Code |
|-----------|----------|----------|-----------------|-----------------|-------------|
| Positioning | Always-on personal assistant | Autonomous task runner | Smart terminal | Developer framework | AI pair programmer |
| Multi-channel | 12+ native channels | None | None | Build your own | None |
| Always-on | Yes (Gateway daemon) | No (run-to-complete) | No (session) | Depends on build | No (session) |
| Persistent Memory | 3-layer system | Short-term + vector | Session only | Build your own | Session + project |
| Local Models | Native (Ollama, vLLM, LM Studio) | Limited | Yes | Via wrappers | No |
| Local-first Data | Yes — all data on your machine | Partial | Yes | Depends | Yes |

**Strengths.** Always-on presence across 12+ messaging channels means you interact through apps you already use — no special interface required. Native support for Chinese ecosystem channels (Feishu) and providers (Qwen, DeepSeek) serves users in that region. Local-first architecture keeps all conversations and memory on your hardware. The three-layer memory system provides continuity that survives individual sessions. A plugin architecture makes it straightforward to add channels, tools, or behaviors.

**Limitations.** OpenClaw is single-user by design — a personal assistant, not a team platform. The Gateway requires always-on hardware (a local machine or server you control). Initial setup — model provider, channel connections, memory configuration — has a steeper learning curve than hosted solutions. Local model quality depends directly on available hardware; smaller machines are limited to smaller models.
