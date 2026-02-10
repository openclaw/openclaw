---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Gateway singleton guard using the WebSocket listener bind"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Running or debugging the gateway process（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Investigating single-instance enforcement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Gateway Lock"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Gateway lock（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Last updated: 2025-12-11（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure only one gateway instance runs per base port on the same host; additional gateways must use isolated profiles and unique ports.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Survive crashes/SIGKILL without leaving stale lock files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fail fast with a clear error when the control port is already occupied.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Mechanism（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The gateway binds the WebSocket listener (default `ws://127.0.0.1:18789`) immediately on startup using an exclusive TCP listener.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the bind fails with `EADDRINUSE`, startup throws `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The OS releases the listener automatically on any process exit, including crashes and SIGKILL—no separate lock file or cleanup step is needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On shutdown the gateway closes the WebSocket server and underlying HTTP server to free the port promptly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Error surface（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If another process holds the port, startup throws `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Other bind failures surface as `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Operational notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the port is occupied by _another_ process, the error is the same; free the port or choose another with `openclaw gateway --port <port>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The macOS app still maintains its own lightweight PID guard before spawning the gateway; the runtime lock is enforced by the WebSocket bind.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
