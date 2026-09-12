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
