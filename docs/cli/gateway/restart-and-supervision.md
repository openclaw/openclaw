---
summary: "`openclaw gateway restart`, install identity, external process supervisors, and Gateway profiling"
read_when:
  - Restarting the Gateway safely, forcibly, or with a bounded wait
  - Integrating an external Gateway process supervisor
  - Profiling Gateway startup and restart timings
title: "Restart and supervision"
sidebarTitle: "Restart and supervision"
---

Restart flags, which install owns the host service, external supervisors, and profiling. Part of the [`openclaw gateway`](/cli/gateway) reference.

## Restart the Gateway

```bash
openclaw gateway restart
openclaw gateway restart --safe
openclaw gateway restart --safe --skip-deferral
openclaw gateway restart --force
openclaw gateway restart --wait 30s
```

`--safe` asks the running Gateway to preflight active work and schedule one coalesced restart after that work drains. The wait is bounded to 5 minutes; when the budget expires the restart is forced. `--safe` cannot combine with `--force` or `--wait`.

`--skip-deferral` bypasses only the safe-restart active-work deferral gate. It can move the Gateway into shutdown even while active-work blockers are reported, but the close-stage pending-reply drain still applies before the process exits. It requires `--safe` — use it when a deferral is stuck on a runaway task and reply delivery can still be allowed to settle.

`--wait <duration>` overrides the drain budget for a plain (non-safe) restart. Accepts bare milliseconds or unit suffixes `ms`, `s`, `m`, `h`, `d` (e.g. `30s`, `5m`, `1h30m`); `--wait 0` waits indefinitely. Not compatible with `--force` or `--safe`.

`--force` skips the active-work drain and restarts immediately. Plain `restart` normally uses the service-manager restart path.

On Windows, a plain restart launched from a Gateway service process, including an agent's shell command, automatically uses the safe restart path. The running Gateway owns the deferred Scheduled Task handoff, so stopping its process tree cannot kill the caller before relaunch. This requires a reachable Gateway; the command acknowledges the restart request, not successor health. Use `openclaw gateway status` afterward to verify recovery.

On macOS, when `openclaw gateway restart`, `stop`, `install`, or `uninstall` runs inside the managed LaunchAgent's process tree, including an agent's shell command, OpenClaw detects that from launchd's service environment or, when a hand-written plist omits those variables, from process ancestry against the PID launchd reports for the job. Restart hands off to a detached helper so `kickstart -k` cannot kill the caller. Stop, install, and uninstall refuse and ask you to run the command from an external shell.

External terminals without Gateway-service markers, externally supervised Gateways, node services, and non-Windows callers keep their existing routing. Explicit `--force`, `--wait`, `--preserve-definition`, or `--skip-deferral` also retain their existing behavior and validation; they do not implicitly enable `--safe`.

<Warning>
Inline `--password` can be exposed in local process listings. Prefer `--password-file`, env, or a SecretRef-backed `gateway.auth.password`.
</Warning>

### Install identity

Service management (`install`, `start`, `stop`, `restart`, `uninstall`, Doctor service repair, and self-update service handling) belongs to the install that owns the host service. That is the canonical `.openclaw` directory under the OS account home, or the `.openclaw-<profile>` directory a named profile projects there. Named profiles use distinct native service identities.

`OPENCLAW_HOME`, or an `OPENCLAW_STATE_DIR` or `OPENCLAW_CONFIG_PATH` that points elsewhere, is treated as isolated state and skipped. A relocated or copied state tree cannot adopt and rewrite the account's host service.

On macOS and Windows, native service-managed profile names must be lowercase. Runtime-only profiles may still use uppercase, but case-distinct names such as `Main` and `main` share paths on normal case-insensitive filesystems and cannot safely own separate native services. On macOS, the lowercase names `gateway` and `node` are also unavailable for native service management because their historical LaunchAgent labels collide with the default Gateway and node-host services.

