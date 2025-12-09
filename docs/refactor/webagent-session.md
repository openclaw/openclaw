# WebAgent session migration (WS-only)

Context: web chat currently lives in a WKWebView that loads the pi-web bundle. Sends go over HTTP `/rpc` to the webchat server, and updates come from `/socket` snapshots based on session JSONL file changes. The Gateway itself already speaks WebSocket to the webchat server, and Pi writes the session JSONL files. This doc tracks the plan to move WebChat to a single Gateway WebSocket and drop the HTTP shim/file-watching.

## Target state
- Gateway WS adds methods:
  - `chat.history { sessionKey }` → `{ sessionKey, messages[], thinkingLevel }` (reads the existing JSONL + sessions.json).
  - `chat.send { sessionKey, message, attachments?, thinking?, deliver?, timeoutMs<=30000, idempotencyKey }` → `res { runId, status:"accepted" }` or `res ok:false` on validation/timeout.
- Gateway WS emits `chat` events `{ runId, sessionKey, seq, state:"delta"|"final"|"error", message?, errorMessage?, usage?, stopReason? }`. Streaming is optional; minimum is a single `state:"final"` per send.
- Client consumes only WS: bootstrap via `chat.history`, send via `chat.send`, live updates via `chat` events. No file watchers.
- Health gate: client subscribes to `health` and blocks send when health is not OK; 30s client-side timeout for sends.
- Tunneling: only the Gateway WS port needs to be forwarded; HTTP server remains for static assets but no RPC endpoints.

## Server work (Node)
- Implement `chat.history` and `chat.send` handlers in `src/gateway/server.ts`; update protocol schemas/tests.
- Emit `chat` events by plumbing `agentCommand`/`emitAgentEvent` outputs; include assistant text/tool results.
- Remove `/rpc` and `/socket` routes + file-watch broadcast from `src/webchat/server.ts`; leave static host only.

## Client work (pi-web bundle)
- Replace `NativeTransport` with a Gateway WS client:
  - `hello` → `chat.history` for initial state.
  - Listen to `chat/presence/tick/health`; update UI from events only.
  - Send via `chat.send`; mark pending until `chat state:final|error`.
  - Enforce health gate + 30s timeout.
- Remove reliance on session file snapshots and `/rpc`.

## Persistence
- Keep passing `--session <.../.clawdis/sessions/{{SessionId}}.jsonl>` to Pi so it continues writing JSONL. The WS history reader uses the same file; no new store introduced.

## Docs to update when shipping
- `docs/webchat.md` (WS-only flow, methods/events, health gate, tunnel WS port).
- `docs/mac/webchat.md` (WKWebView now talks Gateway WS; `/rpc`/file-watch removed).
- `docs/architecture.md` / `typebox.md` if protocol methods are listed.
- Optional: add a concise Gateway chat protocol appendix if needed.

## Open decisions
- Streaming granularity: start with `state:"final"` only, or include token/tool deltas immediately?
- Attachments over WS: text-only initially is OK; confirm before wiring binary/upload path.
- Error shape: use `res ok:false` for validation/timeout, `chat state:"error"` for model/runtime failures.
