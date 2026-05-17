# Plan — MCP host (client + server)

## Approach

Introduce a new `src/mcp/` module with two halves: a **client** (`src/mcp/client/`) that connects to remote MCP servers and registers their tools/resources/prompts into the agent tool registry, and a **server** (`src/mcp/server/`) that exposes openclaw's existing tool catalog over Streamable HTTP. Both use the same TypeBox schema layer as the rest of the codebase, the same fail-closed Gateway auth, and the same tool-policy gate (`src/agents/tool-policy.ts`). Configuration lives under `mcp.servers.<name>` (client side) and `mcp.expose` (server side). Elicitation is plumbed into the wizard RPC so URL-mode flows reuse the existing browser-open + form-render path.

## Steps

1. Add `src/mcp/protocol/` with TypeBox schemas for the November-2025 message types (initialize, tools/*, resources/*, prompts/*, sampling/*, roots/*, elicitation/*). Validate against `@sinclair/typebox`.
2. Build `src/mcp/transport/` with Streamable HTTP (request/response + server-pushed events over a single HTTP connection) and STDIO transports. No SSE.
3. Implement `src/mcp/client/` — connection lifecycle, capability negotiation, tool/resource/prompt enumeration, sampling callback bridging to the agent's LLM, roots enumeration from `config.mcp.roots`.
4. Implement `src/mcp/auth/` — OAuth 2.1 Resource Server flow with PKCE, Resource Indicators (RFC 8707), CIMD client metadata published at `/.well-known/openclaw-mcp-client.json`. Token storage under `~/.openclaw/credentials/mcp/<server>.json` with the same secret-file ACL audit as web creds.
5. Implement `src/mcp/server/` — expose the agent tool catalog plus a curated `resources` set (config snapshot, channel allowlists, session log paths). Bind under the Gateway's `/mcp` route. Reuse `gateway.auth` for token/password.
6. Add `src/mcp/elicitation/` — translate MCP elicitation requests into wizard steps (URL → browser open; form → JSON-Schema render via existing wizard engine).
7. Wire MCP tools into `src/agents/tool-policy.ts` so policy names like `mcp:<server>.<tool>` flow through allow/deny + group:web style rules.
8. CLI: add `openclaw mcp list|add|remove|call|auth|whoami` and an `mcp` section to `openclaw configure`. Web UI: add a sessions/agent → MCP servers panel.
9. Deprecate the `skills/mcporter` SKILL.md call paths once `openclaw mcp call` is on par; leave the binary install metadata for backwards compat.
10. Doctor checks: warn on un-auth'd remote MCP servers; warn when openclaw-as-server is exposed without a token; warn on SSE-only legacy servers.

## Dependencies / order

- Steps 1–2 block everything else.
- Step 3 (client) and step 5 (server) are independent and can ship in parallel once 1–2 are merged.
- Step 4 (auth) blocks step 3 for any production-grade external server, but can be stubbed for STDIO-only local testing.
- Step 8 (CLI/UI) depends on 3 and 5.
- Step 9 only after `openclaw mcp call` reaches parity with `mcporter call`.
