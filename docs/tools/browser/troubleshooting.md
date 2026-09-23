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
the output directory to its real, canonical path. Browser outputs reject
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

Important behavior details:

- Browser config defaults to a fail-closed SSRF policy object even when you do not configure `browser.ssrfPolicy`.
- For the local loopback `openclaw` managed profile, CDP health checks intentionally skip browser SSRF reachability enforcement for OpenClaw's own local control plane.
- After launching a local managed browser, readiness probes allow up to 1.5 seconds per HTTP request and 2 seconds per WebSocket stage to tolerate Gateway scheduling delays. The readiness retry window is eight seconds; probes near its end use shorter timeouts.
- Later operations use the same readiness allowance for an owned managed browser before deciding it needs a restart. Stopping a profile aborts its pending discovery and readiness probes; canceling one caller waiting for a shared start does not stop that shared launch.
- Navigation protection is separate. A successful `start` or `tabs` result does not mean a later `open` or `navigate` target is allowed.

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
