---
summary: "Troubleshoot WSL2 Gateway + Windows Chrome remote CDP and extension-relay setups in layers"
read_when:
  - Running OpenClaw Gateway in WSL2 while Chrome lives on Windows
  - Seeing overlapping browser/control-ui errors across WSL2 and Windows
  - Deciding between raw remote CDP and the Chrome extension relay in split-host setups
title: "WSL2 + Windows + remote Chrome CDP troubleshooting"
---

# WSL2 + Windows + remote Chrome CDP troubleshooting

This guide covers the common split-host setup where:

- OpenClaw Gateway runs inside WSL2
- Chrome runs on Windows
- browser control must cross the WSL2/Windows boundary

It also covers the layered failure pattern from [issue #39369](https://github.com/openclaw/openclaw/issues/39369): several independent problems can show up at once, which makes the wrong layer look broken first.

## Choose the right browser mode first

You have two valid patterns:

### Option 1: Raw remote CDP

Use a remote browser profile that points from WSL2 to a Windows Chrome CDP endpoint.

Choose this when:

- you only need browser control
- you are comfortable exposing Chrome remote debugging to WSL2
- you do not need the Chrome extension relay

### Option 2: Chrome extension relay

Use the built-in `chrome-relay` profile plus the OpenClaw Chrome extension.

Choose this when:

- you want to attach to an existing Windows Chrome tab with the toolbar button
- you want extension-based control instead of raw `--remote-debugging-port`
- the relay itself must be reachable across the WSL2/Windows boundary

If you use the extension relay across namespaces, `browser.relayBindHost` is the important setting introduced in [Browser](/tools/browser) and [Chrome extension](/tools/chrome-extension).

## Working architecture

Reference shape:

- WSL2 runs the Gateway on `127.0.0.1:18789`
- Windows opens the Control UI in a normal browser at `http://127.0.0.1:18789/`
- Windows Chrome exposes a CDP endpoint on port `9222`
- WSL2 can reach that Windows CDP endpoint
- OpenClaw points a browser profile at the address that is reachable from WSL2

## Why this setup is confusing

Several failures can overlap:

- WSL2 cannot reach the Windows CDP endpoint
- the Control UI is opened from a non-secure origin
- `gateway.controlUi.allowedOrigins` does not match the page origin
- token or pairing is missing
- the browser profile points at the wrong address
- the extension relay is still loopback-only when you actually need cross-namespace access

Because of that, fixing one layer can still leave a different error visible.

## Critical rule for the Control UI

When the UI is opened from Windows, use Windows localhost unless you have a deliberate HTTPS setup.

Use:

`http://127.0.0.1:18789/`

Do not default to a LAN IP for the Control UI. Plain HTTP on a LAN or tailnet address can trigger insecure-origin/device-auth behavior that is unrelated to CDP itself. See [Control UI](/web/control-ui).

## Validate in layers

Work top to bottom. Do not skip ahead.

### Layer 1: Verify Chrome is serving CDP on Windows

Start Chrome on Windows with remote debugging enabled:

```powershell
chrome.exe --remote-debugging-port=9222
```

From Windows, verify Chrome itself first:

```powershell
curl http://127.0.0.1:9222/json/version
curl http://127.0.0.1:9222/json/list
```

If this fails on Windows, OpenClaw is not the problem yet.

### Layer 2: Verify WSL2 can reach that Windows endpoint

From WSL2, test the exact address you plan to use in `cdpUrl`:

```bash
curl http://WINDOWS_HOST_OR_IP:9222/json/version
curl http://WINDOWS_HOST_OR_IP:9222/json/list
```

Good result:

- `/json/version` returns JSON with Browser / Protocol-Version metadata
- `/json/list` returns JSON (empty array is fine if no pages are open)

If this fails:

- Windows is not exposing the port to WSL2 yet
- the address is wrong for the WSL2 side
- firewall / port forwarding / local proxying is still missing

Fix that before touching OpenClaw config.

### Layer 3: Configure the correct browser profile

For raw remote CDP, point OpenClaw at the address that is reachable from WSL2:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "remote",
    profiles: {
      remote: {
        cdpUrl: "http://WINDOWS_HOST_OR_IP:9222",
        attachOnly: true,
        color: "#00AA00",
      },
    },
  },
}
```

Notes:

- use the WSL2-reachable address, not whatever only works on Windows
- keep `attachOnly: true` for externally managed browsers
- test the same URL with `curl` before expecting OpenClaw to succeed

Optional: if you want a stable local loopback endpoint inside WSL2, enable the
CDP bridge and point the profile at the bridge instead of the Windows host
directly:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "remote",
    cdpBridge: {
      upstreamUrl: "http://WINDOWS_HOST_OR_IP:9222",
      bindHost: "127.0.0.1",
      port: 18794,
    },
    profiles: {
      remote: {
        cdpUrl: "http://127.0.0.1:18794",
        attachOnly: true,
        color: "#00AA00",
      },
    },
  },
}
```

