---
summary: "Gateway singleton guard using a file lock and WebSocket bind"
read_when:
  - Running or debugging the gateway process
  - Investigating single-instance enforcement
title: "Gateway Lock"
---

# Gateway lock

Last updated: 2025-02-14

## Why

- Ensure only one gateway instance runs per config on the same host; additional gateways must use isolated profiles (different state dir or port).
- Survive crashes/SIGKILL: the file lock is keyed by config path and the code treats stale or dead-owner locks as reclaimable.
- Fail fast with a clear error when another gateway holds the lock or the control port is already occupied.

## Mechanism

Two layers enforce a single gateway per config:

1. **File lock (primary)**  
   When you run the gateway via `openclaw gateway run` (or the macOS app / run-loop path), the process acquires an exclusive file lock before starting the server:
   - Path: `<tmpdir>/openclaw-<uid>/gateway.<hash>.lock` (hash is derived from the config path). Example: `/tmp/openclaw-0/gateway.a1b2c3d4.lock`.
   - Lock file contains PID and config path; on Linux, process identity is checked via `/proc` so a reused PID from a different binary does not count as the same owner.
   - If the lock exists and the owner is alive, a second `openclaw gateway run` (same config) waits up to 5s then exits with `GatewayLockError("gateway already running (pid N); lock timeout after 5000ms")`.
   - The lock is released when the gateway process exits (including SIGTERM/SIGINT). Stale or dead-owner locks are removed automatically when retrying.

2. **Port bind (backstop)**  
   The gateway then binds the WebSocket listener (default `ws://127.0.0.1:18789`). If the bind fails with `EADDRINUSE`, startup throws `GatewayLockError("another gateway instance is already listening on ws://…:<port>")`. The OS frees the port when the process exits.

The file lock is **skipped** (no single-instance enforcement) when:

- `OPENCLAW_ALLOW_MULTI_GATEWAY=1` is set, or
- The process is running inside the test runner (VITEST / NODE_ENV=test).

## Ensuring a single gateway

- Start the gateway only via a path that acquires the lock: `openclaw gateway run` (or your process manager that runs the same entrypoint). Do not set `OPENCLAW_ALLOW_MULTI_GATEWAY=1` unless you intend multiple gateways (e.g. different configs/ports).
- Use one state dir and one config per host so all invocations share the same lock file (same `OPENCLAW_HOME` / `OPENCLAW_STATE_DIR` and config path).
- To see who holds the lock: `cat /tmp/openclaw-<uid>/gateway.*.lock` (or `$TMPDIR/openclaw-<uid>/gateway.*.lock`). The JSON includes `pid` and `configPath`. Check that the PID is the gateway: `ps -p <pid> -o comm=` (e.g. `openclaw` or `node`).
- If you run under systemd/docker/supervisor, run a single worker process (one `openclaw gateway run`), not multiple workers sharing the same config; otherwise each worker would contend for the same lock and only one would run.

## Error surface

- Lock timeout: `GatewayLockError("gateway already running (pid N); lock timeout after 5000ms")`.
- Port in use: `GatewayLockError("another gateway instance is already listening on ws://…:<port>")`.
- Other bind failures: `GatewayLockError("failed to bind gateway socket on ws://…:<port>: …")`.

## Operational notes

- If the port is occupied by a non-gateway process, the error is the same; free the port or choose another with `openclaw gateway --port <port>`.
- The macOS app acquires the same file lock before spawning the gateway; the runtime lock is enforced by the file lock and the WebSocket bind.
