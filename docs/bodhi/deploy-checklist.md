# bodhi1 Deployment Checklist

Run this before activating any cron jobs or going live with the bot.

## 1. Python packages

```bash
# Install bodhi_vault and its dependencies (jsonschema + httpx)
cd ~/openbodhi
pip install -e packages/bodhi_vault

# Verify httpx is present (siyuan_sync requires it)
python3 -c "import httpx; print('httpx', httpx.__version__)"

# Optional: install bodhi_viz
pip install -e packages/bodhi_viz
```

## 2. Run the test suite

```bash
cd ~/openbodhi
python3 -m pytest packages/bodhi_vault/tests -q
# Expected: ~90+ tests passing, 0 failures
```

## 3. Environment variables

Required in `~/.openclaw/.env` (or exported in shell):

```bash
TELEGRAM_BOT_TOKEN=         # From BotFather
ANTHROPIC_API_KEY=          # From console.anthropic.com
BODHI_TELEGRAM_USER_ID=     # Your Telegram numeric user ID

# Optional (SiYuan sync — silent no-op if unset)
SIYUAN_API_TOKEN=           # From si.qenjin.io Settings → API
SIYUAN_API_URL=https://si.qenjin.io

# Optional (Obsidian sync)
# OBSIDIAN_VAULT_PATH=/path/to/your/obsidian/vault

# CRM / Qenjin (set when Qenjin agent is active)
TWENTY_API_KEY=             # From crm.huda20.fun Settings
```

Permissions:
```bash
chmod 600 ~/.openclaw/.env
chmod 700 ~/.openclaw
```

## 4. Vault directory

```bash
mkdir -p ~/openbodhi/vault/nodes
mkdir -p ~/openbodhi/vault/edges
chmod 700 ~/openbodhi/vault
```

## 5. systemd services (auto-start on boot)

```bash
# Copy units
sudo cp ~/openbodhi/docs/bodhi/systemd/openclaw.service /etc/systemd/system/
sudo cp ~/openbodhi/docs/bodhi/systemd/bodhi-viz.service /etc/systemd/system/

# Build OpenClaw first
cd ~/openbodhi && npm run build

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable openclaw bodhi-viz
sudo systemctl start openclaw bodhi-viz

# Verify
sudo systemctl status openclaw
sudo systemctl status bodhi-viz
```

## 6. Make scripts executable

```bash
chmod +x ~/openbodhi/docs/bodhi/scripts/*.sh
```

## 7. Viz server UFW rule

```bash
sudo ufw allow in on tailscale0 to any port 8085
```

## 8. Trader state directories

```bash
mkdir -p ~/.openclaw/trader/{strategies,backtests,paper-trades,wallets,signals,profiles,dashboard}
```

## 9. Quick smoke test

```bash
# Test vault write
cd ~/openbodhi && python3 -m bodhi_vault.write_cli \
  "deploy test — system is live" \
  --type Idea --energy 4 --source telegram \
  --tags deploy,test --domain wellness \
  --vault ~/openbodhi/vault \
  --schema ~/openbodhi/vault/schema/nodes.json

# Should output: node_id:YYYY-MM/xxxx...

# Test viz export
python3 -m bodhi_viz.export --vault ~/openbodhi/vault

# Test nudge engine
python3 -c "
import sys
sys.path.insert(0, 'packages/bodhi_vault/src')
from pathlib import Path
from bodhi_vault.nudge_scheduler import nudge_status
print(nudge_status(vault_path=Path.home() / 'openbodhi/vault'))
"
```

## 10. First cron activation

After deploying, the cron schedule starts with:
- `0 6 * * *` — distiller-daily (6am UTC)
- `7 8 * * *` — morning-checkin (8:07am UTC)

Test one manually:
```bash
# In the OpenClaw CLI or Telegram
/distiller
```

## Known limits

- `maxConcurrentRuns: 1` — tailscale-check (every 15m) and health-ping (every 30m) queue if overlapping. Both are fast (~1-2s) so in practice no issue.
- Ollama integration (`enrich.py expand_content`) is Phase 1 stub. The enricher skill works with concept-matching only until Ollama models are confirmed loaded.
