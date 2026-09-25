---
summary: "Install, start, stop, and uninstall the managed Gateway service, including wrappers, heap sizing, and install-time auth"
read_when:
  - Managing the Gateway as a native OS service
  - Recovering an unreadable native service definition
  - Installing the Gateway service through a wrapper
title: "Manage the Gateway service"
sidebarTitle: "Service"
---

Native service lifecycle, recovery, wrappers, and the managed-service option reference. Part of the [`openclaw gateway`](/cli/gateway) reference.

## Manage the Gateway service

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

`gateway stop` remains available when plugin configuration needs Doctor migration.
It still validates core configuration and refuses configuration written by a newer
OpenClaw binary. Start and restart continue to validate plugin configuration.

If `gateway start` reaches its readiness deadline while the managed Gateway is
still starting, it reports `still-starting` and exits with code `2`. The service
keeps running; check `openclaw gateway status --deep` again before restarting it.
A crashed service or a foreign listener still produces a failure. Port ownership
alone does not prove readiness or rule out warm-up.

### Recover an unreadable native service definition

If installation or a managed update reports `SERVICE_DEFINITION_UNKNOWN`, first
restore access to the service files and native service manager. `--force` does not
bypass unknown service facts. Inspect the selected service with
`openclaw gateway status --deep` from the account and profile that own it.

For a malformed definition or unsupported environment syntax, privately back up
the service files and any values stored only in its environment. Correct unresolved
or unsupported values before reinstalling; OpenClaw cannot infer their intended
values. Then, from an external shell using the same account and profile:

```bash
openclaw gateway uninstall
openclaw gateway install
openclaw gateway health
```

Uninstall removes the native registration and launcher, preserving configuration,
plugin installations, session state, and workspaces. Reinstallation rebuilds the
service environment from the current configuration and installation inputs;
service-only values must be supplied again. If native service status is itself
unavailable, uninstall also refuses: restore native manager access first instead
of deleting state or bypassing inspection.

### Lifecycle requests from Gateway chat

Gateway-hosted OpenClaw chat controls the exact Gateway serving that session.
An approved start request reports **Gateway already running** without discovering
or starting another service. Restart keeps the safe local restart behavior.

An approved stop reports **Scheduled Gateway stop** after the host has prepared
the stop for its exact instance. This acknowledges scheduling, not completed
termination. An exclusive foreground host drains work, finishes teardown, and
exits successfully without discovering or changing an installed service. A host
managed by launchd or systemd verifies native ownership and prepares an executor,
then drains work and finishes teardown before asking the native manager to stop
the service. The requesting operation can finish its audit, history, and response
submission during that drain;
this does not guarantee that the client receives the response before disconnecting.

After the normal grace period, stop cancels the remaining runs owned by that
Gateway and waits for their commands and cleanup to settle. Ordinary stop does
not schedule restart recovery. A required cleanup failure produces a nonzero exit and
prevents an in-process replacement, including when startup failed before the
Gateway became ready.

Ownership or preparation failures leave the Gateway serving and return an error.
Linux uses an independent transient control scope, in the owning systemd manager,
so the stop command survives service cgroup termination. On macOS, hosted stop
requests ordinary `launchctl bootout` without changing persistent enablement.
If the native manager sends `SIGTERM` during the final stop handoff, the host
finishes its graceful exit after joining cleanup, including the owned stop client.

On Windows, a run loop that exclusively owns the Gateway process also uses
graceful process exit under Task Scheduler. It does not select or stop a task by
name. The generated task supervisor waits for the child process tree to exit and
propagates the child exit result through the launcher. Its
[`RestartOnFailure` policy](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element)
does not restart a successful task exit. Custom wrappers can have different exit
or restart behavior; check their policy separately. This stop path does not change
the task definition or its restart policy. Externally supervised Gateways direct
stop requests to their supervisor.

If systemd definitively refuses a stop after teardown and the same native instance
remains active with no pending job, the host logs the failed stop and starts a fresh
Gateway generation in the same process. An uncertain native result is recorded as
a failed shutdown, without claiming success or starting an in-process replacement.
After an unexpected disconnect, check `openclaw gateway status` and the native
service logs from an external shell before retrying. Standalone CLI lifecycle
commands retain their service-management behavior.

