---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: mcporter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Use the mcporter CLI to list, configure, auth, and call MCP servers/tools directly (HTTP or stdio), including ad-hoc servers, config edits, and CLI/type generation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: http://mcporter.dev（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "📦",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["mcporter"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "node",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "node",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "package": "mcporter",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["mcporter"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install mcporter (node)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# mcporter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `mcporter` to work with MCP servers directly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mcporter list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mcporter list <server> --schema`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mcporter call <server.tool> key=value`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Call tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Selector: `mcporter call linear.list_issues team=ENG limit:5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Function syntax: `mcporter call "linear.create_issue(title: \"Bug\")"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full URL: `mcporter call https://api.example.com/mcp.fetch url:https://example.com`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stdio: `mcporter call --stdio "bun run ./server.ts" scrape url=https://example.com`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- JSON payload: `mcporter call <server.tool> --args '{"limit":5}'`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Auth + config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OAuth: `mcporter auth <server | url> [--reset]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: `mcporter config list|get|add|remove|import|login|logout`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Daemon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mcporter daemon start|status|stop|restart`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Codegen（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `mcporter generate-cli --server <name>` or `--command <url>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Inspect: `mcporter inspect-cli <path> [--json]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TS: `mcporter emit-ts <server> --mode client|types`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config default: `./config/mcporter.json` (override with `--config`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer `--output json` for machine-readable results.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
