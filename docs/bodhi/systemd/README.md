# systemd Units for bodhi1

Two services: `openclaw` (Telegram bot) and `bodhi-viz` (graph server).
Both run as the `bodhi` user, restart automatically on crash, and start at boot after Tailscale.

## Deploy (one-time, run on bodhi1)

```bash
# Copy units
sudo cp ~/openbodhi/docs/bodhi/systemd/openclaw.service /etc/systemd/system/
sudo cp ~/openbodhi/docs/bodhi/systemd/bodhi-viz.service /etc/systemd/system/

# Reload and enable
sudo systemctl daemon-reload
sudo systemctl enable openclaw bodhi-viz
sudo systemctl start openclaw bodhi-viz

# Verify
sudo systemctl status openclaw
sudo systemctl status bodhi-viz
```

## Logs

```bash
journalctl -u openclaw -f          # follow openclaw logs
journalctl -u bodhi-viz -f         # follow viz logs
journalctl -u openclaw --since "1 hour ago"
```

## Restart / Stop

```bash
sudo systemctl restart openclaw    # picks up config changes
sudo systemctl stop bodhi-viz      # temporary stop
```

## After openclaw.json changes

```bash
sudo systemctl restart openclaw
```

## Prerequisites

- OpenClaw must be built: `cd ~/openbodhi && npm run build` → produces `dist/index.js`
- `.env` must exist at `~/.openclaw/.env` with `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY`
- bodhi_viz installed: `cd ~/openbodhi && pip install -e packages/bodhi_viz`
- `PYTHONPATH` in the service unit covers `bodhi_vault` and `bodhi_viz` packages

## Notes

- `ProtectSystem=strict` + `ReadWritePaths` restricts writes to vault and state dirs only
- `MemoryMax=1G` on openclaw prevents runaway memory (Node + large context windows)
- `RestartSec=10` gives 10s gap to avoid rapid restart loops on persistent errors
- Tailscale service (`tailscaled`) is a soft dependency — both services still start if Tailscale is down
