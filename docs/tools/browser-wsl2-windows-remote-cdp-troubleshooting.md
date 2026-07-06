---
summary: "Troubleshoot WSL2 Gateway + Windows Chrome remote CDP in layers"
read_when:
  - Running OpenClaw Gateway in WSL2 while Chrome lives on Windows
  - Seeing overlapping browser/control-ui errors across WSL2 and Windows
  - Deciding between host-local Chrome MCP and raw remote CDP in split-host setups
title: "WSL2 + Windows + remote Chrome CDP troubleshooting"
---

In the common split-host setup, OpenClaw Gateway runs inside WSL2, Chrome runs
on Windows, and browser control must cross the WSL2/Windows boundary. Several
independent problems can surface at once (see
[issue #39369](https://github.com/openclaw/openclaw/issues/39369)): CDP
transport, Control UI origin security, and token/pairing can each fail on
their own while producing similar-looking errors. Work through the layers
below in order instead of guessing which one is broken.

## Choose the right browser mode first

### Option 1: raw remote CDP from WSL2 to Windows

Use a remote browser profile pointing from WSL2 to a Windows Chrome CDP
endpoint. Choose this when the Gateway stays inside WSL2, Chrome runs on
Windows, and browser control needs to cross the WSL2/Windows boundary.

### Option 2: host-local Chrome MCP

Use the `existing-session` driver (`user` profile) only when the Gateway runs
on the same host as Chrome, you want the local signed-in browser state, you do
not need cross-host browser transport, and you do not need `responsebody`,
PDF export, download interception, or batch actions (Chrome MCP profiles do
not support these).

For WSL2 Gateway + Windows Chrome, use raw remote CDP. Chrome MCP is
host-local, not a WSL2-to-Windows bridge.

## Working architecture

- WSL2 runs the Gateway on `127.0.0.1:18789`
- Windows opens the Control UI in a normal browser at `http://127.0.0.1:18789/`
- Windows Chrome exposes a CDP endpoint on port `9222`
- WSL2 can reach that Windows CDP endpoint
- OpenClaw points a browser profile at the address reachable from WSL2

## Critical rule for the Control UI

When the UI is opened from Windows, use Windows localhost unless you have a
deliberate HTTPS setup:

```text
http://127.0.0.1:18789/
```

Do not default to a LAN IP. Plain HTTP on a LAN or tailnet address can
trigger insecure-origin/device-auth behavior unrelated to CDP itself. See
[Control UI](/web/control-ui).

## Validate in layers

Work top to bottom; do not skip ahead. Fixing one layer can still leave a
different error visible from a layer further down.

### Layer 1: verify Chrome is serving CDP on Windows

```powershell
chrome.exe --remote-debugging-port=9222
```

From Windows, verify Chrome itself first:

```powershell
curl http://127.0.0.1:9222/json/version
curl http://127.0.0.1:9222/json/list
```

If this fails on Windows, OpenClaw is not the problem yet.

### Layer 2: verify WSL2 can reach that Windows endpoint

From WSL2, test the exact address you plan to use in `cdpUrl`:

```bash
curl http://WINDOWS_HOST_OR_IP:9222/json/version
curl http://WINDOWS_HOST_OR_IP:9222/json/list
```

Good result:

- `/json/version` returns JSON with Browser / Protocol-Version metadata
- `/json/list` returns JSON (an empty array is fine if no pages are open)

If this fails, Windows is not exposing the port to WSL2 yet, the address is
wrong for the WSL2 side, or firewall/port-forwarding/proxying is missing. Fix
that before touching OpenClaw config.

### Layer 3: configure the correct browser profile

Point OpenClaw at the address reachable from WSL2:

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
- `cdpUrl` can be `http://`, `https://`, `ws://`, or `wss://`
- use HTTP(S) when you want OpenClaw to discover `/json/version`
- use WS(S) only when the browser provider gives you a direct DevTools
  socket URL
- test the same URL with `curl` before expecting OpenClaw to succeed

### Layer 4: verify the Control UI layer separately

Open `http://127.0.0.1:18789/` from Windows, then verify:

- the page origin matches what `gateway.controlUi.allowedOrigins` expects
- token auth or pairing is configured correctly
- you are not debugging a Control UI auth problem as if it were a browser
  problem

Helpful page: [Control UI](/web/control-ui).

### Layer 5: verify end-to-end browser control

From WSL2:

```bash
openclaw browser --browser-profile remote open https://example.com
openclaw browser --browser-profile remote tabs
```

Good result:

- the tab opens in Windows Chrome
- `browser tabs` returns the target
- later actions (`snapshot`, `screenshot`, `navigate`) work from the same
  profile

## Common misleading errors

| Message                                                                                 | Meaning                                                                                                                                                                           |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `control-ui-insecure-auth`                                                              | UI origin/secure-context problem, not a CDP transport problem                                                                                                                     |
| `token_missing`                                                                         | auth configuration problem                                                                                                                                                        |
| `pairing required`                                                                      | device approval problem                                                                                                                                                           |
| `Remote CDP for profile "remote" is not reachable`                                      | WSL2 cannot reach the configured `cdpUrl`                                                                                                                                         |
| `Browser attachOnly is enabled and CDP websocket for profile "remote" is not reachable` | the HTTP endpoint answered, but the DevTools WebSocket could not be opened                                                                                                        |
| stale viewport / dark-mode / locale / offline overrides after a remote session          | run `openclaw browser --browser-profile remote stop` to close the session and release the cached Playwright/CDP connection without restarting the Gateway or the external browser |
| timeout around `remoteCdpTimeoutMs` (default 1500ms)                                    | usually still CDP reachability, or a slow/unreachable remote endpoint                                                                                                             |
| `Playwright page enumeration timed out after 3000ms`                                    | the remote CDP connected, but its persistent tab read stalled; the deadline is the larger of `remoteCdpTimeoutMs` and `remoteCdpHandshakeTimeoutMs`                               |
| `No Chrome tabs found for profile="user"`                                               | local Chrome MCP profile selected where no host-local tabs are available                                                                                                          |

## Fast triage checklist

1. Windows: does `curl http://127.0.0.1:9222/json/version` work?
2. WSL2: does `curl http://WINDOWS_HOST_OR_IP:9222/json/version` work?
3. OpenClaw config: does `browser.profiles.<name>.cdpUrl` use that exact
   WSL2-reachable address?
4. Control UI: are you opening `http://127.0.0.1:18789/` instead of a LAN IP?
5. Are you trying to use `existing-session` across WSL2 and Windows instead
   of raw remote CDP?

Verify the Windows Chrome endpoint locally first, verify the same endpoint
from WSL2 second, and only then debug OpenClaw config or Control UI auth.

## Related

- [Browser](/tools/browser)
- [Browser login](/tools/browser-login)
- [Browser Linux troubleshooting](/tools/browser-linux-troubleshooting)
