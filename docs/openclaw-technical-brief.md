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

---

## 3. Our Localization and Development

### Feishu Extension

We contributed bug fixes and new features to the Feishu channel extension — resolving `resolveAllowFrom` string handling issues and adding public permission management (`get_public`, `update_public` actions for `feishu_perm`) with corresponding tests. This work enables OpenClaw to operate within the Chinese enterprise ecosystem. Four Feishu app accounts are configured across our deployment, covering different workspaces and use cases.

### Peekaboo (macOS UI Automation)

Peekaboo is a visual automation tool that captures screenshots, reads UI elements, and performs clicks and text input — letting the agent operate macOS applications without requiring APIs. In practice, we use it for Ctrip travel booking, Photos library browsing, Calendar manipulation, and interaction with arbitrary macOS apps, all driven by natural language commands through messaging channels.

### Deployed Skills

Ten skills are running on a Mac mini M4 with 32 GB RAM:

| Skill | Capability |
|-------|-----------|
| Feishu Doc | Read and write Feishu documents |
| Feishu Drive | Cloud storage file management |
| Feishu Wiki | Knowledge base navigation |
| Feishu Perm | Document permission management |
| Peekaboo | macOS screen capture and UI automation |
| Himalaya | Email management via IMAP/SMTP |
| Coding Agent | Delegate tasks to Codex/Claude Code agents |
| Browser | Web browsing and search via Chrome extension |
| Weather | Current conditions and forecasts |
| Healthcheck | Host security hardening and risk assessment |

### Capabilities in Action

From any connected messaging channel, a user can write Feishu documents, coordinate meetings, automate macOS applications through Peekaboo, manage email, browse the web, and delegate coding tasks — all via natural language. The Gateway routes each request to the appropriate skill, executes tool calls locally, and streams the result back through the same channel the user wrote from.

---

## 4. Performance Results

### Test Environment

All measurements were collected on a Mac mini M4 (Apple Silicon) with 32 GB RAM on standard home broadband. The cloud model was Claude Sonnet 4.6 via the Anthropic API through the OpenClaw Gateway. The local model was qwen3:8b (8B parameters) on Ollama, called directly through its local API.

### Simple Q&A

A factual question requiring no tools — pure language model reasoning (explain the three laws of thermodynamics, each in one sentence):

| Metric | Cloud (Claude Sonnet) | Local (qwen3:8b) |
|--------|----------------------|-------------------|
| Response time | ~9 seconds | ~57 seconds |
| Quality | Excellent (5/5) — accurate, concise, bonus context | Good (4/5) — accurate, slightly verbose |
| Tokens generated | ~150 | ~949 (includes internal reasoning) |

The cloud model returned a polished answer in under ten seconds and included the zeroth law unprompted. The local model was accurate but took roughly 6x longer, spending most tokens on internal chain-of-thought reasoning.

### File Operations

Reading a 20-line file, adding line numbers, and writing it back — exercises tool calling (read + write) in addition to reasoning:

| Metric | Cloud (Claude Sonnet) | Local (qwen3:8b) |
|--------|----------------------|-------------------|
| Total time | ~12.5 seconds | ~60-70 seconds (estimated) |
| Tool calls | 2 (read + write) | Expected similar |
| Accuracy | Perfect | Not tested end-to-end |

The cloud model completed the operation in 12.5 seconds with two tool calls and a perfect result. The local estimate is extrapolated from the 6x speed ratio observed in Q&A.

### Analysis

Cloud models deliver roughly 6x faster responses with more polished output. For tasks requiring speed, complex reasoning, or multi-step tool chains, cloud is the clear choice — 9 seconds for factual Q&A and 12.5 seconds for file operations feel conversational.

Local models win on privacy (no data leaves your machine), offline availability, and cost (free after hardware investment). The practical sweet spot is hybrid mode: route demanding tasks to cloud, handle routine queries locally. OpenClaw makes this seamless — configure your preferred model order once, and the Gateway routes automatically.
