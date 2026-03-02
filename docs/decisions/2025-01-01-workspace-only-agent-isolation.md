# ADR: Workspace-Only Agent Isolation

**Date:** 2025-01-01 (reconstructed)

## Context

Coding agents (Codex, Claude Code, opencode) spawned by OpenClaw need to be isolated from the OpenClaw codebase itself — an agent working on a user's project should not be able to read or modify OpenClaw's own config, session data, or source.

## Decision

Agents run with `workdir` scoped to the user's workspace. The `~/.openclaw/` directory is never exposed to spawned agents. Sub-agents working in `~/openclaw/` (the Nova/PR pipeline repo) operate under the same isolation: never spawn agents inside `~/.openclaw/workspace/` itself.

## Consequences

- Agents can't accidentally exfiltrate session data or modify OpenClaw config
- Prompts must be explicit about workdir; agents "wake up" in a focused directory
- Never start a coding agent in `~/.openclaw/` — it will read soul docs and get confused about the org chart
