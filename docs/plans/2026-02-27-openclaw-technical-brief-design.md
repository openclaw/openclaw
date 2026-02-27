# OpenClaw Technical Brief — Design Document

## Purpose

A concise (~1200 words) shareable document for colleagues and supervisors, focused on OpenClaw's technology, competitive positioning, local development achievements, and real-world performance. Bilingual (EN + zh-CN).

## Audience

Coworkers and supervisors — technical enough to appreciate architecture details, but not necessarily familiar with OpenClaw.

## Approach

Tech-first narrative (Approach A): lead with technical substance, anchor on comparison table, then show local development work and proof via benchmarks.

## Files

- Create: `docs/openclaw-technical-brief.md` (EN)
- Create: `docs/openclaw-technical-brief.zh-CN.md` (zh-CN)
- Existing `docs/how-openclaw-works.md` and `docs/how-openclaw-works.zh-CN.md` remain untouched

## Structure (~1200 words total)

### Section 1: OpenClaw Technical Overview (~250 words)

Focus on the tech:
- Gateway architecture: single daemon, multi-channel routing (12+ channels including WhatsApp, Telegram, Slack, Feishu), session serialization
- Think-act-observe agent loop with ASCII diagram
- Model flexibility: 10+ cloud providers (Anthropic, OpenAI, DeepSeek, Qwen, etc.) + local models (Ollama, vLLM, LM Studio) + hybrid failover with automatic cooldown/probe recovery
- 3-layer memory system: bootstrap files (notebook), session history (filing cabinet), semantic vector search (librarian)
- Scheduling: per-session serial queues + global concurrency limit
- Tool execution: shell, files, browser, media, cron, webhooks — sandboxed with per-channel policies

### Section 2: Comparison with Alternatives (~250 words)

- One-sentence mental models for each: Auto-GPT, Open Interpreter, LangChain Agent, Claude Code, OpenClaw
- Comparison table (6 dimensions: positioning, multi-channel, always-on, persistent memory, local models, local-first data)
- Condensed strengths paragraph (always-on multi-channel, local-first, 3-layer memory, broad model support, plugin architecture)
- Condensed limitations paragraph (single-user, requires always-on hardware, steeper initial setup, local model quality depends on hardware)

### Section 3: Our Localization and Development (~350 words)

- **Feishu extension**: bug fixes (resolveAllowFrom string handling), new features (public permission management for feishu_perm), tests — enabling OpenClaw in the Chinese enterprise ecosystem
- **Peekaboo (macOS UI automation)**: visual automation tool that captures screenshots, reads UI elements, performs clicks/input — enables OpenClaw to operate apps without APIs. Real usage: Ctrip travel booking, Photos library browsing, Calendar manipulation, arbitrary macOS app interaction — all via natural language
- **Full tool deployment**: 10 ready skills on Mac mini M4 — Feishu doc/drive/wiki/permission (4 app accounts configured), Peekaboo, Himalaya email (IMAP/SMTP), coding agent delegation, browser automation via Chrome extension, weather, healthcheck, skill-creator
- **Capabilities in action**: Feishu document writing/meeting coordination/file uploads, macOS app automation via Peekaboo, email management, web search and browsing, cross-platform communication — all from messaging apps via natural language

### Section 4: Performance Results (~250 words)

- Test environment: Mac mini M4 (Apple Silicon), 32 GB RAM, standard home broadband
- Cloud model: Claude Sonnet 4.6 via Anthropic API through OpenClaw Gateway
- Local model: qwen3:8b (8B params) on Ollama, direct local API
- Use Case 1: Simple Q&A (thermodynamics) — cloud ~9s vs local ~57s, both accurate
- Use Case 2: File operations (read + number + write 20 lines) — cloud ~12.5s, 2 tool calls, perfect result
- Analysis: cloud ~6x faster, local wins on privacy/offline/cost; hybrid approach recommended

## Style Guidelines

- Conceptual and mental-model driven, minimal code/config
- Readable by non-programmers while giving developers quick understanding
- Include Chinese ecosystem references (Feishu, Qwen, DeepSeek) naturally
- Tables for comparison — easy to scan
- ~1200 words total per language version
