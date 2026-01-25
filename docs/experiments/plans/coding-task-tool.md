---
summary: "Plan: Implement experimental `coding_task` tool powered by Claude Agent SDK (Claude Code-style; tool-gated, readonly default)"
owner: "clawdbot"
status: "draft"
last_updated: "2026-01-25"
---

# Coding Task Tool (Claude Agent SDK) - Implementation Plan

This plan implements the proposal in:
- [Coding Task Tool (Claude Agent SDK) - Proposal](/experiments/proposals/coding-task-tool)

The plan is intentionally staged:
- Phase 1 is "readonly by default" and low-risk.
- Later phases incrementally add capability (MCP bridge, sandbox alignment).

## Phase 0 - Preconditions and Guardrails

### Preconditions

- Operator has Claude Code installed and authenticated on the gateway host (or wherever the
  gateway runs).
- The gateway runtime has a stable `PATH` or uses an absolute `claude` path (launchd/systemd
  environments may need config).

### Guardrails (must-have)

- Tool must be **disabled by default**.
- Tool must be **registered conditionally** (no accidental availability).
- Tool must be **safe-by-default** in Phase 1:
  - `toolPreset="readonly"` (no write/edit/exec)
  - `permissionMode="default"` (no bypassing approvals)
- Tool must fail with an actionable message if SDK or runtime is missing.

## Phase 1 - Tool-Gated `coding_task` Tool (MVP)

### Scope

- Add a new tool `coding_task` that runs a Claude Agent SDK query against the current workspace.
- The tool should be safe and deterministic enough to run in normal agent sessions.
- No MCP bridge (no Clawdbot tool forwarding yet).
- Capability expansion is controlled by `tools.codingTask.*` (tool preset + permission rules).

### Deliverables

1. Config + schema support:
   - `tools.codingTask.enabled: boolean` accepted by config validation.
   - `tools.codingTask` supports tool/permission controls (preset, allow/deny rules, setting sources, etc).

2. Tool registration:
   - `coding_task` only exists when enabled via config.

3. Tool execution (tool-gated):
   - Uses `@anthropic-ai/claude-agent-sdk` via lazy import.
   - Runs against the current session workspace (effective workspace when sandboxed).
   - Passes through `tools.codingTask.*` to the SDK as query options.
   - Returns extracted result text + metadata.

### Detailed Tasks

#### 1) Config typing + validation

- Update `src/config/types.tools.ts`
  - Add:
    - `ToolsConfig.codingTask?: { enabled?: boolean, ... }`
- Update `src/config/zod-schema.agent-runtime.ts`
  - Extend `ToolsSchema` to allow:
    - `codingTask: { enabled?: boolean, permissionMode?, toolPreset?, allowedTools?, disallowedTools?, settingSources?, additionalDirectories? }`

Acceptance:
- `validateConfigObject({ tools: { codingTask: { enabled: true } } })` succeeds.
- Unknown keys under `tools.codingTask` are rejected (schema remains strict).

#### 2) Implement the tool (isolated files)

- Add `src/agents/tools/coding-task-tool.ts`
  - `createCodingTaskTool({ config, workspaceDir })` returns an `AnyAgentTool`
  - Tool schema:
    - `task: string` (required)
  - Execution:
    - Build SDK options from `tools.codingTask` (preset + allow/deny rules)
    - Provide a `canUseTool` callback to auto-deny tool requests that would otherwise prompt
    - Collect streaming events and extract a plan text
    - Return `{ status, text, metadata }` via tool result
  - Error handling:
    - If SDK import fails: return "SDK missing" with install hint
    - If runtime fails: return error with minimal redaction

Implementation notes:
- Use lazy `await import("@anthropic-ai/claude-agent-sdk")` inside `execute(...)`.
- Keep the SDK wrapper logic in the same file or a sibling helper module (see next task).

Optional helper:
- Add `src/agents/claude-agent-sdk/extract.ts`
  - Pure functions for extracting text from SDK events (unit-testable).

#### 3) Register tool behind flag

- Update `src/agents/clawdbot-tools.ts`
  - If `config?.tools?.codingTask?.enabled === true`, append `coding_task` tool.
  - Otherwise do nothing.