Named profiles must also use the native service identity derived from `OPENCLAW_PROFILE`. Unset `OPENCLAW_LAUNCHD_LABEL`, `OPENCLAW_SYSTEMD_UNIT`, or `OPENCLAW_WINDOWS_TASK_NAME` before service management; custom identities remain available for the default profile or runtime-only/external-supervisor setups.

On Linux, `openclaw gateway install --force` refuses a sealed systemd service
definition, or one whose write authority cannot be verified, before changing
configuration, authentication tokens, or service files. The error keeps its
`SERVICE_DEFINITION_SEALED` or `SERVICE_DEFINITION_UNKNOWN` prefix and adds a
reason tag and next action, without printing private paths, config, environment values,
or underlying inspection errors.

For `[unsafe-permissions]`, inspect the named artifact category locally. The
service directory is `~/.config/systemd/user`; on a fresh install, its nearest
existing ancestor may be `~/.config`. The service state directory belongs to the
selected profile. Check directory metadata, not file contents:

```bash
ls -ld ~/.config ~/.config/systemd ~/.config/systemd/user
```

Missing directories are normal on a fresh install. After confirming the affected
path is yours and is not intentionally shared, remove group/other write access
with `chmod go-w <path>` and retry the same command. Mode `0700` is appropriate
for private directories. Do not recursively chmod, take ownership of system
paths, or use `sudo`/`--force` to bypass the check. Foreign-owned files and sealed
mounts require the deployment owner; inspection failures require restoring
filesystem or native service-manager access first.

Type-wide `service.d` defaults are inspected as shared read-only inputs and do
not require write access. Root-owned selected units and unit-specific drop-ins
remain protected.

### External supervisors

Set `OPENCLAW_SUPERVISOR_MODE=external` only when another process manager owns the Gateway lifecycle. In this mode:

- `openclaw gateway restart` preserves the existing safe, forced, and bounded-wait behavior while targeting the verified running Gateway instead of launchd, systemd, or Task Scheduler. Exact-lock restart delivery runs inside that Gateway, so a replacement CLI does not migrate shared state before the old process hands off.
- Native service install, start, stop, and uninstall operations are refused with guidance to use the external supervisor.
- OpenClaw self-update is refused so the supervisor can stop the Gateway, replace and finalize the runtime, and restart it safely.
- A fresh-process restart writes a bounded SQLite handoff before clean exit. If persistence fails, the Gateway falls back to an in-process restart instead of exiting without a consumable handoff.

An external supervisor can also claim durable ownership of shared-state writes:

```bash
OPENCLAW_SUPERVISOR_MODE=external \
  openclaw database ownership claim --manager gateway-supervisor --json
```

Before claiming, stop and verify every older Gateway, CLI, Doctor, updater, and native app process that can write the shared state database. Pre-contract processes do not understand the ownership row and cannot be retroactively fenced. Claim only after every remaining writer uses ownership-aware code and carries `OPENCLAW_SUPERVISOR_MODE=external`.

The claim is idempotent for the same stable manager identifier and refuses a different manager. There is no automatic claim or unclaim path. Once claimed, unmarked writable shared-state opens fail before permissions, schema migration, additive repair, compaction, or other mutation. Read-only access remains available. This is protection against accidental unmarked same-user writers, not an authentication or lease protocol.

For upgrades and rollbacks, have the supervisor create a consolidated WAL-consistent copied snapshot with no SQLite sidecars, then run the target release's own `openclaw database preflight <copied-state.sqlite> --json` before activation. Numeric schema versions alone do not prove that a same-version additive shape is compatible. See [Database schemas](/reference/database-schemas).

`OPENCLAW_SERVICE_REPAIR_POLICY=external` remains a separate Doctor repair policy. It does not declare runtime ownership; supervisors that need both behaviors should set both variables.

External supervisors can negotiate and consume restart handoffs through the hidden machine contract:

```bash
openclaw gateway restart-handoff capabilities --json
openclaw gateway restart-handoff consume --expected-pid <pid> --json
```

