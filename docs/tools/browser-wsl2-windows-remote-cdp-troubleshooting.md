---
summary: "Troubleshoot WSL2 Gateway + Windows Chrome remote CDP in layers"
read_when:
  - Running OpenClaw Gateway in WSL2 while Chrome lives on Windows
  - Seeing overlapping browser/control-ui errors across WSL2 and Windows
  - Deciding between host-local Chrome MCP and raw remote CDP in split-host setups
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

### Option 1: Raw remote CDP from WSL2 to Windows

Use a remote browser profile that points from WSL2 to a Windows Chrome CDP endpoint.

Choose this when:

- the Gateway stays inside WSL2
- Chrome runs on Windows
- you need browser control to cross the WSL2/Windows boundary

### Option 2: Host-local Chrome MCP

Use `existing-session` / `user` only when the Gateway itself runs on the same host as Chrome.

Choose this when:

- OpenClaw and Chrome are on the same machine
- you want the local signed-in browser state
- you do not need cross-host browser transport

For WSL2 Gateway + Windows Chrome, prefer raw remote CDP. Chrome MCP is host-local, not a WSL2-to-Windows bridge.

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

### Layer 4: Verify the Control UI layer separately

Open the UI from Windows:

`http://127.0.0.1:18789/`

Then verify:

- the page origin matches what `gateway.controlUi.allowedOrigins` expects
- token auth or pairing is configured correctly
- you are not debugging a Control UI auth problem as if it were a browser problem

Helpful page:

- [Control UI](/web/control-ui)

### Layer 5: Verify end-to-end browser control

From WSL2:

```bash
openclaw browser open https://example.com --browser-profile remote
openclaw browser tabs --browser-profile remote
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
- `No Chrome tabs found for profile="user"`
  - local Chrome MCP profile selected where no host-local tabs are available

## Fast triage checklist

1. Windows: does `curl http://127.0.0.1:9222/json/version` work?
2. WSL2: does `curl http://WINDOWS_HOST_OR_IP:9222/json/version` work?
3. OpenClaw config: does `browser.profiles.<name>.cdpUrl` use that exact WSL2-reachable address?
4. Control UI: are you opening `http://127.0.0.1:18789/` instead of a LAN IP?
5. Are you trying to use `existing-session` across WSL2 and Windows instead of raw remote CDP?


## Recovery after toggling `hypervisorlaunchtype` (Windows gaming mode)

If you temporarily disable Hyper-V with:

```powershell
bcdedit /set hypervisorlaunchtype off
```

and later re-enable it with:

```powershell
bcdedit /set hypervisorlaunchtype auto
```

then reboot, WSL2 and the CDP bridge can return in a partially broken state.

Typical pattern:

- Windows local CDP works: `curl.exe http://127.0.0.1:9222/json/version`
- WSL2-to-host CDP fails: `curl http://WINDOWS_HOST_IP:9222/json/version` times out
- OpenClaw shows remote profile unreachable / empty tabs

### Recovery sequence

Run in **PowerShell as Administrator**:

```powershell
Get-Service iphlpsvc
Start-Service iphlpsvc

# Optional cleanup if host IP changed since last boot
netsh interface portproxy delete v4tov4 listenaddress=OLD_WINDOWS_HOST_IP listenport=9222

# Recreate bridge (works when Chrome listens on localhost)
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=9222 connectaddress=127.0.0.1 connectport=9222

# Allow inbound CDP traffic
netsh advfirewall firewall add rule name="Chrome CDP 9222 inbound" dir=in action=allow protocol=TCP localport=9222
```

Validate in **PowerShell** (use `curl.exe`, not `curl` alias):

```powershell
curl.exe http://127.0.0.1:9222/json/version
curl.exe http://WINDOWS_HOST_IP:9222/json/version
```

Validate in **WSL2**:

```bash
cat /etc/resolv.conf | grep nameserver
curl http://WINDOWS_HOST_IP:9222/json/version
openclaw gateway restart
openclaw browser tabs --browser-profile remote
```

`WINDOWS_HOST_IP` is usually the `nameserver` value in `/etc/resolv.conf` from WSL2.

### Important notes

- `netsh interface portproxy ...` requires **Administrator** shell.
- The WSL2 host IP (`172.30.x.1`) can change after reboot; stale `listenaddress` rules must be replaced.
- If testing in PowerShell, prefer `curl.exe`; `curl` may map to `Invoke-WebRequest` and produce misleading argument errors.

## Practical takeaway

The setup is usually viable. The hard part is that browser transport, Control UI origin security, and token/pairing can each fail independently while looking similar from the user side.

When in doubt:

- verify the Windows Chrome endpoint locally first
- verify the same endpoint from WSL2 second
- only then debug OpenClaw config or Control UI auth
