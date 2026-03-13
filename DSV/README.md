# OpenClaw — DSV Notes

This folder contains David's notes, analysis, and cross-references for the OpenClaw codebase as it relates to the **X1 AI Advisor** project.

## What OpenClaw Is

OpenClaw is a **local-first personal AI assistant platform** that connects to messaging channels (WhatsApp, Telegram, Slack, Discord, etc.) and delivers intelligent agent responses. It's a complete control plane for running AI assistants locally with integrated messaging, tools, memory, and multi-agent orchestration.

**Tech stack:** TypeScript, Node.js 22+, SQLite (sqlite-vec for vectors), WebSocket gateway, Playwright for browser control.

## Why It's Here

OpenClaw is attached as an **inspiration/reference codebase** for building the X1 AI Advisor. Key areas of interest:

1. **Memory system** — Workspace-based markdown memory + vector search (hybrid BM25 + vector similarity)
2. **Multi-agent routing** — Channel-based routing to isolated agents with per-agent workspaces
3. **Session management** — Isolated conversation contexts, compaction, cross-session coordination
4. **Tool/skill plugin system** — 54 bundled skills, extensible plugin architecture
5. **Browser automation** — CDP-based browser control for in-app actions
6. **Streaming & chunking** — Block streaming with paragraph-aware soft chunks

## Key Files & Directories

| Path | Relevance |
|------|-----------|
| `src/memory/` | Vector memory manager, embeddings, hybrid search — **high relevance** |
| `src/memory/manager.ts` | Memory manager (indexing, search, caching) |
| `src/agents/` | Agent runtime, system prompts, tool definitions |
| `src/gateway/` | WebSocket control plane, session management, config hot-reload |
| `src/session/` | Session management, transcripts, compaction |
| `src/skills/` | Skill registry and installation — plugin model |
| `src/browser/` | Browser control via Playwright CDP — relevant for in-app navigation |
| `src/tools/` | Tool definitions and policy enforcement |
| `src/channels/` | Multi-channel routing — may inspire team-based routing |
| `src/hooks/` | Extensible hook system for pre/post processing |
| `README.md` | Comprehensive 87KB README covering full architecture |
| `AGENTS.md` | Developer guidelines (also linked as CLAUDE.md) |

## Documents in This Folder

| Doc | Purpose |
|-----|---------|
| [README.md](README.md) | This file — overview and index |
| [MEMORY-SYSTEM.md](MEMORY-SYSTEM.md) | Deep dive into OpenClaw's memory architecture |
| [IDEAS-LOG.md](IDEAS-LOG.md) | Ongoing log of ideas inspired by this codebase |
