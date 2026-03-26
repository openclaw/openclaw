# Telegram Agentic Loop Extension — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Author:** Jeff + Claude
**Sub-Project:** 2 of 5 (Fleet Migration)
**Depends on:** Sub-Project 1 (Fleet Upgrade Manager)

---

## Problem

The custom OpenClaw fork runs a 1,900-line Python Telegram bot (`shared/telegram_bot.py` + `shared/chat_tools.py`) that provides:

- An agentic multi-step tool-calling loop (up to 5 iterations per message)
- 27 custom tools spanning fleet management, knowledge queries, web search, GitHub operations, Archon task tracking, Claude Code delegation, art pipeline control, and self-introspection
- Custom `<tool_call>` XML parsing for models that lack native function-calling
- Telegram Bot API long-polling with owner authorization, topic-based routing, and message splitting
- Notification batching (critical=5m, high=hourly, medium=3h) via a separate cron system
- Background task delegation to Claude Code CLI on fleet nodes

Upstream OpenClaw already provides a Telegram channel extension (`extensions/telegram/`) with DM/group policies, streaming, mention gating, and voice notes. It also provides a mature agent loop (`pi-agent-core`) with native tool execution, session management, compaction, and streaming. However, upstream knows nothing about Jeff's fleet infrastructure, custom tools, or Archon integration.

The custom bot must be retired in favor of upstream's Telegram channel, with all 27 tools ported as upstream-compatible extensions or MCP servers.

## Goal

Port all agentic Telegram bot capabilities as an upstream OpenClaw plugin extension (`extensions/telegram-agentic/`) that:

1. Registers all custom tools through upstream's plugin SDK `api.registerTool()` or via connected MCP servers
2. Uses upstream's built-in agent loop instead of the custom Python `agentic_chat()` loop
3. Preserves Claude Code delegation, Archon integration, and fleet management capabilities
4. Works alongside (not instead of) upstream's existing Telegram channel extension
5. Requires zero changes to upstream core code

## Solution

A **tool/hook plugin** (`telegram-agentic`) that registers custom tools and hooks into upstream's agent lifecycle. The plugin does NOT replace the Telegram channel — it augments whatever channel is active (Telegram, Discord, CLI) with fleet-specific tools. The name includes "telegram" only because that is the primary channel these tools were designed for.

Heavy Python-based tools (fleet SSH, knowledge API, art pipeline) run as **MCP servers** so they can stay in Python. Lightweight tools that are pure HTTP calls get ported to TypeScript and registered directly via the plugin SDK.

---

## 1. Extension Architecture

### Directory Structure

```
extensions/telegram-agentic/
  openclaw.plugin.json          # Plugin manifest
  package.json                  # pnpm workspace package
  tsconfig.json
  index.ts                      # Plugin entry point (definePluginEntry)
  src/
    tools/                      # TypeScript tool implementations
      web-tools.ts              # web_search, fetch_url
      github-tools.ts           # github_search, github_repo_info, github_create_repo, github_clone_repo
      report-tools.ts           # save_report
    hooks/
      session-observability.ts  # session_start/session_end hooks for AOP events
      notification-batching.ts  # message_sending hook for batching logic
    mcp/
      fleet-mcp-config.ts       # MCP server connection config for fleet tools
      archon-mcp-config.ts      # MCP server connection config for Archon tools
  mcp-servers/                  # Standalone MCP server processes (Python)
    fleet-tools/
      server.py                 # Fleet MCP server: fleet_status, node_status, node_exec, node_logs, node_restart
      requirements.txt
    knowledge-tools/
      server.py                 # Knowledge MCP server: knowledge_search, knowledge_entity
      requirements.txt
    pipeline-tools/
      server.py                 # Art pipeline MCP server: pipeline_status, pipeline_start, pipeline_stop
      requirements.txt
    delegation-tools/
      server.py                 # Delegation MCP server: delegate_task, claude_code_run, task_create
      requirements.txt
    self-tools/
      server.py                 # Self-introspection MCP server: source_read, self_edit
      requirements.txt
```

### Plugin Manifest

```json
{
  "id": "telegram-agentic",
  "name": "Agentic Fleet Tools",
  "description": "Fleet management, knowledge, delegation, and art pipeline tools for the OpenClaw fleet",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "fleetMcpUrl": { "type": "string" },
      "knowledgeMcpUrl": { "type": "string" },
      "pipelineMcpUrl": { "type": "string" },
      "delegationMcpUrl": { "type": "string" },
      "selfToolsMcpUrl": { "type": "string" },
      "archonMcpUrl": { "type": "string" },
      "notificationBatching": {
        "type": "object",
        "properties": {
          "critical": { "type": "number", "description": "Minutes between critical batches" },
          "high": { "type": "number", "description": "Minutes between high-priority batches" },
          "medium": { "type": "number", "description": "Minutes between medium-priority batches" }
        }
      }
    }
  }
}
```