Bridge notes:

- `browser.cdpBridge.upstreamUrl` is the Windows-reachable Chrome debug endpoint
- `browser.profiles.<name>.cdpUrl` stays local and is what MCP connects to
- use this when the Windows host/IP is annoying to keep track of or you want a
  single local attach URL inside WSL2

### Layer 4: If you use the Chrome extension relay instead

If the browser machine and the Gateway are separated by a namespace boundary, the relay may need a non-loopback bind address.

Example:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "chrome-relay",
    relayBindHost: "0.0.0.0",
  },
}
```

Use this only when needed:

- default behavior is safer because the relay stays loopback-only
- `0.0.0.0` expands exposure surface
- keep Gateway auth, node pairing, and the surrounding network private

If you do not need the extension relay, prefer the raw remote CDP profile above.

### Layer 5: Verify the Control UI layer separately

Open the UI from Windows:

`http://127.0.0.1:18789/`

Then verify:

- the page origin matches what `gateway.controlUi.allowedOrigins` expects
- token auth or pairing is configured correctly
- you are not debugging a Control UI auth problem as if it were a browser problem

Helpful page:

- [Control UI](/web/control-ui)

### Layer 6: Verify end-to-end browser control

From WSL2:

```bash
openclaw browser open https://example.com --browser-profile remote
openclaw browser tabs --browser-profile remote
```

For the extension relay:

```bash
openclaw browser tabs --browser-profile chrome-relay
```

Good result:

- the tab opens in Windows Chrome
- `openclaw browser tabs` returns the target
- later actions (`snapshot`, `screenshot`, `navigate`) work from the same profile

## Common misleading errors

Treat each message as a layer-specific clue:

- `control-ui-insecure-auth`
  - UI origin / secure-context problem, not a CDP transport problem
- `token_missing`
  - auth configuration problem
- `pairing required`
  - device approval problem
- `Remote CDP for profile "remote" is not reachable`
  - WSL2 cannot reach the configured `cdpUrl`
- `gateway timeout after 1500ms`
  - often still CDP reachability or a slow/unreachable remote endpoint
- `Chrome extension relay is running, but no tab is connected`
  - extension relay profile selected, but no attached tab exists yet

## Fast triage checklist

1. Windows: does `curl http://127.0.0.1:9222/json/version` work?
2. WSL2: does `curl http://WINDOWS_HOST_OR_IP:9222/json/version` work?
3. OpenClaw config: does `browser.profiles.<name>.cdpUrl` use the right endpoint for your mode
   (direct Windows address, or the local `browser.cdpBridge.port` endpoint if you enabled the bridge)?
4. Control UI: are you opening `http://127.0.0.1:18789/` instead of a LAN IP?
5. Extension relay only: do you actually need `browser.relayBindHost`, and if so is it set explicitly?

## Practical takeaway

The setup is usually viable. The hard part is that browser transport, Control UI origin security, token/pairing, and extension-relay topology can each fail independently while looking similar from the user side.

When in doubt:

- verify the Windows Chrome endpoint locally first
- verify the same endpoint from WSL2 second
- only then debug OpenClaw config or Control UI auth
