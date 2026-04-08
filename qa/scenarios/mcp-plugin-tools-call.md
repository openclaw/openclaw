# MCP plugin-tools call

```yaml qa-scenario
id: mcp-plugin-tools-call
title: MCP plugin-tools call
surface: mcp
objective: Verify OpenClaw can expose plugin tools over MCP and a real MCP client can call one successfully.
successCriteria:
  - Plugin tools MCP server lists memory_search.
  - A real MCP client calls memory_search successfully.
  - The returned MCP payload includes the expected memory-only fact.
docsRefs:
  - docs/cli/mcp.md
  - docs/gateway/protocol.md
codeRefs:
  - src/mcp/plugin-tools-serve.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: custom
  handler: mcp-plugin-tools-call
  summary: Verify OpenClaw can expose plugin tools over MCP and a real MCP client can call one successfully.
```