### Package.json

```json
{
  "name": "@openclaw/telegram-agentic",
  "version": "1.0.0",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"]
  }
}
```

---

## 2. Tool Migration Matrix

All 27 custom tools accounted for. The "Strategy" column indicates how each tool migrates.

| # | Custom Tool | Category | Strategy | Target | Notes |
|---|------------|----------|----------|--------|-------|
| 1 | `web_search` | Web | **Drop** | Upstream `duckduckgo` extension | Upstream already has DuckDuckGo, Brave, Exa, Tavily search extensions |
| 2 | `fetch_url` | Web | **Drop** | Upstream built-in | Upstream has web fetch/browse capabilities in core |
| 3 | `github_search` | GitHub | **TS tool** | `github-tools.ts` | Simple REST API call, easy TypeScript port |
| 4 | `github_repo_info` | GitHub | **TS tool** | `github-tools.ts` | Simple REST API call |
| 5 | `github_create_repo` | GitHub | **TS tool** | `github-tools.ts` | `gh` CLI wrapper via SSH; could also be TS with GitHub REST |
| 6 | `github_clone_repo` | GitHub | **MCP (fleet)** | `fleet-tools/server.py` | Requires SSH to fleet node — belongs with fleet tools |
| 7 | `fleet_status` | Fleet | **MCP (fleet)** | `fleet-tools/server.py` | Fleet-specific, SSH-based, keep in Python |
| 8 | `node_status` | Fleet | **MCP (fleet)** | `fleet-tools/server.py` | Fleet-specific, SSH-based |
| 9 | `node_exec` | Fleet | **MCP (fleet)** | `fleet-tools/server.py` | Remote shell execution via SSH |
| 10 | `node_logs` | Fleet | **MCP (fleet)** | `fleet-tools/server.py` | Docker log fetching via SSH |
| 11 | `node_restart` | Fleet | **MCP (fleet)** | `fleet-tools/server.py` | Docker container restart via SSH |
| 12 | `knowledge_search` | Knowledge | **MCP (knowledge)** | `knowledge-tools/server.py` | Calls Knowledge API on Pop!_OS (:8890) |
| 13 | `knowledge_entity` | Knowledge | **MCP (knowledge)** | `knowledge-tools/server.py` | Calls Knowledge API |
| 14 | `save_report` | Report | **TS tool** | `report-tools.ts` | Writes markdown to Obsidian vault via HTTP/filesystem |
| 15 | `project_scaffold` | GitHub | **MCP (fleet)** | `fleet-tools/server.py` | Runs shell command on fleet node via SSH |
| 16 | `task_create` | Archon | **Drop** | Archon MCP server | Already exposed via `mcp__archon__manage_task` |
| 17 | `claude_code_run` | Delegation | **MCP (delegation)** | `delegation-tools/server.py` | Spawns Claude Code CLI on fleet node |
| 18 | `archon_query` | Archon | **Drop** | Archon MCP server | Already exposed via `mcp__archon__find_tasks` etc. |
| 19 | `archon_agent_run` | Archon | **Drop** | Archon MCP server | Available via Archon MCP |
| 20 | `archon_agent_create` | Archon | **Drop** | Archon MCP server | Available via Archon MCP |
| 21 | `source_read` | Self | **MCP (self)** | `self-tools/server.py` | Reads own source; needs workspace path context |
| 22 | `self_edit` | Self | **MCP (self)** | `self-tools/server.py` | Edits own source on branch; needs git context |
| 23 | `delegate_task` | Delegation | **MCP (delegation)** | `delegation-tools/server.py` | Core delegation flow: creates Archon task, worker picks up |
| 24 | `pipeline_status` | Art | **MCP (pipeline)** | `pipeline-tools/server.py` | HumbleForge service status via SSH to Kubuntu |
| 25 | `pipeline_start` | Art | **MCP (pipeline)** | `pipeline-tools/server.py` | Start GPU service with lock contention handling |
| 26 | `pipeline_stop` | Art | **MCP (pipeline)** | `pipeline-tools/server.py` | Stop GPU service, release VRAM |
| 27 | `gemini_deep_research` | Web | **MCP (delegation)** | `delegation-tools/server.py` | Browser automation on Mac via SSH; slow (10min timeout) |
| — | `notebooklm_research` | Web | **MCP (delegation)** | `delegation-tools/server.py` | Browser automation on Mac via SSH; slow |

