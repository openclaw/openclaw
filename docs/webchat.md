# Web Chat (loopback + SSH tunnel)

Updated: 2025-12-08

## What shipped
- The relay now starts a loopback-only web chat server automatically (default port **18788**, configurable via `webchat.port`).
- Endpoints:
  - `GET /webchat/info?session=<key>` → `{port, sessionId, initialMessages, basePath}` plus history from the relay’s session store.
  - `GET /webchat/*` → static Web Chat assets.
  - `POST /webchat/rpc` → runs the agent in-process and returns `{ ok, payloads?, error? }` (no CLI spawn, no PATH dependency).
- The macOS app simply loads `http://127.0.0.1:<port>/webchat/?session=<key>` (or the SSH-forwarded port in remote mode). No Swift bridge is used for sends; all chat traffic stays inside the Node relay.
- Initial messages are fetched from `/webchat/info`, so history appears immediately.
- Enable/disable via `webchat.enabled` (default **true**); set the port with `webchat.port`.

## Security
- Loopback only; remote access requires SSH port-forwarding.
- No bearer token; the trust model is “local machine or your SSH tunnel”.

## Failure handling
- Bootstrap errors show in-app (“Web chat failed to connect …”) instead of hanging.
- The mac app logs tunnel and endpoint details to the `com.steipete.clawdis/WebChat` subsystem.

## Dev notes
- Static assets stay in `apps/macos/Sources/Clawdis/Resources/WebChat`; the server reads them directly.
- Server code: `src/webchat/server.ts`.
- CLI entrypoint (optional): `clawdis webchat --json [--port N]` to query/start manually.
- RPC send path is in-process; the relay does not spawn `clawdis` or rely on PATH.
- Mac glue: `WebChatWindow.swift` (bootstrap + tunnel) and `WebChatTunnel` (SSH -L).

## TODO / nice-to-haves
- Enforce token by default once mobile/remote auth flows are in place.
- Stream responses instead of one-shot payloads.
- Expose a readiness endpoint for health checks.
