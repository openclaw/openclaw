# OpenClaw Execution Hooks

Pre/post execution hook scripts that connect OpenClaw agents to the agent-hub memory DAG via MCP.

## Scripts

### `pre-execution-context.sh`

Called **before** an agent starts a task. Queries agent-hub's memory DAG for relevant organizational context and outputs formatted text to stdout. OpenClaw injects this stdout into the agent's prompt.

- Calls `memory_search` MCP tool with the task description
- Formats up to 5 memory results as injectable context
- Output is capped at 2000 characters to avoid context window bloat
- Always exits 0 — never blocks agent execution

### `post-execution-store.sh`

Called **after** an agent completes a task. Stores the execution result back into agent-hub's memory DAG for organizational learning.

- Reads result from stdin (piped) or first argument
- Truncates result to 1000 characters
- Calls `store_memory` MCP tool with key `openclaw:result:{timestamp}`
- Stores metadata including `source_system: openclaw` and `category: execution-result`
- Always exits 0 — never blocks agent execution

## Configuration

### Environment Variable

Set `AGENT_HUB_API_KEY` in OpenClaw's environment:

```bash
export AGENT_HUB_API_KEY="e010ca85b5b9a735ae7078ed1e0f3f7726fd25f24d43daef57721e5a93753d32"
```

If the env var is not set, both scripts fall back to reading the API key from `/home/aali/openclaw/.mcp.json` (the `Authorization` header in the `agent-hub` server config).

### OpenClaw Hook Configuration

Configure OpenClaw to call these scripts as execution hooks. In your OpenClaw agent configuration or execution pipeline:

```yaml
# Example OpenClaw config
hooks:
  pre_execution: /home/aali/openclaw/scripts/pre-execution-context.sh
  post_execution: /home/aali/openclaw/scripts/post-execution-store.sh
```

### Dependencies

- `bash` (4.0+)
- `node` (for safe JSON construction and parsing)
- `curl` (for HTTP requests to agent-hub MCP endpoint)
- Network access to `https://agent-hub.pulsebusiness.ai/mcp`

## Usage Examples

```bash
# Pre-execution: inject context into agent prompt
context=$(./scripts/pre-execution-context.sh "Fix the authentication bug in login flow")
echo "$context"
# Output:
# [ORGANIZATIONAL CONTEXT - from agent-hub memory DAG]
# 1. JWT validation was updated in Q1 to use RS256... (source: slack, relevance: 0.92)
# 2. Login flow architecture documented in... (source: confluence, relevance: 0.85)
# [END CONTEXT]

# Post-execution: store result via stdin pipe
echo "Fixed the bug by updating the JWT validation logic" | ./scripts/post-execution-store.sh

# Post-execution: store result via argument (with optional task description)
./scripts/post-execution-store.sh "Fixed the JWT validation logic" "Fix auth bug in login"

# Full pipeline example
task="Investigate why the deploy pipeline is failing"
context=$(./scripts/pre-execution-context.sh "$task")
# ... agent runs with $context injected ...
result="Root cause: expired Docker Hub credentials in CI secrets"
echo "$result" | ./scripts/post-execution-store.sh
```

## MCP Endpoint

Both scripts communicate with:

- **URL:** `https://agent-hub.pulsebusiness.ai/mcp`
- **Protocol:** JSON-RPC 2.0 over HTTP (SSE response format)
- **Auth:** Bearer token in Authorization header

## Error Handling

Both scripts are designed to be completely non-blocking:

- All failures (network errors, parse errors, missing config) result in exit 0
- `pre-execution-context.sh` outputs a placeholder context block on failure so the agent always gets valid formatting
- `post-execution-store.sh` silently drops results on failure
- curl timeouts: 15s for pre-execution (context fetch), 10s for post-execution (store)
