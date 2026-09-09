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
    - `gateway install`: `--port`, `--runtime <node|bun>` (default: `node`), `--token`, `--wrapper <path>`, `--force`, `--json`
    - `gateway restart`: `--safe`, `--skip-deferral`, `--force`, `--wait <duration>`, `--preserve-definition`, `--json`
    - `gateway uninstall|start`: `--json`
    - `gateway stop`: `--disable`, `--force`, `--json`

  </Accordion>
  <Accordion title="Service runtime">
    - Node is the primary, default, and recommended managed Gateway runtime.
    - Bun 1.4+ with WAL-reset-safe `node:sqlite` is available as an explicit opt-in with `gateway install --runtime bun`.

  </Accordion>
  <Accordion title="Lifecycle behavior">
    - `gateway start` is idempotent: when the managed service is already running, it reports the running process and leaves it untouched. A loaded but stopped service is started as before.
    - If no managed service is installed, `gateway start` prints install hints and exits nonzero. `gateway restart` can first recover an installed-but-unloaded LaunchAgent or a verified unmanaged Gateway; if neither a managed service nor recovery handles the action, it prints the same hints and exits nonzero. Stopping an absent service remains a successful no-op.
    - If `gateway start` or `gateway restart` needs to repair a stale service definition, the command refuses when the invoking shell resolves a different state directory, config path, or port than the installed service. Match or unset the conflicting environment overrides, or use `openclaw gateway install --force` to retarget the service intentionally.
    - On Linux, `gateway start` and `gateway restart` also refuse ineffective repairs when an operator-owned systemd drop-in overrides the command or working directory. Inspect the effective unit with `systemctl --user cat <unit>.service`, then update or remove that drop-in. `gateway install --force` rewrites only the managed base unit and warns if the override remains; `Environment=` drop-ins remain supported.
    - `gateway restart --preserve-definition` restarts only an inspectable native service, skips automatic definition repair, and checks health at the installed launcher's port. It does not recover an unmanaged listener and cannot be combined with `--safe` or external supervision. On macOS it can bootstrap an unloaded readable plist without rewriting the plist, environment, wrapper, or permissions; denied native activation fails without file repair. On Windows it also retains existing Startup entries. The legacy `daemon restart` command accepts the same option. Older CLIs reject the option before running restart or repair.
    - During writable Linux service installs or refreshes, keep the unit and state directories stationary and avoid concurrent manual edits. OpenClaw serializes its own writers and aborts on detected changes, but cannot coordinate arbitrary filesystem edits. Moving or replacing a parent directory mid-publication can leave a temporary file inside the moved directory; inspect it before retrying.
    - Use `gateway restart` to restart a managed service. Do not chain `gateway stop` and `gateway start` as a restart substitute.
    - In a non-interactive shell, `gateway stop` requires `--force`. Interactive terminals keep the existing prompt-free behavior. For automation and tests, prefer `gateway run --dev` or an isolated `--profile` with a free port.
    - On macOS, `gateway stop` uses `launchctl bootout` by default, which removes the LaunchAgent from the current boot session without persisting a disable — KeepAlive auto-recovery stays active for future crashes and `gateway start` re-enables cleanly without a manual `launchctl enable`. Pass `--disable` to persistently suppress KeepAlive and RunAtLoad so the gateway does not respawn until the next explicit `gateway start`; use this when a manual stop should survive reboots.
    - Gateway lifecycle mutations append best-effort key-value audit records to `<state-dir>/logs/gateway-restart.log`, including CLI start, stop, and restart operations, safe restart requests, supervisor restarts, and detached handoffs.
    - Lifecycle commands accept `--json` for scripting.
    - A restart that completes native activation or accepted recovery but fails its health check emits `action: "restart"`, `ok: false`, and `result: "restart-health-failed"`, retaining its error, hints, warnings, and exit code 1. This diagnostic does not authorize another activation. Refusals, unexpected exceptions, and definition repair without confirmed activation do not emit this result. A scheduled restart reports acceptance, without claiming successor health.

  </Accordion>
  <Accordion title="Managed Gateway heap sizing">
    - For a managed Node Gateway without an existing heap setting, `gateway install` places `--max-old-space-size` in Node's launch arguments, before the entry script. It explicitly clears `NODE_OPTIONS` in the service environment so ambient service-manager preload/debug flags cannot leak into the Gateway. Plain spawned Node processes do not inherit the new automatic budget through `NODE_OPTIONS`; Node's fork and Worker inheritance rules are unchanged.
    - Capacity is the smaller of valid physical RAM and a valid constraint reported by Node, never fluctuating free RAM. With no usable capacity reading, Node keeps its native default. The installer targets 50% of capacity, with a nominal 2048 MiB floor and a cap of the greater of 8192 MiB or 25% of capacity. A final 75% capacity cap reserves native-memory headroom and can put small-host budgets below the nominal floor.
    - Examples: 32 GiB capacity selects 8 GiB old space; 64 GiB selects 16 GiB; 128 GiB selects 32 GiB. Old space is only part of V8's total heap, and neither is a limit on total process memory (RSS). Raising the ceiling does not preallocate that memory.
    - Existing managed service heap controls are preserved across forced reinstalls and doctor repairs, including absolute old-space, percentage old-space, and total-heap flags. Only heap flags survive managed `NODE_OPTIONS` sanitization; arbitrary preload/debug flags do not. Put intentional preload/debug settings in an operator-owned systemd `Environment=` drop-in, or set them inside an [installed wrapper](#install-with-a-wrapper) before it launches Node. Do not edit the generated service environment for those settings. Existing stored numbers are preserved even when they resemble an older automatic default or exceed the new recommendation.
    - When an operator-owned service override controls `NODE_OPTIONS` (including an empty value or reset), regeneration does not add a new automatic heap argument. Operator values and drop-in files stay separate from the managed base. Existing managed argv controls remain: Node's argv wins over `NODE_OPTIONS` for the same option, and percentage old-space sizing takes precedence over absolute old-space sizing. Inspect both surfaces before changing a cap.
    - Ambient installer `NODE_OPTIONS` and the installer's own Node arguments are not saved as Gateway heap settings. The budget is chosen at installation and takes effect when the service process starts; it is not recalculated while the Gateway runs. Upgrading OpenClaw alone does not resize a running Gateway, and foreground launches do not replace themselves to apply this policy.
    - The installer's memory constraints can differ from the future service's constraints. Node/libuv reporting is platform-dependent and does not guarantee detection of every ancestor cgroup limit; inspect the actual service or container limits before increasing a budget.
    - This policy applies to managed Node Gateway launches, not foreground `gateway run`, custom supervisors, Docker runtime commands, Bun, or node-host services. Those retain their own runtime configuration. See [memory troubleshooting](/gateway/troubleshooting#gateway-exits-during-high-memory-use) for explicit native Node settings.

  </Accordion>
  <Accordion title="Auth and SecretRefs at install time">
    - When token auth requires a token and `gateway.auth.token` is SecretRef-managed, `gateway install` validates that the SecretRef is resolvable but does not persist the resolved token into service environment metadata.
    - If token auth requires a token and the configured token SecretRef is unresolved, install fails closed instead of persisting fallback plaintext.
    - For password auth on `gateway run`, prefer `OPENCLAW_GATEWAY_PASSWORD`, `--password-file`, or a SecretRef-backed `gateway.auth.password` over inline `--password`.
    - In inferred auth mode, shell-only `OPENCLAW_GATEWAY_PASSWORD` does not relax install token requirements; use durable config (`gateway.auth.password` or config `env`) when installing a managed service.
    - If both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, install is blocked until mode is set explicitly.

  </Accordion>
</AccordionGroup>
