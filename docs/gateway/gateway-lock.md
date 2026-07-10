---
summary: "Gateway singleton guard: file lock plus WebSocket/HTTP bind"
read_when:
  - Running or debugging the gateway process
  - Investigating single-instance enforcement
title: "Gateway lock"
---

## Why

- Only one gateway process should own a given config + port on a host; run additional gateways with isolated profiles and unique ports.
- Survive crashes/SIGKILL without leaving stale lock files behind.
- Fail fast with a clear error when another gateway already owns the port.

## Two layers

Startup enforces single-instance ownership in two independent steps, in order:

1. **File lock** acquires a per-config lock file under the state lock directory. As part of acquiring it, startup probes the configured port for a live listener to detect a stale (crashed) lock owner.
2. **Socket bind** binds the HTTP/WebSocket listener (default `ws://127.0.0.1:18789`) as an exclusive TCP listener.

Each layer can fail independently and throws its own `GatewayLockError`.

### File lock

- If the lock file is missing, the recorded owner process is gone, or the owner's port probe shows no live listener, startup reclaims the lock and continues.
- If the lock is actively held and none of the above apply, startup retries for up to 5 seconds (default) before giving up:

  ```text
  GatewayLockError("gateway already running (pid <pid>); lock timeout after <ms>ms")
  ```

### Socket bind

- On `EADDRINUSE`, startup retries the bind for up to 20 attempts at 500ms intervals (roughly 10 seconds total) to ride out a `TIME_WAIT` window after a recently exited process.
- If the port is still in use after retries:

  ```text
  GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")
  ```

- Other bind failures:

  ```text
  GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: <cause>")
  ```

On shutdown, the gateway closes the HTTP/WebSocket server and removes the lock file.

## Operational notes

- If the port is occupied by a different, non-gateway process, the error is the same; free the port or choose another with `openclaw gateway --port <port>`.
- Under a service supervisor, a new gateway process that hits either error above first probes `/healthz` on the existing process. If that process is healthy, the new process leaves it in control instead of failing. On systemd, it exits with code `78`; the unit's `RestartPreventExitStatus=78` stops `Restart=always` from looping on a lock or `EADDRINUSE` conflict. If the existing process never becomes healthy, the health-probe retry is time-bounded and startup then fails with the lock error above instead of looping forever.
- The macOS app keeps its own lightweight PID guard before spawning the gateway; the file lock and socket bind above are the actual runtime enforcement.

## Related

- [Multiple Gateways](/gateway/multiple-gateways) - running multiple instances with unique ports
- [Troubleshooting](/gateway/troubleshooting) - diagnosing `EADDRINUSE` and port conflicts
