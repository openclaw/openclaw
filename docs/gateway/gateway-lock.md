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

Every server start uses the same admission, including the temporary Gateway started by container onboarding. Direct servers retain ownership until shutdown completes. Managed servers use the run loop's existing owner, which remains responsible for restart handoffs and release; closing one server generation does not release that owner.

1. **Process owner** exclusively creates one sidecar keyed by the resolved shared-state database path. Gateway startup, embedded agents, and offline maintenance compete for this same owner. `OPENCLAW_ALLOW_MULTI_GATEWAY=1` does not permit sharing mutable state.
2. **Compatibility projection** publishes the owner's PID, process start identity, role, and runtime port in the historical state-local lock. Supported older Gateways use it to detect the current process. It is metadata under the process owner, not an independent lifecycle owner.
3. **Socket bind** binds the HTTP/WebSocket listener (default `ws://127.0.0.1:18789`) as an exclusive TCP listener.

During startup or restart, the Gateway waits up to five minutes for another OpenClaw process to release state ownership. It checks ordinary contention every 250 ms so a prolonged shutdown does not leave the replacement sleeping after ownership is released. An unverifiable owner remains protected regardless of heartbeat age and requires explicit operator recovery after its holder has stopped. It logs when waiting starts and when ownership is acquired or the wait expires.

Startup's earlier shared-state discovery also waits up to five minutes for live offline maintenance to finish, including after an update or service restart. It reports the current maintenance PID and role every 30 seconds, then reports admission or failure. Cancellation still ends the wait. The wait never kills the maintenance process, reclaims its live lock, or repeats admitted discovery work; if it expires, let the recorded process finish before retrying startup.

### State and config locks

- On Linux and macOS, the process owner lives at `$OPENCLAW_STATE_DIR/tmp/openclaw-<uid>/state.<hash>.lock`. It uses the selected state storage without requiring write access to its parent or depending on the system temporary directory. On Windows it lives beneath the user's `AppData/Local/OpenClaw/locks/openclaw-state-owners` directory. The hash identifies the resolved shared-state database path. `TMPDIR` does not change this namespace.
- Destructive cleanup preserves the process owner and compatibility projection while removing state contents, so new startup remains blocked until native database resources and destructive operations settle. Normal release removes the sidecars; no SQLite coordinator database accompanies them.
- Cleanup refuses redirected database or runtime-lock paths before deleting state: removing an internal symlink could select a new owner while the original files remain locked. Select the actual state root and real internal directories before retrying. An alias for the entire state root remains supported.
- Ownership uses exclusive file creation and fs-safe's existing checked release and stale-recovery protocol. A dead process or a verified changed process start identity permits recovery. Age alone never revokes a live owner, and unreadable ownership remains a refusal.
- On macOS, a hostname change during the same kernel boot does not invalidate process ownership. OpenClaw compares the kernel boot UUID, then verifies the recorded PID and process start identity. A changed hostname with a different or unavailable boot identity remains unverifiable; it does not authorize takeover.
- Same-host Windows ownership uses the recorded PID and absolute process start time, without requiring a PowerShell boot-time query. Older records with boot timestamps use the same process-identity checks even when those timestamps disagree. A Linux PID reused as an unrelated worker thread is no longer the original owner. If process identity cannot be confirmed, stop the recorded holder before retrying; do not remove its lock while it may still be running.
- Linux reads the PID namespace identity from the `/proc/self/ns/pid` symlink, so PRoot environments can verify ownership even when following that link with `stat` fails. The boot identity and namespace link must remain readable; unavailable identity does not disable ownership checks.
- Only explicitly launcher-bound CLI respawns record their launcher's PID and start identity. Detached update drivers retain independent maintenance ownership. Launcher loss requests graceful termination so Doctor can settle repairs, release leases, and restore services; the heartbeat worker supplies the same cancellation and bounded escalation if the main thread is blocked. Peers preserve custody until the owner exits, then recover its stale claim.
- A dedicated worker renews the lock's mtime while the Gateway is busy. The worker and its parent measure the last successful renewal using the same wall-clock timestamp, including on Bun where worker-relative clocks have different origins. After a long pause or clock adjustment, the owner verifies the held inode and exact acquisition bytes before renewing. A process that retains its physical lock can resume safely; a removed or replaced lock ends ownership. Persistent renewal failures use a 60-second failure deadline. The shared heartbeat never advances beyond the oldest timestamp supplied to its locks. A stopped heartbeat never permits a foreign process to reclaim the lock automatically.
- Ordinary reads reuse verified process-owner and compatibility-projection custody while the local Gateway or embedded owner accepts work. Owner loss, release, cleanup, and schema-maintenance transitions invalidate the retained paths; there is no per-read expiry timer. Reads without a serving local process owner retain fresh verification. A failed initial verification refuses the affected read; the next read retries.
- Writes, schema and maintenance transitions, lease grants, and each generic SQLite worker job retain fresh ownership checks at admission. Repeated read-access checks within that admission reuse process custody. This does not replace physical database identity, caller authorization, native-resource custody, or transaction/commit admission.
- A missing namespace in a legacy Windows file lock permits reclamation only after its heartbeat is more than 90 seconds old and native PID liveness or a recorded process start-time mismatch proves the owner stopped. It never grants local maintenance authority. Other unverifiable process namespaces never permit automatic lock reclamation or grant local maintenance authority. Ordinary access to an existing compatible database, including restart-intent writes for older Gateways, does not require reclamation. Foreign schema and offline-maintenance owners still defer access; metadata snapshots require verified live or dead ownership before choosing a live backup or offline copy.
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

