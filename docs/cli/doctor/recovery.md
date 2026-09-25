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

Doctor also compares the service's package path and version with the active CLI,
without requiring a Gateway connection. Update finalization and standalone
`openclaw doctor --fix` reconcile eligible, previously running managed services
through the native installer; update-time Doctor reports drift and defers publication
to finalization. Doctor can automatically refresh installation-only drift in a
verified, writable packaged service. It also repairs recognized stale native
policy, such as a missing systemd `KillMode=mixed` or zero Scheduled Task restart
retries, through the update installer's backup transaction before restoring a
Gateway stopped for maintenance. Doctor reports changed keys and backup paths;
supported custom settings survive the rewrite. Automatic native-policy repair
preserves unknown operator edits and uncertain definitions for operator review.
Other command or credential changes still require interactive confirmation.
Services already stopped keep their definitions and stop state; run the reported
profile-aware `openclaw gateway install --force` command from the intended
installation to reconcile them (installation may start the service).
It preserves the service's profile and an explicit service port when no port is
configured. Source checkouts, deployment-owned overrides, and unavailable native
inspection do not grant automatic installation repair authority; Doctor reports
the mismatch and the next repair action.

If Doctor loses maintenance ownership during installation, it stops further
installation or activation and restores its captured service definition when it
can verify ownership of the replacement. The warning reports whether the
definition was unchanged, restored, or needs inspection; follow the reported
status and installer commands after the active maintenance or update finishes.
Unverified restoration keeps recovery pending instead of claiming a safe restart.

When explicit repair stops a managed Gateway, Doctor waits for that process to
release shared-state lifecycle ownership within the service stop deadline before
repairing state. If ownership remains held, Doctor warns, restores the service,
and refuses the unsafe repair. On macOS, failed activation attempts restore the
LaunchAgent registration so its KeepAlive policy can recover; the error reports
whether the job is loaded and gives a recovery command if bootstrap also fails.
An ambiguous `kickstart` error followed by a probe that confirms the job is absent
uses bootstrap recovery; successful activation then completes normally. A failure
for a job that remains loaded stays visible.

Doctor rechecks update admission after acquiring both maintenance coordinators.
If it must cancel before repair starts, it reverses its own stop while its native
service custody remains valid. Normal post-repair restoration still requires
current update admission.

If Doctor's output pipe closes (for example, `openclaw doctor --fix | head -20`),
or Doctor receives SIGINT, SIGTERM, or SIGPIPE during maintenance, it waits for
admitted repair work and service restoration before exiting. An ordinary repair
error also restores the managed service Doctor stopped, using the current saved
configuration. Pending approval prompts cancel without interrupting admitted
writes. Concrete data risks, lost service authority, and unverified child
cleanup still prevent unsafe activation and report the recovery action.

For legacy services or conflicting systemd scopes, run `openclaw doctor`
interactively to review the findings and confirm supported cleanup. Cleanup
reports what it removed or skipped; it does not guarantee a replacement service
will be installed. Explicit repair maintenance skips this separate cleanup flow.

If Doctor stopped a managed Gateway for repair, a failed or timed-out restoration
probe produces a warning and Doctor still attempts to start that service and
verify readiness. Live maintenance custody and update admission still apply;
observed changes to the service command, account, or manager require operator review.
An explicit ownership refusal is reported as a refusal, without attempting to
start the rejected service. On systemd, Doctor retains the native manager and
unit identity before stopping the service and revalidates it at activation. If
that identity cannot be captured, Doctor leaves the service running and reports
the inspection warning; live state writers still prevent unsafe offline repair.

When service inspection blocks repair, Doctor and `gateway status --deep` name
the failed native probe:

- **Linux inspection deadline expired:** the manager probe or its custody/admission
  guards exhausted the inspection budget. This does not mean the user session bus
  is missing. Check the reported restoration result and run
  `openclaw gateway status --deep` after recovery.
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

For a system template such as `openclaw@.service` with `User=%i`, inspection
follows the current account's instance (`openclaw@<user>.service`) while
preserving the shared template. Run Doctor as that account after the system
service owner stops its instance.

Doctor waits for a starting local Gateway using the shared 60-second readiness budget, both on its initial check and after an approved restart. It reports the observed startup phase while waiting. A Gateway that still reports startup at the deadline produces a non-failing “still starting” result; Doctor leaves it running and does not offer another restart. Connection failure without startup evidence remains a diagnostic failure. This also applies when an installed updater invokes the candidate Doctor.

Plugin initialization and database startup checks can make a cold start take longer than ten seconds on a loaded or older host. Let the existing Gateway finish starting before requesting a separate restart. Remote Gateway diagnostics keep using the configured remote target.

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

Known redaction placeholders, including `__OPENCLAW_REDACTED__`, are also invalid
credentials. Doctor and `gateway status --deep` name the affected reference even
if an older Gateway process still works with its previous in-memory token.
For a store-backed Gateway token, run `openclaw doctor --fix` (or
`openclaw doctor --generate-gateway-token`). Doctor verifies a database backup,
regenerates the referenced value, preserves the SecretRef and the entry's current
`secret`/`env` kind and allowed hosts, and prints the backup path. A credential
changed during backup is preserved. Restart the Gateway,
then reconnect or re-pair devices with the new token.

Explicit token generation reports when it skips a healthy SecretRef. Other
placeholder secrets require a real replacement from their provider; Doctor
reports them without deleting their stored values.

In trusted-proxy mode, a redacted inline or environment-supplied optional password
does not block proxy authentication. Startup, Doctor, and status warn that local
password fallback is unavailable. Replace or remove the optional password and
restart; Doctor preserves trusted-proxy mode instead of generating a token.

## macOS: `launchctl` env overrides

If you previously ran `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (or `...PASSWORD`), that value supplies fallback credentials when local configuration does not supply one. A configured inline credential or active SecretRef takes precedence over its matching environment fallback. A stale fallback can cause persistent "unauthorized" errors when it is selected.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
