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
