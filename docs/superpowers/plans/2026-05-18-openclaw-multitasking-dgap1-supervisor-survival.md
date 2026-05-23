# OpenClaw Multitasking — D-GAP-1 Supervisor Restart Survival

Status: design + implementation notes for gate G-D1 (`feat(supervisor): add restart-survival boundary`).

## Summary

The in-memory process supervisor (`src/process/supervisor/supervisor.ts`) spawns
workers as direct children of the gateway. A direct child shares the gateway's
lifecycle domain — the POSIX process group, and under a managed install the
gateway service cgroup — so a gateway restart or `systemctl stop` tears the
worker down with it. Gate G-D1 adds a `SupervisorBoundary`
(`src/process/supervisor/boundary.ts`) that can wrap a worker's argv so it runs
in a lifecycle domain independent of the gateway and survives a gateway restart.

The behavior is opt-in and default-off: callers request it via
`SpawnChildInput.surviveSupervisorRestart`. When the platform integration is
unavailable the boundary resolves to `inline`, which preserves the legacy direct-
child spawn with no survival guarantee.

## Problem

- Workers must be able to outlive a gateway restart (`systemctl --user restart`,
  an in-place update, or an explicit `systemctl stop`) and still write their
  terminal event, instead of dying with the gateway.
- Cancellation must still work: once a worker lives in its own lifecycle domain,
  a process-group/tree kill from the gateway can no longer reach it.

## Linux design (implemented + proven)

- Boundary: a transient `systemd-run --user --scope` unit named
  `openclaw-worker-<sanitized-runId>.scope`.
- The scope is registered under the per-user manager (`app.slice`), a sibling of
  the gateway service cgroup. `systemctl --user stop <gateway>` kills only the
  gateway cgroup; the sibling scope worker survives, finishes, and writes its
  terminal event.
- Launcher flags: `--quiet` (no "Running scope as unit" banner so worker stdout
  stays clean), `--collect` (garbage-collect the transient scope on exit),
  `--scope` (run as a descendant but in a new cgroup under the user manager).
- Availability probe (`isSystemdUserScopeAvailable`): requires the `systemd-run`
  binary on `PATH` and a reachable user bus (`$DBUS_SESSION_BUS_ADDRESS` or
  `$XDG_RUNTIME_DIR/bus`). No probe process is spawned.

### Launcher user-bus env (D-GAP-1 blocker 1)

`systemd-run --user` needs `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS` to
reach the per-user manager. A worker may carry an explicit env override (e.g. an
agent CLI run) that omits these. The child adapter therefore fills any missing
user-bus vars from the gateway's own `process.env` — never from the worker
override — so an override that drops them still launches into the user manager.
Keys the override sets explicitly are left untouched. See
`withSystemdLauncherEnv` in `src/process/supervisor/adapters/child.ts`.

### Cancellation

A survivable worker lives in its own cgroup, so a process-group/tree kill cannot
reach it. The launch plan carries a `stopCommand`
(`systemctl --user stop <unit>`); the adapter issues it once on kill in addition
to killing the local launcher process. Cancellation of a detached worker is
best-effort/advisory.

### Proof

`src/process/supervisor/supervisor-survival.systemd.e2e.test.ts` stands up a real
`systemd --user` "gateway" service whose process launches a worker through the
production systemd-scope plan, stops the gateway with `systemctl --user stop`,
then releases the worker strictly after the gateway is confirmed down and asserts
the worker writes a `completed` (not `timeout`) terminal event. The e2e is
skipped when no per-user systemd manager is reachable; the boundary plan and
adapter wiring have always-on unit coverage in `boundary.test.ts` and
`adapters/child.test.ts`.

## macOS gap (D-GAP-1 blocker 2): resolves to inline, no survival yet

macOS has **no** survival boundary and `resolveSupervisorBoundary` returns the
`inline` (non-survivable) boundary on darwin.

The tempting analog of the systemd scope, `launchctl submit -l <label> -- <argv>`,
is **not** a safe substitute and was removed rather than shipped behind a flag:

- `launchctl submit` returns immediately. The supervisor's child adapter would
  observe the short-lived `launchctl` process exit, not the worker's, so
  `wait()` would resolve with the wrong lifetime and exit status.
- The worker is handed to launchd, so its stdout/stderr are no longer piped back
  to the adapter — output capture and the no-output timeout break.
- Terminal-event tracking is lost for the same reason.

Shipping a "survivable" boundary that silently breaks lifetime, output, and
terminal tracking is worse than no survival. macOS therefore stays on inline
until a correct boundary exists.

### Residual risk / future macOS work

A correct macOS survival boundary needs a bootstrapped launchd job rather than
`launchctl submit`:

- Write a transient plist and `launchctl bootstrap gui/<uid> <plist>` so launchd
  (not the gateway) owns the job in the per-user GUI domain.
- Redirect the worker's stdout/stderr to files the supervisor can tail so output
  capture and the no-output timeout keep working.
- Track completion via the job's exit, and cancel via
  `launchctl bootout gui/<uid>/<label>` (the analog of `systemctl --user stop`).
- Add a real survival e2e (stop the owning gateway, prove the job finishes and
  writes its terminal event) before any caller relies on macOS survival.

Until that lands, callers requesting `surviveSupervisorRestart` on macOS get the
documented, safe fallback: a normal direct-child spawn with no survival.

## Default-off contract

`surviveSupervisorRestart` is opt-in (`SpawnChildInput`). No production caller is
required to set it, so the default supervisor behavior is unchanged on every
platform. On Linux without a reachable user manager, and on macOS / other
platforms, the request degrades to the inline boundary.
