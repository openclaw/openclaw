---
name: memoria-memory
description: |
  Use Memoria for durable user/project memory in OpenClaw.
  Triggers: "remember this", "save to memory", "what do you remember",
  "forget this", "update memory", "use memoria".
---

# Memoria Memory

Use Memoria tools for durable memory. Do not default to `MEMORY.md` or `memory/YYYY-MM-DD.md` unless the user explicitly asks for file-based memory.

## When to use

- The user asks to remember a fact, preference, decision, or workflow.
- The user asks what you already know about them, the project, or a prior session.
- The user asks to correct or delete stored memory.

## Store

1. Choose the smallest durable fact worth keeping.
2. Use `memory_store` with concise atomic content.
3. After storing something important, verify with `memory_recall` or `memory_search`.

## Recall

1. When the user asks "what do you know" or references prior sessions, query Memoria first.
2. Use `memory_retrieve`/`memory_recall` for semantic retrieval.
3. Use `memory_get` only when you already have a specific `memoria://` path.

## Repair

1. If the user says a memory is wrong or should be removed, use `memory_forget`.
2. Verify the result with `memory_recall` or `memory_list`.

## Rules

- Do not claim only `memory_search` and `memory_get` exist when other `memory_*` tools are available.
- Do not store transient small talk unless it is a stable preference or explicit user request.
- Prefer Memoria for durable cross-session memory; prefer workspace files only for explicit file-based notes.
