# Requirements — MCP host (client + server)

## Outcome

OpenClaw natively speaks Model Context Protocol: the Gateway can connect to remote MCP servers (Streamable HTTP transport, OAuth 2.1) and surface their tools/resources/prompts to agents, AND the Gateway can expose its own tools/resources/prompts as an MCP server consumable by Claude.ai, Claude Code, Claude Agent SDK, OpenAI Realtime, and any other MCP client. The ad-hoc `skills/mcporter` CLI wrapper is no longer needed for first-class use.

## Users affected

- Operator configuring tool surface (`openclaw configure --section mcp` or `mcp.servers.*` config keys).
- Plugin authors wrapping external services as MCP servers instead of openclaw plugins.
- External agents (Claude.ai, ChatGPT Realtime, Claude Code) connecting back into a running Gateway.
- Tool surfaces: CLI (`openclaw mcp list`, `openclaw mcp call`), Web UI MCP panel, agent runtime tool registry.

## In scope

- MCP client speaking the November-2025 spec (Streamable HTTP transport replacing SSE; STDIO retained for local servers).
- All five primitives: tools, resources, prompts, sampling, roots.
- OAuth 2.1 Resource Server auth with RFC 8707 resource indicators; Client ID Metadata Documents (CIMD) preferred over Dynamic Client Registration.
- Elicitation handling in both URL mode (open browser for OAuth/credentials/payment) and form mode (gateway renders a structured form via the wizard).
- MCP server exposure of the openclaw tool catalog (browser, canvas, cron, sessions_*, channel send, skills) over Streamable HTTP, gated by the existing fail-closed Gateway auth.
- Surface MCP tools through the same allow/deny policy used for built-in tools (`tool-policy.ts`).

## Out of scope

- Replacing the existing in-process tool API for built-in tools — MCP is an additional integration layer, not a rewrite.
- Hosting a public MCP server registry (we may publish into the public registry but do not run one).
- Migrating the 50+ `skills/*` directories to MCP servers — covered separately by `2026-05-16-agent-skills-interop`.
- Cross-tenant auth (openclaw stays single-operator; OAuth scopes are per-operator).

## Decisions

- Streamable HTTP transport for remote servers; STDIO only for local user-installed servers. Reason: SSE is deprecated in the 2025-11 spec.
- CIMD over DCR. Reason: spec-recommended since 2025-11 and avoids a per-client DB on the authorization server.
- Expose openclaw-as-server under the existing Gateway WS host on a sibling HTTP route (`/mcp`), not a new port. Reason: reuses Tailscale Serve/Funnel + token/password auth that already gates the Gateway.
- Reuse existing `openclaw doctor` for misconfiguration surfacing. Reason: consistent operator UX.
