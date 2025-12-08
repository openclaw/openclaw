# Web Chat (loopback + SSH tunnel)

Updated: 2025-12-08

## What shipped
- A lightweight HTTP server now lives inside the Node relay (`clawdis webchat --port 18788`).
- It binds to **127.0.0.1** only and serves:
  - `GET /webchat/info?session=<key>` → `{port, token, sessionId, initialMessages, basePath}` plus history from the relay’s session store.
  - `GET /webchat/*` → static Web Chat assets.
  - `POST /webchat/rpc` → runs `clawdis agent --json` and returns `{ ok, payloads?, error? }`.
- The macOS app embeds this UI in a WKWebView. In **remote mode** it first opens an SSH tunnel (`ssh -L <local>:127.0.0.1:<port>`) to the remote host, then loads `/webchat/info` through that tunnel.
- Initial messages are preloaded from the relay’s session store, so remote sessions appear immediately.
- Sending now goes over the HTTP `/webchat/rpc` endpoint (no more AgentRPC fallback).
- Feature flag + port live in *Settings → Config → Web chat*. When disabled, the “Open Chat” menu entry is hidden.

## Security
- Loopback only; remote access requires SSH port-forwarding.
- Optional bearer token support is wired; tokens are returned by `/webchat/info` and accepted by `/webchat/rpc`.

## Failure handling
- Bootstrap errors show in-app (“Web chat failed to connect …”) instead of hanging.
- The mac app logs tunnel and endpoint details to the `com.steipete.clawdis/WebChat` subsystem.

## Dev notes
- Static assets stay in `apps/macos/Sources/Clawdis/Resources/WebChat`; the server reads them directly.
- Server code: `src/webchat/server.ts`.
- CLI entrypoint: `clawdis webchat --json [--port N]`.
- Mac glue: `WebChatWindow.swift` (bootstrap + tunnel) and `WebChatTunnel` (SSH -L).

## TODO / nice-to-haves
- Enforce token by default once mobile/remote auth flows are in place.
- Stream responses instead of one-shot payloads.
- Expose a readiness endpoint for health checks.
