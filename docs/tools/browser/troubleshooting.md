---
summary: "Separating CDP startup failures from navigation SSRF blocks, plus the platform-specific pages"
title: "Browser troubleshooting"
read_when:
  - The browser will not start or a page will not load
  - You need to tell a CDP readiness failure from a policy block
---

For Linux-specific issues (especially snap Chromium), see
[Browser troubleshooting](/tools/browser-linux-troubleshooting).

For WSL2 Gateway + Windows Chrome split-host setups, see
[WSL2 + Windows + remote Chrome CDP troubleshooting](/tools/browser-wsl2-windows-remote-cdp-troubleshooting).

## Slow first browser request

Managed Chrome starts on demand when an operation needs it. The browser control
service being ready means its routes are available; it does not mean Chrome has
finished starting. `tabs` checks the current browser without launching it.

Local tool dispatch, Gateway, and node requests wait for shared managed-browser startup before
spending their action timeout. Startup allows up to two minutes for profile
bootstrap, decoration, launch, and CDP readiness. A caller that cancels or stops
waiting does not cancel the shared launch. Stopping or resetting the browser
does cancel it. If startup exhausts its own budget, the error names the profile
and startup deadline; inspect the browser startup logs before retrying.

## Inspection times out but screenshots work

Snapshots and page-text reads use a browser automation connection that can become
stale even while tab listing and screenshots still work. OpenClaw reconnects once
when that connection can no longer resolve the requested tab. Unresponsive sibling
tabs share one target-inspection wait instead of adding a separate wait per tab.

Retry the inspection once with the same profile and target ID. If it still fails,
run `openclaw browser doctor` and inspect a screenshot before restarting the
Gateway. A browser-rendered HTTP error, such as `403 Forbidden`, is evidence that
the website denied access; it does not establish whether a profile or resource
exists.

## Output directory errors

If an output fails with `Invalid path: must stay within output directory`, set
the output directory to its resolved path. Browser outputs reject
user-created symlinks anywhere in the directory path, including when the final
directory already exists. The macOS `/tmp` and `/var` system aliases remain
supported.

## CDP startup failure vs navigation SSRF block

These are different failure classes and they point to different code paths.

- **CDP startup or readiness failure** means OpenClaw cannot confirm that the browser control plane is healthy.
- **Navigation SSRF block** means the browser control plane is healthy, but a page navigation target is rejected by policy.

Common examples:

- CDP startup or readiness failure:
  - `Chrome CDP websocket for profile "openclaw" is not reachable after start`
  - `Remote CDP for profile "<name>" is not reachable at <cdpUrl>`
  - `Port <port> is in use for profile "<name>" but not by openclaw` when a
    loopback external CDP service is configured without `attachOnly: true`
- Navigation SSRF block:
  - `open`, `navigate`, snapshot, or tab-opening flows fail with a browser/network policy error while `start` and `tabs` still work

Use this minimal sequence to separate the two:

```bash
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw tabs
openclaw browser --browser-profile openclaw open https://example.com
```

How to read the results:

- If `start` fails with `not reachable after start`, troubleshoot CDP readiness first.
- If `start` succeeds but `tabs` fails, the control plane is still unhealthy. Treat this as a CDP reachability problem, not a page-navigation problem.
- If `start` and `tabs` succeed but `open` or `navigate` fails, the browser control plane is up and the failure is in navigation policy or the target page.
- If `start`, `tabs`, and `open` all succeed, the basic managed-browser control path is healthy.

A cold Playwright connection must initialize every existing page in the profile.
If a renderer is unresponsive, even a snapshot of a healthy tab can time out.
When the error names a page target, close that target in the browser or provider
dashboard and retry. If direct closure is unavailable, restart the affected
browser profile. OpenClaw does not automatically close user-owned tabs.

Important behavior details:

- Browser config defaults to an SSRF policy object that blocks disallowed destinations even when you do not configure `browser.ssrfPolicy`.
- For the local loopback `openclaw` managed profile, CDP health checks intentionally skip browser SSRF reachability enforcement for OpenClaw's own local control plane.
- Local managed Chrome gets up to 60 seconds for launch discovery, followed by up to 30 seconds for CDP readiness. Readiness checks allow up to 1.5 seconds per HTTP request and 2 seconds per WebSocket stage to tolerate Gateway scheduling delays; checks near the deadline use shorter timeouts.
- Later operations use the same readiness allowance for an owned managed browser before deciding it needs a restart. Stopping a profile aborts its pending discovery and readiness checks; canceling one caller waiting for a shared start does not stop that shared launch.
- Navigation protection is separate. A successful `start` or `tabs` result does not mean a later `open` or `navigate` target is allowed.
- Timed-out or cancelled page interactions and `browser navigate` requests cancel their pending navigation-policy checks. A stalled DNS check from that request should not keep the profile busy when you run `openclaw browser stop`. An observed browser dialog interrupts the foreground interaction without cancelling its still-active navigation guard.

Resetting or deleting a local managed profile stops a verified browser left by an
earlier Gateway runtime before moving its data. If a live profile owner cannot be
verified or stopped, OpenClaw preserves the profile data and reports the reason.
Close the browser using that profile and check its Chromium lock before retrying.
Locks naming another hostname remain unverified, including after a machine rename;
starting the browser also preserves that locked profile's preferences.

Security guidance:

- Do **not** relax browser SSRF policy by default.
- Prefer narrow exact-hostname `allowedHostnames` exceptions over broad private-network access.
- Use `dangerouslyAllowPrivateNetwork: true` only in intentionally trusted environments where private-network browser access is required and reviewed.

## Profile lock names another hostname

If `start` fails with `Chromium profile lock names another hostname`, the
profile's `SingletonLock` names a different host than this machine reports now.
OpenClaw does not clear such a lock on its own, because it cannot verify the
owner from this machine.

On macOS this can also follow a network-driven hostname change. If
`scutil --get HostName` reports `not set`, macOS may derive its hostname from
DHCP or reverse DNS, so the name can change between, for example,
`my-mac.local` and `my-mac.lan`.

To recover, first confirm that the lock names this Mac's previous hostname
(`readlink` on `SingletonLock` shows `<hostname>-<pid>`) and that no browser on
this or another host is using the profile. Then remove `SingletonLock`,
`SingletonSocket`, and `SingletonCookie` from the profile's `user-data`
directory (for the default managed profile,
`~/.openclaw/browser/openclaw/user-data`) and start the browser again. This
preserves the profile data, including cookies; no profile reset is needed.

With the browser closed, you can optionally set a stable hostname with
`sudo scutil --set HostName <name>` to prevent further network-driven changes.
