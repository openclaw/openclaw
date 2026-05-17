# Validation — MCP host (client + server)

## Automated tests

- `src/mcp/protocol/*.test.ts` — schema round-trips for every November-2025 message type.
- `src/mcp/transport/streamable-http.test.ts` — request/response, server push, reconnect/resume, 401 → reauth path.
- `src/mcp/client/connection.test.ts` — initialize, capability negotiation, tool enumeration, sampling callback.
- `src/mcp/auth/oauth.test.ts` — PKCE, Resource Indicators, CIMD metadata publish, token refresh.
- `src/mcp/server/route.test.ts` — Gateway `/mcp` route enforces fail-closed auth; rejects without token/password; honors `tool-policy` deny lists.
- `src/mcp/elicitation/wizard-bridge.test.ts` — URL-mode opens browser via the existing helper; form-mode renders via wizard JSON-Schema engine.
- `scripts/e2e/mcp-host-docker.sh` — Docker E2E: bring up a reference MCP server fixture, connect openclaw client, call a tool, verify result.
- `scripts/e2e/mcp-server-docker.sh` — Docker E2E: connect Claude Code / a stub MCP client to openclaw-as-server, list tools, call browser+session tool, verify auth gate.

## Smoke checks

- `openclaw mcp add demo --url https://mcp.example/ --auth oauth` → completes OAuth → `openclaw mcp list` shows server.
- `openclaw mcp call demo.echo text=hi` returns `hi`.
- `curl -H "Authorization: Bearer $TOKEN" $GATEWAY/mcp/initialize` returns server capabilities.
- `openclaw doctor` flags an MCP server that is configured without auth.

## Manual criteria

- The Web UI MCP panel lists the same servers/tools as `openclaw mcp list`.
- Elicitation prompts during onboarding feel native (same palette + spinner as `src/cli/progress.ts`).
- Errors from upstream MCP servers surface user-readable messages, not raw RPC dumps.

## AI eval plan

- Success criteria: when an MCP tool is available, the agent picks it for an in-scope request ≥ 90% of the time over a 30-prompt eval set covering 3 demo servers (github, filesystem, fetch); zero attempts to call a deny-listed MCP tool over 100 sampled traces.
- Eval dataset: `tests/evals/mcp-tool-routing.jsonl` — operator prompts + expected MCP tool selection (build it once on first ship, store in repo).
- Regression set: 6 prompts spanning resource fetch, tool call with auth, elicitation prompt mid-loop, sampling callback, denied tool, malformed server response.
- Cadence: run on every PR that touches `src/mcp/**` and nightly against the live-models matrix.

## Risks & rollback

- **Risks:**
  - Streamable HTTP server-push semantics interact badly with reverse-proxy idle timeouts. *Detect via* `gateway-network` E2E and the new `mcp-host-docker` script.
  - OAuth 2.1 CIMD adoption is uneven across MCP servers; some still want DCR. *Mitigate* by supporting DCR as a fallback flag, log to doctor.
  - Server-mode exposure widens the Gateway attack surface. *Detect via* doctor warnings + the existing trusted-proxy detection that treats non-local Host headers as remote.
- **Rollback:** revert the PR; the `mcp.servers` config block is additive (existing tools keep working). For server-mode, set `mcp.expose=false` to unbind `/mcp` without redeploying.

## Open questions

- Do we ship a curated resources surface in v1, or start tools-only and add resources in a follow-up? (Decide before Step 5.)
- Should the openclaw-as-server registration land in the public MCP registry by default, or opt-in via config? (Decide before Step 5 ships.)
