# Signal (signal-cli)

Status: external CLI integration only. No libsignal embedding.

## Why
- Signal OSS stack is GPL/AGPL; not compatible with Clawdis MIT if bundled.
- signal-cli is unofficial; must stay up to date (Signal server churn).

## Model
- Run `signal-cli` as separate process (user-installed).
- Prefer `daemon --http=127.0.0.1:PORT` for JSON-RPC + SSE.
- Alternative: `jsonRpc` mode over stdin/stdout.

## Endpoints (daemon --http)
- `POST /api/v1/rpc` JSON-RPC request (single or batch).
- `GET /api/v1/events` SSE stream of `receive` notifications.
- `GET /api/v1/check` health probe (200 = up).

## Multi-account
- Start daemon without `-a`.
- Include `params.account` (E164) on JSON-RPC calls.
- SSE `?account=+E164` filters events; no param = all accounts.

## Minimal RPC surface
- `send` (recipient/groupId/username, message, attachments).
- `listGroups` (map group IDs).
- `subscribeReceive` / `unsubscribeReceive` (if manual receive).
- `startLink` / `finishLink` (optional device link flow).

## Process plan (Clawdis adapter)
1) Detect `signal-cli` binary; refuse if missing.
2) Launch daemon (HTTP preferred), store PID.
3) Poll `/api/v1/check` until ready.
4) Open SSE stream; parse `event: receive`.
5) Translate receive payload into Clawdis surface model.
6) On SSE disconnect, backoff + reconnect.

## Storage
- signal-cli data lives in `$XDG_DATA_HOME/signal-cli/data` or
  `$HOME/.local/share/signal-cli/data`.

## References (local)
- `~/Projects/oss/signal-cli/README.md`
- `~/Projects/oss/signal-cli/man/signal-cli-jsonrpc.5.adoc`
- `~/Projects/oss/signal-cli/src/main/java/org/asamk/signal/http/HttpServerHandler.java`
- `~/Projects/oss/signal-cli/src/main/java/org/asamk/signal/jsonrpc/SignalJsonRpcDispatcherHandler.java`
