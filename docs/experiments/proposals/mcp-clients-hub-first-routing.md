# MCP Clients Hub-first Routing Policy (Proposal)

Status: Draft RFC

## Summary

Introduce an optional MCP routing policy that prioritizes a configured local MCP Clients Hub before other MCP paths.

## Motivation

OpenClaw MCP efforts already cover connectivity and integration, but operators still face routing fragmentation in daily usage:

- Multiple MCP entrypoints and ad-hoc routing decisions
- Inconsistent behavior across sessions/operators
- Harder troubleshooting and onboarding

This proposal focuses on **operational consistency**, not replacing existing MCP features.

## Proposed Config

```yaml
mcp:
  preferClientsHub: true
  clientsHub:
    path: /path/to/mcp-clients-hub
```

### Config semantics

- `mcp.preferClientsHub` (boolean, default: `false`)
  - When `true`, MCP-eligible tasks attempt hub routing first.
- `mcp.clientsHub.path` (string)
  - Filesystem path to the MCP Clients Hub workspace/entrypoint.

## Routing Behavior

When `preferClientsHub=true`:

1. Detect whether request is MCP-eligible.
2. Attempt capability resolution through `mcp-clients-hub` first.
3. If capability is unavailable:
   - Return actionable fallback guidance (e.g. suggest adding/installing the required client into hub), and/or
   - Continue with existing non-hub MCP paths per current policy.
4. Keep MCP calls routed through hub whenever feasible to preserve consistency.

## Non-goals

- Do not remove/replace existing external MCP server support.
- Do not remove bridge-based MCP flows.
- Do not enforce hub-first as default behavior.

## Why this is additive

Existing work enables MCP functionality. This proposal adds a policy layer for predictable operator experience:

- From "MCP is possible" → "MCP usage is standardized and operable"

## Related threads

- https://github.com/openclaw/openclaw/issues/29053
- https://github.com/openclaw/openclaw/issues/31003
- https://github.com/openclaw/openclaw/issues/26459
- https://github.com/openclaw/openclaw/issues/34097
- https://github.com/openclaw/openclaw/issues/25243
- https://github.com/openclaw/openclaw/issues/38339
