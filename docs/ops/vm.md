# exe.dev VM Ops

## Access

```bash
ssh exe.dev
ssh vm-name   # from exe.dev
```

SSH is flaky: use exe.dev web terminal or Shelley (web agent) as fallback. Keep a tmux session for long ops.

## Update OpenClaw

```bash
sudo npm i -g openclaw@latest   # global install needs root
```

## Config

```bash
openclaw config set ...
# Ensure gateway.mode=local is set
# Discord: store raw token only (no DISCORD_BOT_TOKEN= prefix)
```

## Restart Gateway

```bash
pkill -9 -f openclaw-gateway || true
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

## Verify

```bash
openclaw channels status --probe
ss -ltnp | rg 18789
tail -n 120 /tmp/openclaw-gateway.log
```

## macOS Gateway

Gateway runs only as the menubar app — no separate LaunchAgent. Start/stop via the OpenClaw Mac app or `scripts/restart-mac.sh`.

To verify/kill: `launchctl print gui/$UID | grep openclaw` (do not assume a fixed label).

**Do not rebuild the macOS app over SSH.** Rebuilds must run directly on the Mac.

## macOS Logs

```bash
./scripts/clawlog.sh   # Unified logs for OpenClaw subsystem; supports follow/tail/category filters
# Expects passwordless sudo for /usr/bin/log
```

## Signal (Flawd Bot)

Update:

```bash
fly ssh console -a flawd-bot -C "bash -lc 'cd /data/clawd/openclaw && git pull --rebase origin main'"
fly machines restart e825232f34d058 -a flawd-bot
```
