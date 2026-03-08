# Pact MCP Server (SmartBear)

## Principle

Use the SmartBear MCP server to enable AI agent interaction with PactFlow/Pact Broker during contract testing workflows. The MCP server provides tools for generating pact tests, fetching provider states, reviewing test quality, and checking deployment safety — all accessible through the Model Context Protocol.

## Rationale

### Why MCP for contract testing?

- **Live broker queries**: AI agents can fetch existing provider states, verification results, and deployment status directly from PactFlow
- **Test generation assistance**: MCP tools generate consumer and provider tests based on existing contracts, OpenAPI specs, or templates
- **Automated review**: MCP-powered review checks tests against best practices without manual inspection
- **Deployment safety**: `can-i-deploy` checks integrated into agent workflows for real-time compatibility verification

### When TEA uses it

- **test-design workflow**: Fetch existing provider states to understand current contract landscape
- **automate workflow**: Generate pact tests using broker knowledge and existing contracts
- **test-review workflow**: Review pact tests against best practices with automated feedback
- **ci workflow**: Reference can-i-deploy and matrix tools for pipeline guidance

## Available Tools

| #   | Tool                      | Description                                                             | When Used             |
| --- | ------------------------- | ----------------------------------------------------------------------- | --------------------- |
| 1   | **Generate Pact Tests**   | Create consumer/provider tests from code, OpenAPI, or templates         | automate workflow     |
| 2   | **Fetch Provider States** | List all provider states from broker for a given consumer-provider pair | test-design, automate |
| 3   | **Review Pact Tests**     | Analyze tests against contract testing best practices                   | test-review           |
| 4   | **Can I Deploy**          | Check deployment safety via broker verification matrix                  | ci workflow           |
| 5   | **Matrix**                | Query consumer-provider verification matrix                             | ci, test-design       |
| 6   | **PactFlow AI Status**    | Check AI credits and permissions (PactFlow Cloud only)                  | diagnostics           |
| 7   | **Metrics - All**         | Workspace-wide contract testing metrics                                 | reporting             |
| 8   | **Metrics - Team**        | Team-level adoption statistics (PactFlow Cloud only)                    | reporting             |

## Installation

### Config file locations

| Tool              | Global Config File                    | Format                 |
| ----------------- | ------------------------------------- | ---------------------- |
| Claude Code       | `~/.claude.json`                      | JSON (`mcpServers`)    |
| Codex             | `~/.codex/config.toml`                | TOML (`[mcp_servers]`) |
| Gemini CLI        | `~/.gemini/settings.json`             | JSON (`mcpServers`)    |
| Cursor            | `~/.cursor/mcp.json`                  | JSON (`mcpServers`)    |
| Windsurf          | `~/.codeium/windsurf/mcp_config.json` | JSON (`mcpServers`)    |
| VS Code (Copilot) | `.vscode/mcp.json`                    | JSON (`servers`)       |

> **Claude Code tip**: Prefer the `claude mcp add` CLI over manual JSON editing. Use `-s user` for global (all projects) or omit for per-project (default).

### CLI shortcuts (Claude Code and Codex)

```bash
# Claude Code — use add-json for servers with env vars (-s user = global)
claude mcp add-json -s user smartbear \
  '{"type":"stdio","command":"npx","args":["-y","@smartbear/mcp@latest"],"env":{"PACT_BROKER_BASE_URL":"https://{tenant}.pactflow.io","PACT_BROKER_TOKEN":"<your-token>"}}'

# Codex
codex mcp add smartbear -- npx -y @smartbear/mcp@latest
```

### JSON config (Gemini CLI, Cursor, Windsurf)

Add a `"smartbear"` entry to the `mcpServers` object in the config file for your tool:

```json
{
  "mcpServers": {
    "smartbear": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@smartbear/mcp@latest"],
      "env": {
        "PACT_BROKER_BASE_URL": "https://{tenant}.pactflow.io",
        "PACT_BROKER_TOKEN": "<your-api-token>"
      }
    }
  }
}
```

### Codex TOML config

Codex uses TOML instead of JSON. Add to `~/.codex/config.toml`:

