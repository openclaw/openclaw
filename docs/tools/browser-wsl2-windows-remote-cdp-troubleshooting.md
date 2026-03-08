---
summary: "Troubleshoot WSL2 Gateway + Windows Chrome remote CDP setups with layered checks"
read_when:
  - Running OpenClaw Gateway in WSL2 and Chrome on Windows
  - Seeing overlapping errors like control-ui-insecure-auth, token_missing, or Remote CDP unreachable
  - Remote browser profiles work inconsistently across CLI and Control UI
title: "WSL2 + Windows + remote Chrome CDP troubleshooting"
---

# WSL2 + Windows + remote Chrome CDP troubleshooting

This guide documents a working setup for running OpenClaw Gateway inside WSL2 while controlling a Chrome instance running on Windows through remote CDP.

It also documents the layered failure pattern from [issue #39369](https://github.com/openclaw/openclaw/issues/39369): multiple independent failures can look like the same problem, so users end up debugging the wrong layer first.

## Working architecture

Working reference setup:

- OpenClaw Gateway runs inside WSL2
- Chrome runs on Windows with remote debugging enabled on port `9222`
- Windows exposes a Windows-reachable endpoint for CDP (for example via portproxy + firewall rules)
- OpenClaw browser profile in WSL2 points to that reachable CDP endpoint
- Control UI is opened from Windows using localhost:
  - `http://127.0.0.1:18789/`

## Why this setup is confusing

Several failures can overlap and look like one issue:

- remote CDP is not reachable from WSL2
- Control UI is opened from an insecure origin
- `allowedOrigins` is incomplete
- token/pairing/auth is not configured correctly
- browser profile points to the wrong CDP endpoint

Because of that, fixing one layer can still leave visible errors from another layer.

## Critical rule

Open the Control UI from Windows localhost, not from the LAN IP.

Use:

`http://127.0.0.1:18789/`

Do not use the LAN IP for the Control UI unless the deployment is explicitly configured for a secure context (HTTPS with valid origin handling).

## Validate in layers (in order)

### Layer 1: Remote CDP reachability from WSL2

From WSL2, verify that the Windows Chrome CDP endpoint is reachable:

```bash
curl http://WINDOWS_LAN_IP:9222/json/version
curl http://WINDOWS_LAN_IP:9222/json/list
```

If this fails, OpenClaw cannot use the remote browser profile regardless of other settings.

### Layer 2: Control UI secure origin + token/pairing

- Open Control UI from Windows localhost (`127.0.0.1`)
- Configure token/pairing correctly
- Ensure `gateway.controlUi.allowedOrigins` includes the localhost Control UI origin

### Layer 3: Browser profile configuration

Point the profile to the CDP endpoint that is actually reachable from WSL2:

```json
{
  "browser": {
    "defaultProfile": "remote",
    "profiles": {
      "remote": {
        "cdpUrl": "http://WINDOWS_LAN_IP:9222",
        "attachOnly": true,
        "color": "#00AA00"
      }
    }
  }
}
```

### Layer 4: End-to-end browser control

Validate tab creation/listing through OpenClaw:

```bash
openclaw browser open https://example.com --browser-profile remote
openclaw browser tabs --browser-profile remote
```

If tabs appear in Windows Chrome and in `openclaw browser tabs`, the setup is working end-to-end.

## Common misleading errors

These may appear in sequence even when one layer is already fixed:

- `control-ui-insecure-auth`
- `token_missing`
- `pairing required`
- `Remote CDP for profile "remote" is not reachable`
- `gateway timeout after 1500ms`

Treat each error as a layer-specific signal, not as proof that the whole setup is broken.

## Practical takeaway

The environment can be fully functional. The main issue is usually not missing capability, but overlapping diagnostics that make different failure layers look the same and increase setup/debug time.
