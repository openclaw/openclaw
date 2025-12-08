# Remote mode with control channel

This repo supports “remote over SSH” by keeping a single relay (the master) running on a host (e.g., your Mac Studio) and connecting one or more macOS menu bar clients to it. The menu app no longer shells out to `pnpm clawdis …`; it talks to the relay over a persistent control channel that is tunneled through SSH.

## Topology
- Master: runs the relay + control server on `127.0.0.1:18789` (in-process TCP server).
- Clients: when “Remote over SSH” is selected, the app opens one SSH tunnel:
  - `ssh -N -L <localPort>:127.0.0.1:18789 <user>@<host>`
  - The app then connects to `localhost:<localPort>` and keeps that socket open.
- Messages are newline-delimited JSON (documented in `docs/control-api.md`).

## Connection flow (clients)
1) Establish SSH tunnel.
2) Open TCP socket to the local forwarded port.
3) Send `ping` to verify connectivity.
4) Issue `health` and `last-heartbeat` requests to seed UI.
5) Listen for `event` frames (heartbeat updates, relay status).

## Heartbeats
- Heartbeats always run on the master relay.
- The control server emits `event: "heartbeat"` after each heartbeat attempt and keeps the latest in memory for `last-heartbeat` requests.
- No file-based heartbeat logs/state are required when the control stream is available.

## Local mode
- The menu app skips SSH and connects directly to `127.0.0.1:18789` with the same protocol.

## Failure handling
- If the tunnel drops, the client reconnects and re-issues `ping`, `health`, and `last-heartbeat` to refresh state.
- If the control port is unavailable (older relay), the app can optionally fall back to the legacy CLI path, but the goal is to rely solely on the control channel.

## Security
- Control server listens only on localhost.
- SSH tunneling reuses existing keys/agent; no additional auth is added by the control server.

## Files to keep in sync
- Protocol definition: `docs/control-api.md`.
- App connection logic: macOS `Remote over SSH` plumbing.
- Relay control server: lives inside the Node relay process.