### Summary

- **4 tools dropped** (upstream equivalents): `web_search`, `fetch_url`, `task_create`, `archon_query`, `archon_agent_run`, `archon_agent_create` (6 total including Archon tools already exposed via MCP)
- **4 tools ported to TypeScript**: `github_search`, `github_repo_info`, `github_create_repo`, `save_report`
- **17 tools as MCP servers** (5 servers): fleet (6 tools), knowledge (2), pipeline (3), delegation (4+2 browser), self (2)

---

## 3. Agentic Loop Strategy

### Decision: Adopt Upstream's Agent Loop

The custom `agentic_chat()` function in `shared/chat_tools.py` implements a manual loop:

1. Send prompt + tool definitions to LLM
2. Parse `<tool_call>` XML blocks from response text
3. Execute tools, append results to conversation
4. Repeat up to 5 iterations

This was necessary because the custom fork used a simple LLM router that didn't support native function-calling. Upstream's agent loop (`pi-agent-core`) provides:

- Native function-calling with proper tool schemas
- Session serialization and concurrency control
- Streaming assistant/tool deltas
- Auto-compaction and retry on context overflow
- Configurable timeout (default 600s)
- Hook points at every stage (before_tool_call, after_tool_call, etc.)

**The custom agentic loop is retired entirely.** All tools are registered via `api.registerTool()` or connected as MCP servers, and upstream's agent loop handles invocation, iteration limits, and response assembly.

### Iteration Limit

The custom bot uses `MAX_ITERATIONS = 5`. Upstream's default is controlled by `agents.defaults.timeoutSeconds` (600s). This is sufficient — upstream's loop will naturally stop when the model emits a final response without tool calls, same as the custom loop.

If an explicit iteration cap is needed, it can be enforced via a `before_tool_call` hook that counts tool invocations per session run and returns `{ block: true }` after N calls.

### Tool Prompt Injection

The custom bot builds a text-based tool prompt and injects it into the system prompt. Upstream handles this natively — registered tools appear in the model's tool schema automatically. No prompt injection needed.

---

## 4. Claude Code Delegation Architecture

### Current Design

The custom `delegate_task` tool:

1. Creates an Archon task with metadata (`target_node`, `working_dir`, `source: delegate_task`)
2. Returns immediately with a task ID
3. A distributed worker (`shared/task_worker.py`) on the target node polls Archon for `todo` tasks
4. Worker spawns Claude Code CLI in a git worktree, streams output
5. Worker updates Archon task status and sends Telegram notification on completion

### Upstream Design

The delegation pattern maps cleanly to upstream's architecture:

```
User message via Telegram
  → Upstream agent loop
    → agent calls `delegate_task` MCP tool
      → delegation-tools MCP server creates Archon task
        → Worker on target node picks up task (unchanged)
        → Worker spawns Claude Code CLI (unchanged)
        → Worker updates Archon task, sends notification
```

The key insight is that the **worker fleet is outside OpenClaw's process**. The `delegate_task` tool just needs to create an Archon task — the workers are independent processes. This means:

- The `delegation-tools` MCP server is a thin wrapper around Archon's task creation API
- No changes needed to `shared/task_worker.py` or the worker fleet
- The MCP server runs on Gateway alongside the OpenClaw process
- Task status is queryable via the already-connected Archon MCP server (`mcp__archon__find_tasks`)

### Claude Code Run (Synchronous)

The `claude_code_run` tool runs Claude Code synchronously and returns the output. In the MCP server, this becomes an SSH command to the target node that blocks until completion (with a configurable timeout). This is the "quick task" variant vs. `delegate_task`'s "background task" pattern.

---

## 5. Archon Integration

### Current State

The custom bot connects to Archon in two ways:

1. **Direct HTTP calls** from tool executors (`_exec_archon_query`, `_exec_archon_agent_run`, etc.)
2. **MCP server** (`archon-mcp` at port 8051) already connected to Claude Code sessions

### Upstream Design

Archon MCP server is already connected and provides:

- `mcp__archon__find_tasks` — replaces `archon_query(query_type='tasks')`
- `mcp__archon__manage_task` — replaces `task_create`
- `mcp__archon__find_projects` — project queries
- `mcp__archon__rag_search_knowledge_base` — knowledge base search

The Archon MCP connection is configured in the OpenClaw gateway config, not in this plugin. This plugin just needs to document that the Archon MCP server must be listed in the gateway's MCP server configuration.

