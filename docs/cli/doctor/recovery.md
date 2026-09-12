---
summary: "Recover the Gateway service, a remote Gateway, Control UI assets, and Gateway tokens"
title: "Gateway and service recovery"
read_when:
  - Doctor reports a missing, stale, or unmanaged Gateway service
  - You hit persistent unauthorized errors or missing Control UI assets
---

These sections cover repairing the Gateway service, its remote and Control UI
prerequisites, and the credentials it starts with.

## Gateway service recovery

Run `openclaw gateway status --deep` to inspect the installed service and its
runtime before choosing a recovery action. Use `openclaw gateway install` for a
missing service, `openclaw gateway start` for an installed service that is not
loaded, or `openclaw gateway install --force` from the intended installation to
replace its service definition. Externally managed services still belong to
their supervisor.

For legacy services or conflicting systemd scopes, run `openclaw doctor`
interactively to review the findings and confirm supported cleanup. Cleanup
reports what it removed or skipped; it does not guarantee a replacement service
will be installed. Explicit repair maintenance skips this separate cleanup flow.

When service inspection blocks repair, Doctor and `gateway status --deep` name
the failed native probe:

- **Linux user session bus unavailable:** check `XDG_RUNTIME_DIR` and
  `DBUS_SESSION_BUS_ADDRESS` for the service account. A working `systemctl --user`
  command alone is insufficient: effective service inspection also uses
  `busctl --user`. On Debian/Ubuntu, install `dbus-user-session`, then run
  `systemctl --user start dbus.socket` from that account's user session.
- **Probe cannot start (`EACCES`/`EPERM`):** check executable permissions and
  directory access as the service account. Native probes run from the filesystem
  root so an inaccessible operator directory inherited through `sudo -u` does
  not prevent inspection.
- **macOS GUI domain unavailable:** sign in to the desktop as the target user
  before managing its LaunchAgent. Error 125 for `gui/<uid>` does not establish
  that a system LaunchDaemon exists.
- **macOS system domain unavailable or system LaunchDaemon detected:** have root
  inspect `sudo launchctl print system/<label>` and stop the custom daemon through
  its deployment owner. To retain that supervisor, run Doctor as the state-owning
  account with the existing `OPENCLAW_SERVICE_REPAIR_POLICY=external` policy.
  Keep the same `HOME`, `OPENCLAW_STATE_DIR`, and `OPENCLAW_CONFIG_PATH` selectors
  used by the service. See [Existing system LaunchDaemons](/gateway#existing-system-launchdaemons).

OpenClaw does not manage custom system LaunchDaemons. Running Doctor as root
with another account's `HOME` does not add that capability and can create
root-owned state files.

For either platform, when an external supervisor owns the Gateway, have that
owner stop it and run Doctor as the state-owning account with
`OPENCLAW_SERVICE_REPAIR_POLICY=external`. This existing policy skips native
maintenance inspection and service mutations; it retains Gateway/state
coordinators and agent-database lease checks. Shutdown and restart remain with
the deployment owner. A failed native probe is never treated as proof that the
Gateway is stopped.

## Remote Gateway recovery

With `gateway.mode: "remote"`, a failed Gateway health check does not trigger
local service install, start, restart, or bootstrap prompts. Check the remote
URL, credentials, and SSH tunnel or network connection. If the Gateway itself
needs recovery, run service commands on the host that runs it. A loopback remote
URL can be an SSH tunnel; it does not make the Gateway a local service.

See [Remote access](/gateway/remote) for connection checks. Other Doctor config
and state checks still follow the selected [posture](/cli/doctor/running#postures).

## Control UI assets

For source installs, Doctor can build missing Control UI assets or rebuild stale
assets after protocol changes. Its manual build command includes the detected
checkout path (`pnpm --dir <checkout> ui:build`), so you can run the displayed
command from another directory. Use the complete command, including its quoted
path, rather than running `pnpm ui:build` in an unrelated project.

Packaged installs without UI sources receive reinstall guidance instead of a
source-build command. Doctor does not download a source checkout to repair a
packaged installation.

## Invalid Gateway tokens

Doctor flags active Gateway tokens that are blank or contain the literal string
`undefined` or `null`. The Gateway rejects these values at startup. To replace an
inline token, run `openclaw doctor --fix --generate-gateway-token`, then restart
the Gateway. For a SecretRef, rotate the external secret source instead; doctor
preserves its reference and leaves password, `none`, and trusted-proxy auth modes
unchanged. An absent token still uses the normal startup token generation flow.

## macOS: `launchctl` env overrides

If you previously ran `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (or `...PASSWORD`), that value supplies fallback credentials when local configuration does not supply one. A configured inline credential or active SecretRef takes precedence over its matching environment fallback. A stale fallback can cause persistent "unauthorized" errors when it is selected.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
