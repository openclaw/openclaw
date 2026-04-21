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
- you do not need advanced managed/raw-CDP-only routes like `responsebody`, PDF
  export, download interception, or batch actions

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

### Layer 2b: Bridge Windows localhost CDP to WSL2

Chrome binds CDP to `127.0.0.1` only. Modern Chrome (v110+) ignores the
`--remote-debugging-address=0.0.0.0` flag, so WSL2 cannot reach the CDP
endpoint directly — even over Tailscale or the WSL2 virtual NIC.

The standard fix is **netsh portproxy**, a Windows kernel-level TCP forwarder
that relays inbound connections on a public address to localhost:

> ⚠️ **Security note:** This exposes Chrome's unauthenticated CDP endpoint on
> `0.0.0.0:9222`. On shared or public networks, any reachable host could attach
> to CDP and control the browser. Restrict the firewall rule to trusted IPs when
> possible (see the constrained variant below), or use Tailscale ACLs to limit
> which devices can reach port 9222.

```powershell
# Run in an elevated PowerShell on Windows

# 1. Add the port proxy (persists across reboots)
netsh interface portproxy add v4tov4 `
  listenport=9222 listenaddress=0.0.0.0 `
  connectport=9222 connectaddress=127.0.0.1

# 2. Open the firewall — choose ONE of the two options below

# Option A: Broad allow (simple, use only on trusted/private networks)
New-NetFirewallRule `
  -DisplayName "Chrome CDP" `
  -Direction Inbound `
  -LocalPort 9222 `
  -Protocol TCP `
  -Action Allow `
  -Profile Any

# Option B: Constrained to WSL2/Tailscale subnets only (recommended)
# Use 100.64.0.0/10 for Tailscale, and your specific WSL2 gateway IP
# (e.g. 172.28.0.1/32) instead of the broad 172.16.0.0/12 range.
# Find your WSL2 gateway with: ip route show default | awk '{print $3}'
New-NetFirewallRule `
  -DisplayName "Chrome CDP (WSL2 only)" `
  -Direction Inbound `
  -LocalPort 9222 `
  -Protocol TCP `
  -Action Allow `
  -Profile Any `
  -RemoteAddress "100.64.0.0/10","172.28.0.1/32"
```

> **Important:** Do not run both firewall rules. Option A and Option B are
> mutually exclusive. If you previously created Option A and want to switch
> to the constrained variant, remove the broad rule first:
>
> ```powershell
> Remove-NetFirewallRule -DisplayName "Chrome CDP"
> ```

**Why both steps are needed:**

- `netsh portproxy` makes Windows accept TCP on `0.0.0.0:9222` and forward
  each connection to `127.0.0.1:9222` (where Chrome is listening). The proxy
  persists in the Windows registry and survives reboots.
- The firewall rule allows inbound TCP on port 9222 from any network profile
  (Private, Public, Domain). Without `-Profile Any`, Tailscale or the WSL2
  virtual adapter may be on a profile that blocks the port.

**Verify from WSL2:**

```bash
# Replace with your Windows Tailscale IP or WSL2 gateway IP
curl http://100.x.x.x:9222/json/version
```

If you see a JSON response with `Browser` and `Protocol-Version`, the bridge
is working. If the connection hangs or is refused:

- Check the firewall rule exists: `Get-NetFirewallRule -DisplayName "Chrome CDP"`
- Verify the portproxy: `netsh interface portproxy show all`
- Ensure Chrome is running with `--remote-debugging-port=9222`
- Try `-Profile Any` if you originally omitted it

**Tailscale users:** use the Tailscale IP of the Windows host (e.g.
`100.x.x.x`) as the `cdpUrl` target from WSL2. Tailscale's direct
connectivity avoids the WSL2 virtual NIC overhead.

**Auto-start Chrome with debugging:** place a `.bat` file in the Windows
Startup folder:

```bat
@echo off
taskkill /F /IM chrome.exe 2>nul
timeout /t 2 /nobreak >nul
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%LOCALAPPDATA%\Google\Chrome\User Data"
```

This ensures Chrome launches with CDP enabled on every login without
manual intervention.

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
- `cdpUrl` can be `http://`, `https://`, `ws://`, or `wss://`
- use HTTP(S) when you want OpenClaw to discover `/json/version`
- use WS(S) only when the browser provider gives you a direct DevTools socket URL
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

### "Empty reply from server" on port 9222

If `curl` connects but gets an empty reply, the portproxy is forwarding the
TCP connection, but Chrome is closing it because the source IP is not
`127.0.0.1`. This happens when:

- The portproxy `connectaddress` is wrong (not `127.0.0.1`)
- A third-party relay or proxy is inserting itself between portproxy and Chrome

Fix: ensure the netsh portproxy targets `connectaddress=127.0.0.1` exactly.

### Port 9223 (or other relay ports) blocked by firewall

If you use a relay on a different port (e.g. 9223), you need a separate
firewall rule for that port too. The simplest approach: use port 9222
with netsh portproxy directly, avoiding the need for extra ports.

Treat each message as a layer-specific clue:

- `control-ui-insecure-auth`
  - UI origin / secure-context problem, not a CDP transport problem
- `token_missing`
  - auth configuration problem
- `pairing required`
  - device approval problem
- `Remote CDP for profile "remote" is not reachable`
  - WSL2 cannot reach the configured `cdpUrl`
- `Browser attachOnly is enabled and CDP websocket for profile "remote" is not reachable`
  - the HTTP endpoint answered, but the DevTools WebSocket still could not be opened
- stale viewport / dark-mode / locale / offline overrides after a remote session
  - run `openclaw browser stop --browser-profile remote`
  - this closes the active control session and releases Playwright/CDP emulation state without restarting the gateway or the external browser
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

## Practical takeaway

The setup is usually viable. The hard part is that browser transport, Control UI origin security, and token/pairing can each fail independently while looking similar from the user side.

When in doubt:

- verify the Windows Chrome endpoint locally first
- verify the same endpoint from WSL2 second
- only then debug OpenClaw config or Control UI auth