**No Archon-specific tools in this plugin.** The 4 Archon tools (`archon_query`, `archon_agent_run`, `archon_agent_create`, `task_create`) are fully covered by the existing Archon MCP server's tool surface.

---

## 6. Notification System

### Current Design

The custom fork has 3-tier notification batching:

- **Critical** (5 min window): Security alerts, node failures
- **High** (1 hour window): Task completions, deployment results
- **Medium** (3 hour window): Cron summaries, cost reports

This runs as a cron job that aggregates queued notifications and sends a single Telegram message per batch.

### Upstream Design

Upstream's Telegram channel already handles message delivery. The batching logic ports as a `message_sending` plugin hook:

1. On `message_sending` hook, check the message's priority tag (set by the originating tool or hook)
2. If priority is not "critical", queue the message in an in-memory buffer with a TTL
3. A periodic timer (configured per priority tier) flushes the buffer
4. Critical messages pass through immediately (hook returns `{ cancel: false }`)

Implementation detail: the hook uses `api.runtime.system.requestHeartbeatNow` to wake the flush timer, and `createPluginRuntimeStore` to persist batch state across gateway restarts.

If upstream's hook semantics make this awkward (e.g., `message_sending` hooks can cancel but not delay), the fallback is a separate notification queue service that tools write to, with a flush loop that calls the Telegram API directly. This is a degraded but functional approach.

---

## 7. Session Management & Observability

### Current Design

The custom bot emits observability events via `shared/logger.log_event()` to `all.jsonl`:

- `agentic.loop_start`, `agentic.tool_round`, `agentic.tool_exec`, `agentic.complete`
- Session correlation via `chat_id` and `thread_id`
- Cost tracking per LLM call

### Upstream Design

Register hooks for observability events:

```
session_start    → Emit AOP session_start event with sessionKey
session_end      → Emit AOP session_end event with duration, tool count, model used
before_tool_call → Emit AOP tool_start event
after_tool_call  → Emit AOP tool_end event with duration and result size
agent_end        → Emit AOP session_complete with final metrics
```

These hooks write to the same `all.jsonl` format the AOP system already consumes, maintaining backward compatibility with the existing analytics pipeline (`shared/analytics/`).

The `sessionKey` provided by upstream's lifecycle hooks replaces the custom `chat_id`-based correlation. A mapping from `sessionKey` to Telegram `chat_id` + `thread_id` is maintained by the Telegram channel extension itself.

---

## 8. MCP Server Architecture

### Why MCP for Python Tools

The 17 tools staying in Python need SSH access to fleet nodes, filesystem access to the workspace, and dependencies on Python libraries (`paramiko`, `requests`, `beautifulsoup4`). Rewriting these in TypeScript would be:

- High effort (SSH client code, fleet config parsing)
- Risk-prone (subtle behavioral differences)
- Unnecessary (MCP exists precisely for this boundary)

Each MCP server is a small `mcp` Python process using the `mcp` SDK that exposes tools over `stdio` or `sse` transport.

### Server Lifecycle

Each MCP server runs as a sidecar process managed by the OpenClaw gateway's MCP configuration:

```json
{
  "mcpServers": {
    "fleet-tools": {
      "command": "python",
      "args": ["-m", "mcp_servers.fleet_tools.server"],
      "transport": "stdio"
    },
    "knowledge-tools": {
      "command": "python",
      "args": ["-m", "mcp_servers.knowledge_tools.server"],
      "transport": "stdio"
    }
  }
}
```

### Transport Choice

**stdio** for all MCP servers. Reasons:

- Simplest lifecycle management (gateway spawns/kills the process)
- No port allocation or network configuration
- The Archon MCP server already uses `sse`, so we know both transports work, but `stdio` avoids port conflicts
- Each server is lightweight (no web framework overhead)

### Shared Python Package

The 5 MCP servers share common code for SSH execution, fleet config loading, and logging. This shared code lives in a `mcp-servers/_shared/` package that each server imports:

```
mcp-servers/
  _shared/
    ssh.py           # SSH connection pool, command execution
    fleet_config.py  # Fleet node definitions, Tailscale IPs
    logging.py       # AOP-compatible event logging
    auth.py          # Owner authorization (env-based)
  fleet-tools/
    server.py
  ...
```

---

## 9. Testing Strategy

### Unit Tests

- **TypeScript tools**: Vitest tests in `extensions/telegram-agentic/src/tools/*.test.ts` mocking HTTP calls
- **MCP servers**: pytest tests in `mcp-servers/*/test_server.py` mocking SSH and HTTP calls
- **Hooks**: Vitest tests in `extensions/telegram-agentic/src/hooks/*.test.ts` using upstream's test utilities