Protocol version `1` supports the `consume` operation. Consumption validates the expected PID and bounded handoff fields inside one immediate SQLite transaction. An accepted handoff is deleted before success is returned, so concurrent or replayed consumers cannot both accept it. A PID mismatch is retained for the matching owner; missing, expired, and invalid rows do not authorize a restart.

Valid machine requests return JSON with exit code `0`, including non-restart results. Invalid arguments return `reason: "invalid-expected-pid"` with exit code `2`; state-store failures return `reason: "store-unavailable"` with exit code `1`. Supervisors should probe `capabilities` on the exact runtime or launcher they will use rather than infer support from an OpenClaw version string or read the private SQLite schema directly.

External supervisor implementations should also apply these acceptance rules:

- Bound capability probes with a timeout that accounts for full CLI cold-start latency on the deployed runtime and storage, rather than assuming warm-start timing.
- If capability negotiation or handoff consumption refuses replacement, exit promptly with a nonzero status so the process manager's recovery policy can run. Do not remain alive without a Gateway child or listener.
- Treat supervisor process liveness as distinct from replacement startup and channel readiness. Report success only after the new Gateway owns its listener and `/startupz` returns `status: "started"`; monitor `/readyz` separately for configured-channel health, while `/healthz` proves liveness only.

### Gateway profiling

- `OPENCLAW_GATEWAY_STARTUP_TRACE=1` logs phase timings during startup, including per-phase `eventLoopMax` delay and plugin lookup-table timings (installed-index, manifest registry, startup planning, owner-map work).
- `OPENCLAW_GATEWAY_RESTART_TRACE=1` logs `restart trace:` lines for restart signal handling, active-work drain, shutdown phases, next start, ready timing, and memory metrics. Ordinary stops also start a fresh trace with `stop.signal.received` and `stop.drain` timing. Named shutdown steps and coarse close phases emit `.begin` before waiting, then a duration when they settle; an unmatched begin identifies an entered phase that has not settled. These phases do not time every nested cleanup operation individually.
- `OPENCLAW_DIAGNOSTICS=timeline` with `OPENCLAW_DIAGNOSTICS_TIMELINE_PATH=<path>` writes a best-effort JSONL startup diagnostics timeline for external QA harnesses (equivalent to config `diagnostics.flags: ["timeline"]`; the path is still env-only). Add `OPENCLAW_DIAGNOSTICS_EVENT_LOOP=1` to include event-loop samples.
- `pnpm build` then `pnpm test:startup:gateway -- --runs 5 --warmup 1` benchmarks Gateway startup against the built CLI entry: first process output, `/healthz`, `/readyz`, startup trace timings, event-loop delay, and plugin lookup-table timing.
- `pnpm build` then `pnpm test:restart:gateway -- --case skipChannels --runs 1 --restarts 5` benchmarks in-process restart on macOS or Linux (not supported on Windows; restart requires `SIGUSR1`). Uses `SIGUSR1`, enables both traces in the child process, and records next `/healthz`, next `/readyz`, downtime, ready timing, CPU, RSS, and restart trace metrics.
- `/healthz` is liveness; `/readyz` is usable readiness. Treat trace lines and benchmark output as owner-attribution signal, not a complete performance conclusion from one span or sample.

Without tracing, stops and restarts report nonzero active-work category counts at
the first drain snapshot and at most once every 30 seconds while still pending.
These reports omit task identities and request origins; categories can overlap.
An ordinary stop logs `active-work drain settled; beginning server close` before
teardown, including after a drain timeout or failure. Diagnostics do not change
drain budgets or the service manager's stop deadline.

A client disconnect leaves interactive setup available for reconnect. A Gateway
stop or restart closes setup prompts before draining work. Settings writes already
in progress may finish, but setup will not wait for another answer during shutdown.
After the Gateway starts again, reopen setup and check the saved settings.
