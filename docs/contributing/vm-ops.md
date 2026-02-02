# exe.dev VM Operations

## Access
```bash
ssh exe.dev
ssh vm-name  # From exe.dev
```
Assume SSH key already set.

**If SSH flaky:** Use exe.dev web terminal or Shelley (web agent); keep a tmux session for long ops.

## Update DNA
```bash
sudo npm i -g dna@latest  # Global install needs root
```

## Config
```bash
dna config set ...
```
Ensure `gateway.mode=local` is set.

## Discord Token
Store raw token only (no `DISCORD_BOT_TOKEN=` prefix).

## Restart Gateway
```bash
pkill -9 -f dna-gateway || true
nohup dna gateway run --bind loopback --port 18789 --force > /tmp/dna-gateway.log 2>&1 &
```

## Verify
```bash
dna channels status --probe
ss -ltnp | rg 18789
tail -n 120 /tmp/dna-gateway.log
```

## Signal: Update Fly
```bash
fly ssh console -a flawd-bot -C "bash -lc 'cd /data/clawd/dna && git pull --rebase origin main'"
fly machines restart e825232f34d058 -a flawd-bot
```