### Integration Tests

- **MCP connectivity**: Start each MCP server, verify tool listing and basic invocation via MCP client
- **Tool registration**: Load the plugin in a test gateway, verify all tools appear in the tool catalog
- **Hook firing**: Simulate session lifecycle events, verify AOP events are emitted

### Smoke Tests (Manual)

- Send a Telegram message, verify the agent responds using a registered tool
- Run `delegate_task`, verify Archon task creation and worker pickup
- Run `fleet_status`, verify all nodes respond
- Run `pipeline_start`/`pipeline_stop`, verify GPU service lifecycle

### What NOT to Test

- Upstream's agent loop internals (that's upstream's problem)
- Upstream's Telegram channel (message delivery, threading, streaming)
- Archon MCP server's own tools

---

## 10. Migration Path

### Phase 1: Parallel Running (Week 1)

1. Deploy the `telegram-agentic` plugin alongside the custom bot
2. Custom bot continues handling all messages
3. Plugin registers tools but they are only accessible via CLI or direct agent invocation
4. Verify all tools work by testing via CLI: `openclaw agent "check fleet status"`

### Phase 2: Telegram Channel Switch (Week 2)

1. Configure upstream's Telegram channel extension with the bot token
2. Stop the custom bot's long-polling loop
3. Upstream Telegram channel now receives messages and routes to agent loop
4. Agent loop has access to all registered tools (TypeScript + MCP)
5. Monitor for missing capabilities, add any tools that were missed

### Phase 3: Custom Bot Retirement (Week 3)

1. Disable custom bot entirely (`shared/telegram_bot.py` no longer started)
2. Remove custom `agentic_chat()` call sites
3. Verify notification batching works via the plugin hook
4. Verify observability events match the expected AOP format

### Rollback Plan

At any point during migration:

1. Stop upstream Telegram channel (remove bot token from config)
2. Restart custom bot long-polling
3. All tools remain functional in both modes since MCP servers are independent processes

The rollback is instantaneous because the custom bot and upstream channel both use the same Telegram Bot API token — only one can poll at a time, and switching is a config change.

### Conversation Continuity

Telegram conversations are inherently stateless from the bot's perspective — each message is independent. Session history in the custom bot is maintained in-memory and lost on restart. Upstream's session management is superior (persistent sessions with compaction). There is no conversation state to migrate; the switchover is transparent to the user.

---

## 11. Dependencies on Sub-Project 1

This spec depends on the Fleet Upgrade Manager (Sub-Project 1) for:

1. **Upstream OpenClaw deployed on Gateway**: The Telegram channel extension and plugin SDK require upstream OpenClaw running, not the custom fork
2. **Plugin SDK available**: `api.registerTool()`, `api.registerHook()`, and MCP server configuration must be functional
3. **Gateway config structure**: MCP server entries, plugin config, and channel config must follow upstream's schema
4. **Version tracking**: The Fleet Upgrade Manager tracks which upstream version is deployed; this plugin must be compatible with the deployed version

This plugin can be **developed** before Sub-Project 1 completes (it only needs the upstream repo cloned locally for type-checking and tests). But it cannot be **deployed** until the Gateway is running upstream OpenClaw.

---

## 12. Open Questions

1. **Notification batching feasibility**: Can the `message_sending` hook delay messages, or only cancel them? If delay is not supported, the batching system needs to be a separate queue rather than a hook. This needs a spike against upstream's hook implementation.

2. **MCP server count**: 5 Python MCP servers is manageable but adds process overhead. If startup cost is a concern, the 5 servers could be consolidated into 2 (fleet+pipeline+self and knowledge+delegation). The tradeoff is a larger blast radius per server crash.

3. **Browser automation tools**: `gemini_deep_research` and `notebooklm_research` use Playwright on the Mac via SSH. These are fragile and may be better replaced by upstream's built-in browser tool (`extensions/phone-control` or Playwright MCP). Needs investigation.

4. **Self-edit safety**: The `self_edit` tool lets the agent modify its own source code on a branch. In upstream's architecture, the agent workspace is sandboxed. The self-edit MCP server needs to operate on the plugin's source repo, not the sandboxed workspace. This may require special mount or path configuration.

5. **Skill hub migration**: The custom bot has a `/skill` command system (`shared/skill_hub.py`) for installing and managing community skills. Upstream has its own plugin/skill system. The skill hub tools were not in the 27-tool inventory (they were command handlers, not agentic tools) and are out of scope for this spec. They should be evaluated in a separate sub-project.
