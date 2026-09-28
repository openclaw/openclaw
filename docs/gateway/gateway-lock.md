---
summary: "Gateway singleton guard: file lock plus WebSocket/HTTP bind"
read_when:
  - Running or debugging the gateway process
  - Investigating single-instance enforcement
title: "Gateway lock"
---

## Why

- Only one gateway process should own a state directory; run additional gateways with isolated profiles, state directories, configs, and ports.
- Recover ownership after a crash or SIGKILL when the recorded process is confirmed dead.
- Fail fast with a clear error when another gateway already owns the port.

## Three layers

Startup establishes state ownership before publishing compatibility metadata and binding its listener:

1. **Process owner** exclusively creates one sidecar keyed by the canonical shared-state database path. Gateway startup, embedded agents, and offline maintenance compete for this same owner. `OPENCLAW_ALLOW_MULTI_GATEWAY=1` does not permit sharing mutable state.
2. **Compatibility projection** publishes the owner's PID, process start identity, role, and runtime port in the historical state-local lock. Supported older Gateways use it to detect the current process. It is metadata under the process owner, not an independent lifecycle owner.
3. **Socket bind** binds the HTTP/WebSocket listener (default `ws://127.0.0.1:18789`) as an exclusive TCP listener.

During startup or restart, the Gateway waits up to five minutes for another OpenClaw process to release state ownership. It logs when waiting starts and when ownership is acquired or the wait expires.

### State and config locks

- On Linux and macOS, the process owner lives at `$OPENCLAW_STATE_DIR/tmp/openclaw-<uid>/state.<hash>.lock`. It uses the selected state storage without requiring write access to its parent or depending on the system temporary directory. On Windows it lives beneath the user's `AppData/Local/OpenClaw/locks/openclaw-state-owners` directory. The hash identifies the canonical shared-state database path. `TMPDIR` does not change this namespace.
- Destructive cleanup preserves the process owner and compatibility projection while removing state contents, so new startup remains blocked until native database resources and destructive operations settle. Normal release removes the sidecars; no SQLite coordinator database accompanies them.
- Cleanup refuses redirected database or runtime-lock paths before deleting state: removing an internal symlink could select a new owner while the original files remain locked. Select the actual state root and real internal directories before retrying. An alias for the entire state root remains supported.
- Ownership uses exclusive file creation and fs-safe's existing checked release and stale-recovery protocol. A dead process or a verified changed process start identity permits recovery. Age alone never revokes a live owner, and unreadable ownership remains a refusal.
- Schema/bootstrap work borrows retained authority from a live local Gateway or maintenance owner. Without one, it briefly acquires the same process gate and historical projection, so a new CLI cannot migrate state beneath a supported older Gateway. Accepted work retains both until it settles, even after its root stops lending authority.
- The compatibility projection is `$OPENCLAW_STATE_DIR/tmp/openclaw-<uid>/gateway.state.lock` (`openclaw` on platforms without a user ID). New runtimes do not create the historical per-config lock or any `.sqlite` lock companions. Discovery still reads historical config and state locks for supported older runtimes.
- A live owner blocks another startup before either process binds its port. If the wait expires, startup reports:

  ```text
  GatewayLockError("failed to acquire gateway state ownership; waited <ms>ms for Gateway state ownership")
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

On shutdown, the Gateway closes its server and settles owned work before releasing its process owner and compatibility projection. Offline maintenance closes admission and retains both sidecars through state, linked config/credential, and alias removal, then drains its remaining database resources before releasing ownership.

On Unix, destructive cleanup retains SQLite's native exclusion until the database is removed. On Windows, SQLite's open file handles prevent unlink; the cleanup command closes its own probe before removal. Native cleanup must finish before process ownership is released.

Normal upgrades preserve mutual exclusion with older state-local-lock runtimes through the compatibility projection and historical-owner checks. After releasing both sidecars, destructive cleanup removes only empty directories whose filesystem identities still match the directories it owned. A replacement directory or a new owner's files remain intact, and cleanup reports an interrupted removal. The managed update path stops the old service before mutation. Binaries predating state-local ownership retain their existing supported-upgrade stop checks.

## Operational notes

- If the port is occupied by a different, non-gateway process, the error is the same; free the port or choose another with `openclaw gateway --port <port>`.
- `OPENCLAW_ALLOW_MULTI_GATEWAY=1` permits multiple config/runtime instances, not shared mutable state. Each instance still needs a unique `OPENCLAW_STATE_DIR`.
- Under a service supervisor, a new gateway process that hits either error above first probes `/healthz` on the existing process. If that process is healthy, the new process leaves it in control instead of failing. On systemd, it exits with code `78`; the unit's `RestartPreventExitStatus=78` stops `Restart=always` from looping on a lock or `EADDRINUSE` conflict. If the existing process never becomes healthy, the health-probe retry is time-bounded and startup then fails with the lock error above instead of looping forever.
- The macOS app keeps its own lightweight PID guard before spawning the gateway; the file lock and socket bind above are the actual runtime enforcement.

## Related

- [Multiple Gateways](/gateway/multiple-gateways) - running multiple instances with unique ports
- [Troubleshooting](/gateway/troubleshooting) - diagnosing `EADDRINUSE` and port conflicts