### Pin the service runtime

Forced reinstall retains a supported Node executable recorded in the service.
Doctor also retains it when no runtime migration is needed. An explicit
`--runtime node` requests automatic selection again.

Use `--runtime-path` to keep the service on an operator-selected Node or Bun
executable instead of automatic runtime selection:

```bash
openclaw gateway install --runtime-path "/absolute/path/to/node" --force
```

The path must be absolute, executable, and match `--runtime` when that option is
also supplied. The runtime must pass the current Node/Bun and SQLite capability
checks. Paths containing spaces are supported; quote them in your shell.

The pin is saved in machine-state metadata for this managed service.
Forced reinstall, update, and definition repair preserve it. A missing or
unsupported pin fails with a diagnostic rather than silently switching runtimes.
To replace it, supply another `--runtime-path`; to return to automatic selection,
run `openclaw gateway install --runtime node --force` without `--runtime-path`.
An explicit wrapper still controls the executable and takes precedence over a pin.
Installation starts the service and may restart an existing Gateway.

### Repair a LaunchAgent environment wrapper

On macOS, the generated LaunchAgent starts a shell wrapper with the generated
environment file followed by the Gateway command. If `gateway status` reports a
missing environment-file argument, or the service log reports **Invalid LaunchAgent
environment file**, run `openclaw gateway install --force` from the owning account
and profile, then check `openclaw gateway status` and `openclaw health`.

Back up the plist and private service environment file before repairing a malformed
definition. If its runtime argument was also changed, select the intended executable
explicitly with `--runtime-path` as shown above. A recorded runtime pin whose service
definition has changed must be explicitly selected again. Keep service-only
environment values available to the reinstall; malformed wrapper arguments can
prevent OpenClaw from reading the previous environment file.

### Install with a wrapper

Use `--wrapper` when the managed service must start through another executable, for example a secrets manager shim or a run-as helper. The wrapper receives the normal Gateway args and is responsible for eventually exec'ing `openclaw` or Node with those args.

```bash
cat > ~/.local/bin/openclaw-doppler <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec doppler run --project my-project --config production -- openclaw "$@"
EOF
chmod +x ~/.local/bin/openclaw-doppler

openclaw gateway install --wrapper ~/.local/bin/openclaw-doppler --force
openclaw gateway restart
```

You can also set the wrapper through the environment. `gateway install` validates that the path is an executable file, writes the wrapper into the service `ProgramArguments`, and persists `OPENCLAW_WRAPPER` in the service environment for later forced reinstalls, updates, and doctor repairs.

```bash
OPENCLAW_WRAPPER="$HOME/.local/bin/openclaw-doppler" openclaw gateway install --force
openclaw doctor
```

To remove a persisted wrapper, clear `OPENCLAW_WRAPPER` while reinstalling:

```bash
OPENCLAW_WRAPPER= openclaw gateway install --force
openclaw gateway restart
```