Acceptance:
- Default runtime has no `coding_task` tool.
- Enabling config makes it show up (subject to tool policy filtering).

#### 4) Tests

- Add config validation test:
  - `src/config/config.coding-task-tool.test.ts`
- Add tool gating/error tests:
  - `src/agents/tools/coding-task-tool.test.ts`
  - Verify:
    - tool absent when disabled
    - tool present when enabled
    - calling execute without SDK installed returns stable error payload
- Add options builder tests (no SDK required):
  - `src/agents/claude-agent-sdk/coding-task-options.test.ts`
- Add pure-function tests for event text extraction if a helper module exists.

#### 5) Manual verification steps

Preconditions:
- Claude Code is installed and authenticated on the machine running the gateway.
- `@anthropic-ai/claude-agent-sdk` is installed and resolvable by the Clawdbot runtime.
- The agent you're testing has a tool policy that allows calling `coding_task` (for example, `tools.profile="coding"`).

1. Enable in config (readonly preset):
   ```json5
   {
     tools: {
       profile: "coding",
       codingTask: {
         enabled: true,
         toolPreset: "readonly",
         permissionMode: "default"
       }
     }
   }
   ```
2. Restart the gateway to pick up config changes (macOS: restart via the Clawdbot mac app).
3. Start a new TUI session and send a smoke-test message:
   ```bash
   clawdbot tui --new --agent <agentId> --deliver --message 'Use coding_task to: (1) grep for "createClawdbotTools" and summarize what it does, (2) read src/agents/tool-policy.ts and list the tool groups, (3) try to write a file "coding-task-smoke.txt" with text "hi", and (4) try to run `git status` with Bash. If any step is blocked, say which tool was blocked.'
   ```
4. Confirm (readonly gating):
   - The `coding_task` run can read/grep successfully.
   - The run does **not** modify the repo (run `git status` yourself after the run).
   - Attempts to use write/edit/exec tools are denied (expect mention of blocked `Write`/`Edit`/`Bash`).

Optional: expand capabilities (example: allow write/edit + limited bash)
```json5
{
  tools: {
    codingTask: {
      toolPreset: "claude_code",
      allowedTools: ["Read", "Grep", "Glob", "LS", "Edit", "Write", "Bash(git*)"],
      disallowedTools: ["AskUserQuestion", "ExitPlanMode"]
    }
  }
}
```

### Rollback

- Remove `tools.codingTask.enabled` from config (tool disappears).
- No other runtime paths should change.

## Phase 2 - MCP Bridge (Expose Subset of Clawdbot Tools)

### Scope

Expose a small, policy-respecting subset of Clawdbot tools to the Claude agent via MCP:
- Candidate tools:
  - `sessions_send`
  - `sessions_list`
  - `message` (send only)
  - `web_fetch` (optional)

### Key design constraints

- Enforce Clawdbot tool policy and sandbox rules.
- Avoid exposing raw `exec` or write/edit operations until sandbox alignment is complete.
- Audit all inputs/outputs to avoid secret leakage via tool logs.

Deliverables:
- MCP server implementation (in-repo) that forwards calls to existing Clawdbot tool handlers.
- Config gating for MCP enablement.
- Tests for policy enforcement and tool mapping.

## Phase 3 - Sandbox Alignment (Optional)

### Goal

Ensure that when a session is sandboxed, the Claude agent runs with equivalent restrictions:
- Either run the SDK inside the sandbox container, or
- Replace built-in filesystem/exec tooling with MCP forwarders to sandbox-aware tools.

This phase is intentionally deferred until Phase 1/2 stabilize.

## Risks / Mitigations

- Risk: SDK API drift.
  - Mitigation: lazy import + runtime shape checks + stable error messages.
- Risk: accidental capability expansion.
  - Mitigation: readonly preset by default; explicit config required to allow write/exec.
- Risk: tool policy surprises (tool enabled but filtered out).
  - Mitigation: return guidance in docs; optionally add a warning log when enabled but filtered.

## Definition of Done (Phase 1)

- Tool exists only when enabled by config.
- Config validation accepts `tools.codingTask`.
- Unit tests cover gating and SDK-missing behavior.
- Docs exist (proposal + plan) under experiments.
