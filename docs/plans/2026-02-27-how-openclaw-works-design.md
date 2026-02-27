# Design: "How OpenClaw Works" Overview Document

**Date**: 2026-02-27
**Status**: Approved
**Audience**: New users and evaluators
**Format**: Standalone markdown (~1.5 pages)
**Structure**: System-layer walkthrough with flow diagram

## Purpose

A concise introduction to OpenClaw's internals for newcomers who want to understand how the system works at a high level. Covers four topics: agent workflow, memory system, LLM-driven logic, and local computer interaction.

## Sections

### 1. What is OpenClaw (~1 paragraph)

One paragraph introducing OpenClaw as a personal AI assistant running locally as a gateway daemon, connecting to messaging channels and companion apps. You message it; it thinks, acts on your computer, and replies.

### 2. The Agent Workflow (~2 paragraphs + diagram)

The message lifecycle from user input to reply delivery:

- User sends message via any channel
- Gateway receives and routes to a session (serialized, one turn at a time)
- Agent runtime loads workspace context + session history
- LLM inference produces text and/or tool calls
- Tools execute locally, results feed back into the model loop
- Final reply streams back through the channel

Includes an ASCII flow diagram:

```
User -> Channel -> Gateway -> Session Queue -> Agent Runtime -> LLM <-> Tools -> Reply -> Channel -> User
```

### 3. Memory and Context (~2 paragraphs)

Three layers:

- **Bootstrap files**: Identity (SOUL.md), instructions (AGENTS.md), user profile (USER.md), curated memory (MEMORY.md) loaded at session start
- **Session history**: JSONL transcripts with automatic compaction and pre-compaction memory flush
- **Semantic search**: Vector embeddings over workspace files for cross-session recall via hybrid keyword + vector search

### 4. LLM Model-Driven Logic (~1 paragraph)

The agent runtime calls the configured LLM with system prompt + history. The model decides: reply with text, call a tool, or both. Tool results feed back for continued reasoning. Loop repeats until final text reply. Fallback models activate on provider errors. Supports multiple providers (Anthropic, OpenAI, Google, Mistral, etc.).

### 5. Local Computer Interaction (~2 paragraphs)

The tool system:

- **Built-in tools**: exec (shell commands), read/write/edit (files), channel-specific actions
- **Extended capabilities**: Browser automation, web search, media understanding, cron scheduling
- **Safety**: Tool policies per channel/session, optional sandboxing, workspace as default working directory

## Constraints

- No code snippets or config examples (keep accessible)
- No internal file paths or implementation details
- Generic placeholders only (no personal device names)
- Standalone file, not published to Mintlify