In-process restarts run under the Gateway loop's lifetime, so closing the config reload or request that triggered a restart cannot cancel state-ownership reacquisition. Reacquisition failures include their underlying cause in the Gateway log. Contention with another owner retains the startup wait above.

On Unix, destructive cleanup retains SQLite's native exclusion until the database is removed. On Windows, SQLite's open file handles prevent unlink; the cleanup command closes its own check before removal. Native cleanup must finish before process ownership is released.

Normal upgrades preserve mutual exclusion with older state-local-lock runtimes through the compatibility projection and historical-owner checks. After releasing both sidecars, destructive cleanup removes only empty directories whose filesystem identities still match the directories it owned. A replacement directory or a new owner's files remain intact, and cleanup reports an interrupted removal. The managed update path stops the old service before mutation. Binaries predating state-local ownership retain their existing supported-upgrade stop checks.

## Recover a crashed foreign owner

A foreign or unreadable PID namespace, denied process probe, or unavailable boot
identity cannot prove that an owner is dead. Startup reports the recorded PID,
host/namespace, heartbeat age, and the inspection command:

```bash
openclaw gateway recover-lock
```

First confirm that the recorded holder has stopped through its container or
service manager. Run the exact `openclaw gateway recover-lock --confirm
<fingerprint>` command printed by inspection, using the same state directory and
profile. It recovers the inspected sidecars through fs-safe's
remove-if-unchanged protocol, clears the matching SQLite or PostgreSQL Gateway owner lease
under exclusive state custody, and releases its temporary custody. A renewed
heartbeat, changed payload, replaced file, or changed lease invalidates the
confirmation; inspect again instead of removing lock files by hand. A locally
verified live holder is always refused.

PostgreSQL inspection uses the selected state family and verifies the original
anchor, store identity and stable lease-table contract without initializing or
migrating application schemas. Confirmation serializes with the store's native
advisory lock, locks and compares the complete lease row, and removes only that
unchanged owner. Inspection can read a stable lease contract from another application
schema version, but confirmation requires this binary's current GLOBAL schema version
before recovering any sidecars or lease. Store unavailability, lock contention and changed records fail
visibly; they do not authorize automatic foreign-owner reclamation.

Automatic recovery remains available for a verified exited PID or changed process
start identity within the same PID namespace, and for a verified host reboot.
Legacy Windows file locks without a namespace also require an expired heartbeat and native proof that the recorded process stopped; live or unknown owners remain refused, including during confirmed recovery. Elapsed time and missing boot observations alone are not evidence of death. See
[Gateway recovery CLI](/cli/gateway/running#recover-an-unverifiable-state-lock).

## Operational notes

- If the port is occupied by a different, non-gateway process, the error is the same; free the port or choose another with `openclaw gateway --port <port>`.
- `OPENCLAW_ALLOW_MULTI_GATEWAY=1` permits multiple config/runtime instances, not shared mutable state. Each instance still needs a unique `OPENCLAW_STATE_DIR`.
- Under a service supervisor, a new gateway process that hits either error above first checks `/healthz` on the existing process. If that process is healthy, the new process leaves it in control instead of failing. On systemd, it exits with code `78`; the unit's `RestartPreventExitStatus=78` stops `Restart=always` from looping on a lock or `EADDRINUSE` conflict. If the existing process never becomes healthy, the health-check retry is time-bounded and startup then fails with the lock error above instead of looping forever.
- A hardened systemd unit can fail the state ownership lock with `openat2 beneath root: Function not implemented (os error 38) | ENOSYS` even on a kernel that supports `openat2` (Linux 5.6 or newer). On the reported Ubuntu 24.04 / systemd 255 setup, `RestrictSUIDSGID=true` installs a seccomp filter that returns `ENOSYS` for `openat2`. Releases without the guarded fs-safe fallback (2026.9.5 and 2026.9.6) then crash-loop at startup, and Doctor on those releases can report the failure as unavailable maintenance ownership instead of the underlying `ENOSYS`. Do not delete lock or state files for this error. Upgrade to a release with the guarded fallback and keep `RestrictSUIDSGID=true`. If an upgrade is unavailable, temporarily removing the directive from the unit and its drop-ins, running `systemctl --user daemon-reload`, and restarting the service can confirm this filter interaction. This reduces service hardening; restore the directive when upgrading. See [Secure file operations](/gateway/security/secure-file-operations) for native and fallback behavior.
- The macOS app keeps its own lightweight PID guard before spawning the gateway; the file lock and socket bind above are the actual runtime enforcement.

## Related

- [Multiple Gateways](/gateway/multiple-gateways) - running multiple instances with unique ports
- [Troubleshooting](/gateway/troubleshooting) - diagnosing `EADDRINUSE` and port conflicts