```toml
[mcp_servers.smartbear]
command = "npx"
args = ["-y", "@smartbear/mcp@latest"]

[mcp_servers.smartbear.env]
PACT_BROKER_BASE_URL = "https://{tenant}.pactflow.io"
PACT_BROKER_TOKEN = "<your-api-token>"
```

Note the key is `mcp_servers` (underscored), not `mcpServers`.

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json` (note: uses `servers` key, not `mcpServers`):

```json
{
  "servers": {
    "smartbear": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@smartbear/mcp@latest"],
      "env": {
        "PACT_BROKER_BASE_URL": "https://{tenant}.pactflow.io",
        "PACT_BROKER_TOKEN": "${input:pactToken}"
      }
    }
  }
}
```

> **Note**: Set either `PACT_BROKER_TOKEN` (for PactFlow) or `PACT_BROKER_USERNAME`+`PACT_BROKER_PASSWORD` (for self-hosted). Leave unused vars empty.

## Required Environment Variables

| Variable               | Required                     | Description                             |
| ---------------------- | ---------------------------- | --------------------------------------- |
| `PACT_BROKER_BASE_URL` | Yes (for Pact features)      | PactFlow or self-hosted Pact Broker URL |
| `PACT_BROKER_TOKEN`    | For PactFlow / token auth    | API token for broker authentication     |
| `PACT_BROKER_USERNAME` | For basic auth (self-hosted) | Username for basic authentication       |
| `PACT_BROKER_PASSWORD` | For basic auth (self-hosted) | Password for basic authentication       |

**Authentication**: Use token auth (`PACT_BROKER_TOKEN`) for PactFlow. Use basic auth (`PACT_BROKER_USERNAME` + `PACT_BROKER_PASSWORD`) for self-hosted Pact Broker instances. Only one auth method is needed.

**Requirements**: Node.js 20+

## Pattern Examples

### Example 1: Fetching Provider States During Test Design

When designing contract tests, use MCP to query existing provider states:

```
# Agent queries SmartBear MCP during test-design workflow:
# → Fetch Provider States for consumer="movie-web", provider="SampleMoviesAPI"
# ← Returns: ["movie with id 1 exists", "no movies exist", "user is authenticated"]
#
# Agent uses this to generate comprehensive consumer tests covering all states
```

### Example 2: Reviewing Pact Tests

During test-review workflow, use MCP to evaluate test quality:

```
# Agent submits test file to SmartBear MCP Review tool:
# → Review Pact Tests with test file content
# ← Returns: feedback on matcher usage, state coverage, interaction naming
#
# Agent incorporates feedback into review report
```

### Example 3: Can I Deploy Check in CI

During CI workflow design, reference the can-i-deploy tool:

```
# Agent generates CI pipeline with can-i-deploy gate:
# → Can I Deploy: pacticipant="SampleMoviesAPI", version="${GITHUB_SHA}", to="production"
# ← Returns: { ok: true/false, reason: "..." }
#
# Agent designs pipeline to block deployment if can-i-deploy fails
```

## Key Points

- **Per-project install recommended**: Different projects may target different PactFlow tenants — match TEA's per-project config philosophy
- **Env vars are project-specific**: `PACT_BROKER_BASE_URL` and `PACT_BROKER_TOKEN` vary by project/team
- **Node.js 20+ required**: SmartBear MCP server requires Node.js 20 or higher
- **PactFlow Cloud features**: Some tools (AI Status, Team Metrics) are only available with PactFlow Cloud, not self-hosted Pact Broker
- **Complements pactjs-utils**: MCP provides broker interaction during design/review; pactjs-utils provides runtime utilities for test code

## Related Fragments

- `pactjs-utils-overview.md` — runtime utilities that pact tests import
- `pactjs-utils-provider-verifier.md` — verifier options that reference broker config
- `contract-testing.md` — foundational contract testing patterns

## Anti-Patterns

### Wrong: Using MCP for runtime test execution

```
# ❌ Don't use MCP to run pact tests — use npm scripts and CI pipelines
# MCP is for agent-assisted design, generation, and review
```

### Right: Use MCP for design-time assistance

```
# ✅ Use MCP during planning and review:
# - Fetch provider states to inform test design
# - Generate test scaffolds from existing contracts
# - Review tests for best practice compliance
# - Check can-i-deploy during CI pipeline design
```

_Source: SmartBear MCP documentation, PactFlow developer docs_
