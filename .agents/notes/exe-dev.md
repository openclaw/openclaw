# exe.dev VM ops

Notes for running OpenClaw on exe.dev VMs. Loaded on demand; not in the default agent prompt.

## Access

- Stable path: `ssh exe.dev` then `ssh vm-name` (assume SSH key set).
- SSH flaky → use exe.dev web terminal or Shelley (web agent).
- Keep a tmux session for long ops.

## Update

- `sudo npm i -g openclaw@latest` (global install needs root on `/usr/lib/node_modules`).

## Config

- Use `openclaw config set ...`.
- Ensure `gateway.mode=local` is set.
- Discord: store raw token only (no `DISCORD_BOT_TOKEN=` prefix).

## Restart

```bash
pkill -9 -f openclaw-gateway || true
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

## Verify

- `openclaw channels status --probe`
- `ss -ltnp | rg 18789`
- `tail -n 120 /tmp/openclaw-gateway.log`
