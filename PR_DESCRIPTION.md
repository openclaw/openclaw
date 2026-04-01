## PR #57579: Confirm `inputProvenance` as the sole sender-identity mechanism in `sessions_send`

### Summary

This PR confirms that the `sessions_send` tool's sender identity is correctly carried through the structured `inputProvenance` field on all code paths. The previously proposed approaches—text-prefix injection (`[Metadata: ...]` into the message body) and an undeclared `metadata` field on the `agent` RPC—are **not present** in the current codebase and should **not be reintroduced**.

### Why this matters

- **No message-body pollution**: The user's original message is passed through verbatim. Injecting tracking text into the message body corrupts the conversation context and breaks prompt engineering.
- **No schema violations**: The `agent` RPC enforces `additionalProperties: false` via `AgentParamsSchema`. Passing an undeclared `metadata` field would be silently stripped or rejected by the gateway.
- **`inputProvenance` is the canonical mechanism**: It is a first-class Gateway protocol field (defined in `src/sessions/input-provenance.ts`, validated in `src/gateway/protocol/schema/agent.ts`), consumed by 20+ files across the project.

### Verified paths

| Path                                   | `sourceSessionKey`              | `sourceChannel`              | `sourceTool`         |
| -------------------------------------- | ------------------------------- | ---------------------------- | -------------------- |
| Initial send (`sessions-send-tool.ts`) | ✅ `opts.agentSessionKey`       | ✅ `opts.agentChannel`       | ✅ `"sessions_send"` |
| Ping-pong turns (`a2a.ts`)             | ✅ dynamic swap                 | ✅ dynamic swap              | ✅ `"sessions_send"` |
| Announce step (`a2a.ts`)               | ✅ `params.requesterSessionKey` | ✅ `params.requesterChannel` | ✅ `"sessions_send"` |

### Test coverage

- `src/gateway/server.sessions-send.test.ts` validates `inputProvenance.sourceTool === "sessions_send"` on the gateway `agent` call.
- `inputProvenance` is end-to-end tested across `openclaw-tools.sessions.test.ts`, `subagent-announce.*.e2e.test.ts`, and other suites.

### No code changes required

Current `main` (`fe57ee5`) already implements the correct approach. This PR serves as documentation of the design decision for future contributors.
