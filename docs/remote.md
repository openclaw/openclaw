---
summary: "Remote mode topology using SSH control channels between gateway and mac app"
read_when:
  - Running or troubleshooting remote gateway setups
---
# Remote access (SSH, tunnels, and tailnets)

This repo supports “remote over SSH” by keeping a single Gateway (the master) running on a host (e.g., your Mac Studio) and connecting clients to it.

- For **operators (you / the macOS app)**: SSH tunneling is the universal fallback.
- For **nodes (Iris/iOS and future devices)**: prefer the Gateway **Bridge** when on the same LAN/tailnet (see `docs/discovery.md`).

## The core idea

- The Gateway WebSocket binds to **loopback**: `ws://127.0.0.1:18789`.
- For remote use, you forward that loopback port over SSH (or use a tailnet/VPN and tunnel less).

## SSH tunnel (CLI + tools)

Create a local tunnel to the remote Gateway WS:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

With the tunnel up:
- `clawdis health` and `clawdis status --deep` now reach the remote gateway via `ws://127.0.0.1:18789`.
- `clawdis gateway {status,health,send,agent,call}` can also target the forwarded URL via `--url` when needed.

## WebChat over SSH

Forward both the WebChat HTTP port and the Gateway WS port:

```bash
ssh -N \
  -L 18788:127.0.0.1:18788 \
  -L 18789:127.0.0.1:18789 \
  user@host
```

Then open `http://127.0.0.1:18788/webchat/` locally. (Details: `docs/webchat.md`.)

## macOS app “Remote over SSH”

The macOS menu bar app can drive the same setup end-to-end (remote status checks, WebChat, and Voice Wake forwarding).

Runbook: `docs/mac/remote.md`.

## Legacy control channel

Older builds experimented with a newline-delimited TCP control channel on the same port.
That API is deprecated and should not be relied on. (Historical reference: `docs/control-api.md`.)
