# Remote Clawdis (macOS ⇄ remote host)

Updated: 2025-12-08

This flow lets the macOS app act as a full remote control for a Clawdis relay running on another host (e.g. a Mac Studio). All features—health checks, permissions bootstrapping via the helper CLI, Voice Wake forwarding, and Web Chat—reuse the same remote SSH configuration from *Settings → General*.

## Modes
- **Local (this Mac)**: Everything runs on the laptop. No SSH involved.
- **Remote over SSH**: Clawdis commands are executed on the remote host. The mac app opens an SSH connection with `-o BatchMode` plus your chosen identity/key.

## Prereqs on the remote host
1) Install Node + pnpm and build/install the Clawdis CLI (`pnpm install && pnpm build && pnpm link --global`).
2) Ensure `clawdis` is on PATH for non-interactive shells. If you prefer, symlink `clawdis-mac` too so TCC-capable actions can run remotely when needed.
3) Open SSH with key auth. We recommend **Tailscale** IPs for stable reachability off-LAN.

## macOS app setup
1) Open *Settings → General*.
2) Under **Clawdis runs**, pick **Remote over SSH** and set:
   - **SSH target**: `user@host` (optional `:port`).
   - **Identity file** (advanced): path to your key.
   - **Project root** (advanced): remote checkout path used for commands.
3) Hit **Test remote**. Success indicates the remote `clawdis status --json` runs correctly. Failures usually mean PATH/CLI issues; exit 127 means the CLI isn’t found remotely.
4) Health checks and Web Chat will now run through this SSH tunnel automatically.

## Web Chat over SSH
- The relay hosts a loopback-only HTTP server (default 18788, see `webchat.port`).
- The mac app forwards `127.0.0.1:<port>` over SSH (`ssh -L <ephemeral>:127.0.0.1:<port>`), then loads `/webchat/?session=<key>` in-app. Sends go in-process on the relay (no CLI spawn/PATH issues).
- Keep the feature enabled in *Settings → Config → Web chat*. Disable it to hide the menu entry entirely.

## Permissions
- The remote host needs the same TCC approvals as local (Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications). Run onboarding on that machine to grant them once.
- When remote commands need local TCC (e.g., screenshots on the remote Mac), ensure `clawdis-mac` is installed there so the helper can request/hold those permissions.

## WhatsApp login flow (remote)
- Run `clawdis login --verbose` **on the remote host**. Scan the QR with WhatsApp on your phone.
- Re-run login on that host if auth expires. Health check will surface link problems.

## Troubleshooting
- **exit 127 / not found**: `clawdis` isn’t on PATH for non-login shells. Add it to `/etc/paths`, your shell rc, or symlink into `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: check SSH reachability, PATH, and that Baileys is logged in (`clawdis status --json`).
- **Web Chat stuck**: confirm the relay is running on the remote host and `webchat.enabled` is true; ensure the forwarded port matches *Settings → Config*. Since RPC is in-process, PATH is no longer a factor.
- **Voice Wake**: trigger phrases are forwarded automatically in remote mode; no separate forwarder is needed.

## Notification sounds
Pick sounds per notification from scripts with the helper CLI, e.g.:

```bash
clawdis-mac notify --title "Ping" --body "Remote relay ready" --sound Glass
```

There is no global “default sound” toggle in the app anymore; callers choose a sound (or none) per request.
