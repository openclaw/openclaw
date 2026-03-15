# MCP Transport Notes

## Local development

V1 runs over stdio only.

Recommended local command:

```bash
pnpm mcp:defender
```

Or with explicit config:

```bash
pnpm mcp:defender --config ./config/radar-defender.example.json
```

This is the simplest and safest transport for development because the operator supplies artifacts directly and the process boundary stays local.

For fork maintenance, local work should branch from `radar/main`, not directly from `main`. Treat `main` as the upstream mirror branch and keep transport work isolated to Radar-specific layers wherever possible.

## Remote deployment later

The next transport to support should be Streamable HTTP, not a separate generic REST layer.

Remote deployment assumptions:

- keep calls stateless where possible
- require auth at the boundary
- preserve the same narrow tool set
- keep request payloads artifact-only

## Session and auth considerations

- stdio local runs rely on the host process boundary
- remote runs should use bearer or gateway-auth style protection
- remote auth should not grant broader tool access than local stdio
- no tool should rely on ambient filesystem or network trust

## Load balancers and scaling

Preferred operating model:

- stateless request handling
- explicit per-call artifacts
- no hidden local cache required for correctness

If a future remote deployment uses event stores or session affinity, that should be documented separately and kept outside the v1 stdio server.
