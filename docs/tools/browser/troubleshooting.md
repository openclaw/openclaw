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
- Navigation protection is separate. A successful `start` or `tabs` result does not mean a later `open` or `navigate` target is allowed.

Security guidance:

- Do **not** relax browser SSRF policy by default.
- Prefer narrow exact-hostname `allowedHostnames` exceptions over broad private-network access.
- Use `dangerouslyAllowPrivateNetwork: true` only in intentionally trusted environments where private-network browser access is required and reviewed.
