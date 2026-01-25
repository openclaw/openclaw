---
summary: "Proposal: Add `coding_task` tool powered by the Claude Agent SDK (Claude Code-style; gated by config)"
read_when:
  - You want Claude Code-style planning runs from inside Clawdbot without changing the embedded agent.
  - You want an opt-in integration path for Claude Agent SDK + MCP with tight tool-policy control.
owner: "clawdbot"
status: "draft"
last_updated: "2026-01-25"
---

# Coding Task Tool (Claude Agent SDK) - Proposal

## Context

Clawdbot already has:
- An **embedded, tool-using agent runtime** (Pi embedded) used for normal runs.
- A **CLI backend** mode that can call local CLIs like Claude Code CLI / Codex CLI as a
  **text-only fallback** (see [CLI backends](/gateway/cli-backends)).

This proposal adds a third path: a **first-class tool** that can run a Claude Code-style
coding task on demand, while keeping Clawdbot's existing runtime unchanged.

## Motivation

Operators want:
- A way to use the Claude Code agent harness (planning + repo understanding) inside a Clawdbot
  session, without switching tools or copying context manually.
- A safe, opt-in integration that can gradually expand from "readonly" to more capable modes.

## Goals

- Add a new Clawdbot tool: `coding_task`.
- Keep the integration **opt-in** (disabled by default).
- Safe defaults:
  - Default to a **read-only tool preset** (workspace read/search only).
  - Default `permissionMode="default"` (no bypassing approvals).
  - No MCP bridging in the first pass.
- Keep the implementation isolated in new files and lazy-load the SDK to minimize blast radius.
- Make failures actionable (clear errors when the SDK isn't installed or Claude isn't configured).

## Non-goals (Phase 1)

- Replacing the embedded agent runtime.
- Running a fully autonomous "edit/exec" coding agent in production.
- Exposing Clawdbot tools to Claude via MCP.
- Running the Claude agent inside the Clawdbot Docker sandbox container.

## Proposed User Experience

When enabled, a Clawdbot session can call:

- `coding_task(task="Investigate failing tests in src/foo")`

And receive:
- A structured plan (steps, hypotheses, file targets, next actions).
- Optional metadata (elapsed time, tool usage summary, raw event count).

The calling Clawdbot agent can then decide to:
- Execute the plan itself using existing Clawdbot tools, or
- Ask the user for approval to proceed, or
- Spawn subagents to implement parts of the plan.

## Tool Contract

### Name

- `coding_task`

### Input (Phase 1)

Minimal schema:
- `task` (string, required): what to do (plan, investigate, implement), subject to configured tool gates.

Phase 1 intentionally omits:
- Per-invocation overrides for permissions/tooling (capabilities are configured via `tools.codingTask.*`).
- MCP configuration (no Clawdbot tool bridging yet).

### Output

Tool returns:
- `content`: a text block containing the Claude Code run output (plan, investigation notes, diffs, etc).
- `details`: JSON with fields like:
  - `status`: "ok" | "error"
  - `sdk`: { present: boolean }
  - `events`: { total: number, extractedTextChars: number }
  - `notes`: list of warnings (e.g. "SDK missing; install required")

## Configuration Surface

Add a new config stanza:

```json5
{
  tools: {
    codingTask: {
      enabled: true,
      // Safe defaults:
      // - toolPreset: "readonly" enables only read/search style tools
      // - permissionMode: "default" keeps approvals on (no bypass)
      toolPreset: "readonly",
      permissionMode: "default",

      // Optional: fine-grained Claude Code permission rules
      // (Claude supports patterns like: Bash(git*), Read(~/.ssh/*), Edit(docs/*.md))
      allowedTools: ["Read", "Grep", "Glob"],
      disallowedTools: ["Bash", "Write", "Edit"],

      // Optional: load Claude Code settings files
      settingSources: ["project"],

      // Optional: allow access outside cwd
      additionalDirectories: ["/tmp"]
    }
  }
}
```

Notes:
- `allowedTools` / `disallowedTools` are passed through to Claude Code's permission system.
  Prefer using these for safety instead of `permissionMode="bypassPermissions"`.

## Architecture

### High-Level Flow

1. Calling Clawdbot agent invokes `coding_task`.
2. Tool implementation lazily imports `@anthropic-ai/claude-agent-sdk`.
3. Tool runs the SDK `query(...)` against the current session workspace directory.
4. Tool collects streaming events and extracts a human-readable "plan" text.
5. Tool returns the plan text back to the calling Clawdbot agent.

### Code Boundaries

- New tool implementation file(s) under `src/agents/tools/` (isolated).
- New SDK wrapper helpers under `src/agents/claude-agent-sdk/` (isolated).
- A small conditional registration change in `src/agents/clawdbot-tools.ts`.
- Config typing + validation changes in `src/config/` to accept `tools.codingTask`.

## Security & Policy Model

### Default-off

The tool is not registered unless `tools.codingTask.enabled=true`.

### Capability gate (Phase 1)

Even if called, `coding_task` is intended to be safe-by-default:
- Default `toolPreset="readonly"` (read/search style tools only).
- Default `permissionMode="default"` (no bypassing approvals).
- Operators can explicitly expand capabilities via `tools.codingTask` config.

### Tool policy integration

Clawdbot's tool allow/deny policies still apply because this is just another tool:
- Global (`tools.allow/deny`)
- Agent-specific (`agents.list[].tools.allow/deny`)
- Sandbox tool policy (`tools.sandbox.tools`)
- Subagent tool policy (if invoked from a subagent)

This proposal does not change defaults for any tool profile.

### Sandbox considerations

In Phase 1, `coding_task` runs on the host process and targets the session's effective
workspace directory (which may be a sandbox workspace mirror, depending on sandbox mode).

Future: run the SDK inside the sandbox container or replace its built-in tools with MCP tools
that forward to Clawdbot's sandbox-aware `exec/read/write/edit`.

## Failure Modes & Operator Guidance

- SDK not installed: return a clear error that explains how to enable/install.
- Claude Code not authenticated: return SDK/runtime error, suggest running Claude auth flow.
- Unsupported environment (missing `claude` binary / PATH issues): return actionable error.
- Oversized output: truncate extracted text and return "raw events saved" as a follow-up option
  (future).

## Observability

Phase 1:
- Return basic metadata in tool `details` (event count, extracted chars).
- Keep debug logging behind existing logging controls (no noisy logs by default).

Future:
- Add an opt-in debug mode that writes raw SDK events to a run-local artifact file.

## Testing Strategy

- Config validation: `tools.codingTask.enabled` must be accepted by schema validation.
- Tool registration gating: tool is absent unless config enables it.
- SDK absence behavior: tool returns stable error when SDK import fails.
- Output extraction unit tests (pure functions) for different message shapes.

## Rollout / Adoption

1. Ship as experimental, disabled by default.
2. Document in experiments section.
3. Operators enable per environment where Claude Code is available/configured.
4. Iterate to Phase 2 (MCP bridge) after stabilizing the tool + config surface.

## Open Questions

- What is the minimal read-only Claude tool allowlist that still yields good plans?
- Should `coding_task` be denied by default for subagents (like other orchestration tools)?
- How should the tool behave when Clawdbot sandbox mode is "all" with `workspaceAccess=ro`?
- Where should raw event artifacts live if we add a debug dump mode?