<AccordionGroup>
  <Accordion title="Command options">
    - `gateway status`: `--url`, `--port`, `--token`, `--password`, `--timeout`, `--no-probe`, `--require-rpc`, `--deep`, `--json`
    - `gateway install`: `--port`, `--runtime <node|bun>` (default: `node`), `--runtime-path <path>`, `--token`, `--wrapper <path>`, `--force`, `--json`
    - `gateway restart`: `--safe`, `--skip-deferral`, `--force`, `--wait <duration>`, `--preserve-definition`, `--json`
    - `gateway uninstall|start`: `--json`
    - `gateway stop`: `--disable`, `--force`, `--json`

  </Accordion>
  <Accordion title="Service runtime">
    - Node is the primary, default, and recommended managed Gateway runtime.
    - For unpinned services, `gateway install` checks the Node executable recorded in the managed service. If it is missing, non-executable, or unsupported, installation refreshes the service without requiring `--force` and reports the replacement path. This also applies when an installer or update refreshes the service. Repair prefers the current CLI's supported Node, retaining stable Homebrew paths, then checks supported system installations. Custom wrappers keep control of their runtime; protected service definitions still require their deployment owner to repair them.
    - Bun 1.4+ with WAL-reset-safe `node:sqlite` is available as an explicit opt-in with `gateway install --runtime bun`.

  </Accordion>
  <Accordion title="Lifecycle behavior">
    - `gateway start` is idempotent: when the managed service is already running, it reports the running process and leaves it untouched. A loaded but stopped service is started as before.
    - If no managed service is installed, `gateway start` prints install hints and exits nonzero. `gateway restart` can first recover an installed-but-unloaded LaunchAgent or a verified unmanaged Gateway; if neither a managed service nor recovery handles the action, it prints the same hints and exits nonzero. Stopping an absent service remains a successful no-op.
    - If `gateway start` or `gateway restart` needs to repair a stale service definition, the command refuses when the invoking shell resolves a different state directory, config path, or port than the installed service. Match or unset the conflicting environment overrides, or use `openclaw gateway install --force` to retarget the service intentionally.
    - On Linux, `gateway start` and `gateway restart` also refuse ineffective repairs when an operator-owned systemd drop-in overrides the command or working directory. Inspect the effective unit with `systemctl --user cat <unit>.service`, then update or remove that drop-in. `gateway install --force` rewrites only the managed base unit and warns if the override remains; `Environment=` drop-ins remain supported.
    - `gateway restart --preserve-definition` restarts only an inspectable native service, skips automatic definition repair, and checks health at the installed launcher's port. It does not recover an unmanaged listener and cannot be combined with `--safe` or external supervision. On macOS it can bootstrap an unloaded readable plist without rewriting the plist, environment, wrapper, or permissions; denied native activation fails without file repair. On Windows it also retains existing Startup entries. The `daemon restart` alias accepts the same option.
    - During writable Linux service installs or refreshes, keep the unit and state directories stationary and avoid concurrent manual edits. OpenClaw serializes its own writers and aborts on detected changes, but cannot coordinate arbitrary filesystem edits. Moving or replacing a parent directory mid-publication can leave a temporary file inside the moved directory; inspect it before retrying.
    - On macOS, rollback of a failed LaunchAgent replacement restores the previous plist bytes and permission bits, including binary plists. If restoration cannot finish, the command reports the failure.
    - Use `gateway restart` to restart a managed service. Do not chain `gateway stop` and `gateway start` as a restart substitute.
    - The running Gateway records its process identity, listener mode, and supervisor in shared state. Restart preserves a verified live owner while it boots, even before its listener opens; a health timeout does not make that owner stale. A recorded foreground owner receives a targeted restart even when a native service is installed. Scheduled Task cleanup preserves external supervisors and other tasks, identifying their owner in the error. Older Gateways without a recorded identity remain terminable when their arguments exactly match the installed task command. Without that attribution, a held coordinator leaves the process running and asks you to retry after startup. Unverified listeners are reported instead of being killed.
    - In a non-interactive shell, `gateway stop` requires `--force`. Interactive terminals keep the existing prompt-free behavior. For automation and tests, prefer `gateway run --dev` or an isolated `--profile` with a free port.
    - On macOS, `gateway stop` uses `launchctl bootout` by default, which removes the LaunchAgent from the current boot session without persisting a disable — KeepAlive auto-recovery stays active for future crashes and `gateway start` re-enables cleanly without a manual `launchctl enable`. Pass `--disable` to persistently suppress KeepAlive and RunAtLoad so the gateway does not respawn until the next explicit `gateway start`; use this when a manual stop should survive reboots.
    - Gateway lifecycle mutations append best-effort key-value audit records to `<state-dir>/logs/gateway-restart.log`, including CLI start, stop, and restart operations, safe restart requests, supervisor restarts, and detached handoffs.
    - Lifecycle commands accept `--json` for scripting.
    - A restart that completes native activation or accepted recovery but fails its health check emits `action: "restart"`, `ok: false`, and `result: "restart-health-failed"`, retaining its error, hints, warnings, and exit code 1. This diagnostic does not authorize another activation. Refusals, unexpected exceptions, and definition repair without confirmed activation do not emit this result. A scheduled restart reports acceptance, without claiming successor health.

  </Accordion>
  <Accordion title="Managed Gateway heap sizing">
    - A managed Node Gateway install does not add an automatic process-wide `--max-old-space-size`, and `gateway install` explicitly clears `NODE_OPTIONS` in the service environment so ambient service-manager preload/debug flags cannot leak into the Gateway. Node therefore uses its native default main-isolate heap, and each worker's `resourceLimits.maxOldGenerationSizeMb` budget (model catalog, SQLite, transcript, state) stays effective. A process-wide V8 flag applies to every worker isolate and silently overrides those budgets, so OpenClaw does not set one for you.
    - Capacity is the smaller of valid physical RAM and a valid constraint reported by Node, never fluctuating free RAM. With no usable capacity reading, Node keeps its native default. The installer's capacity recommendation targets 50% of capacity, with a nominal 2048 MiB floor and a cap of the greater of 8192 MiB or 25% of capacity. A final 75% capacity cap reserves native-memory headroom and can put small-host budgets below the nominal floor.
    - Examples: 32 GiB capacity recommends 8 GiB old space; 64 GiB recommends 16 GiB; 128 GiB recommends 32 GiB. Old space is only part of V8's total heap, and neither is a limit on total process memory (RSS). Raising the ceiling does not preallocate that memory. The recommendation is diagnostic for Node and is not applied automatically.
    - Operator-owned heap controls are preserved across forced reinstalls and doctor repairs, including absolute old-space, percentage old-space, and total-heap flags in the service argv or `NODE_OPTIONS`. Only heap flags survive managed `NODE_OPTIONS` sanitization; arbitrary preload/debug flags do not. Put intentional preload/debug settings in an operator-owned systemd `Environment=` drop-in, or set them inside an [installed wrapper](#install-with-a-wrapper) before it launches Node. Do not edit the generated service environment for those settings. Existing stored numbers are preserved even when they resemble an older automatic default or exceed the current recommendation.
    - Regeneration never adds an automatic heap argument. Operator values and drop-in files stay separate from the managed base. Existing managed argv controls remain: Node's argv wins over `NODE_OPTIONS` for the same option, and percentage old-space sizing takes precedence over absolute old-space sizing. An explicit process-wide flag you set re-introduces the worker-budget override described above. Inspect both surfaces before changing a cap.
    - Ambient installer `NODE_OPTIONS` and the installer's own Node arguments are not saved as Gateway heap settings. An explicit budget takes effect when the service process starts; it is not recalculated while the Gateway runs. Upgrading OpenClaw alone does not change whether a process-wide flag is set, and foreground launches do not replace themselves to apply this policy.
    - The installer's memory constraints can differ from the future service's constraints. Node/libuv reporting is platform-dependent and does not guarantee detection of every ancestor cgroup limit; inspect the actual service or container limits before increasing a budget.
    - This policy applies to managed Node Gateway launches, not foreground `gateway run`, custom supervisors, Docker runtime commands, Bun, or node-host services. Those retain their own runtime configuration. See [memory troubleshooting](/gateway/troubleshooting#gateway-exits-during-high-memory-use) for explicit native Node settings.

  </Accordion>
  <Accordion title="Auth and SecretRefs at install time">
    - When token auth requires a token and `gateway.auth.token` is SecretRef-managed, `gateway install` validates that the SecretRef is resolvable but does not persist the resolved token into service environment metadata.
    - Reinstall and update preserve existing service values for active env SecretRefs, including Gateway tokens and passwords. On Linux and macOS, legacy inline values move into the generated owner-only env file before the unit or LaunchAgent is rewritten. This does not make service credentials available to interactive CLI commands.
    - If token auth requires a token and the configured token SecretRef is unresolved, install fails closed instead of persisting fallback plaintext.
    - For password auth on `gateway run`, prefer `OPENCLAW_GATEWAY_PASSWORD`, `--password-file`, or a SecretRef-backed `gateway.auth.password` over inline `--password`.
    - In inferred auth mode, shell-only `OPENCLAW_GATEWAY_PASSWORD` does not relax install token requirements; use durable config (`gateway.auth.password` or config `env`) when installing a managed service.
    - If both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, install is blocked until mode is set explicitly.

  </Accordion>
</AccordionGroup>
