---
summary: "Gateway lock strategy using POSIX flock and PID file"
read_when:
  - Running or debugging the gateway process
  - Investigating single-instance enforcement
---
# Gateway lock

Last updated: 2025-12-10

## Why
- Ensure only one gateway instance runs per host.
- Survive crashes/SIGKILL without leaving a blocking stale lock.
- Keep the PID visible for observability and manual debugging.

## Mechanism
- Uses a single lock file (default `${os.tmpdir()}/clawdis-gateway.lock`, e.g. `/var/folders/.../clawdis-gateway.lock` on macOS) opened once per process.
- An exclusive, non-blocking POSIX `flock` is taken on the file descriptor. The kernel releases the lock automatically on any process exit, including crashes and SIGKILL.
- The PID is written into the same file after locking; the lock (not file existence) is the source of truth.
- On graceful shutdown, we best-effort unlock, close, and unlink the file to reduce crumbs, but correctness does not rely on cleanup.

## Error surface
- If another instance holds the lock, startup throws `GatewayLockError("another gateway instance is already running")`.
- Unexpected `flock` failures surface as `GatewayLockError("failed to acquire gateway lock: …")`.

## Operational notes
- The lock file may remain on disk after abnormal exits; this is expected and harmless because the kernel lock is gone.
- If you need to inspect, `cat /tmp/clawdis-gateway.lock` shows the last PID. Do not delete the file while a process is running—you would only remove the convenience marker, not the lock itself.
