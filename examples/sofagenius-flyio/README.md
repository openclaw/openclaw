# SofaGenius + OpenClaw on Fly.io

Run [SofaGenius](https://github.com/lilyzhng/SofaGenius) as a proactive ML training
assistant inside [OpenClaw](https://github.com/openclaw/openclaw), deployed on Fly.io.

## What this gives you

- **Proactive monitoring**: OpenClaw cron checks your W&B training runs and alerts you
  on Discord/WhatsApp/Slack when anomalies are detected (loss spikes, NaN, plateau, etc.)
- **Messaging access**: Interact with your ML pipeline from any messaging channel —
  check training status, launch jobs, search datasets from your phone
- **SofaGenius stays intact**: All ML logic lives in the SofaGenius backend.
  OpenClaw skills are thin API wrappers. Update SofaGenius independently.
- **Post-training suggestions**: After a job completes, the agent proactively suggests
  eval runs, model uploads, or hyperparameter tweaks

## Architecture

```
Your phone/laptop
    │
    ├── Discord/WhatsApp/Slack/Web
    │       │
    │       ▼
    │   OpenClaw Gateway (port 3000)  ← HTTPS via Fly.io
    │       │
    │       ├── Cron scheduler (proactive checks)
    │       ├── Skills (thin API bridges)
    │       │       │
    │       │       ▼
    │       │   SofaGenius Backend (port 8000)  ← internal only
    │       │       │
    │       │       ├── W&B API
    │       │       ├── HuggingFace API
    │       │       └── Modal API (→ A100 GPUs)
    │       │
    │       └── SofaGenius React UI (optional, port-forward)
    │
    └── fly ssh console (direct access)
```

## Prerequisites

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) installed
- Fly.io account
- API keys: Anthropic, HuggingFace, W&B, Modal

## Quick start

```bash
# 1. Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# 2. Create Fly app + volume
fly apps create my-openclaw-ml
fly volumes create openclaw_data --size 2 --region iad

# 3. Set secrets
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
fly secrets set HF_TOKEN=hf_...
fly secrets set WANDB_API_KEY=...
fly secrets set MODAL_TOKEN_ID=...
fly secrets set MODAL_TOKEN_SECRET=...

# 4. Deploy (uses the custom Dockerfile in this directory)
fly deploy -c examples/sofagenius-flyio/fly.toml

# 5. Open the Control UI
fly open
```

Paste the gateway token when prompted.

## After deployment

### Verify both services are running

```bash
fly ssh console

# Check OpenClaw
openclaw status

# Check SofaGenius
curl -s http://127.0.0.1:8000/ | head -5

# Check ML packages
python3 -c "import wandb, huggingface_hub, modal; print('All ML packages OK')"
```

### Copy skills to the workspace

```bash
fly ssh console

# Copy the bridge skills into OpenClaw's workspace
mkdir -p /data/workspace/skills
cp -r /app/examples/sofagenius-flyio/skills/* /data/workspace/skills/
```

### Connect a messaging channel

```bash
fly ssh console

# Discord
openclaw channels add --channel discord --token "YOUR_BOT_TOKEN"

# Telegram
openclaw channels add --channel telegram --token "YOUR_BOT_TOKEN"

# WhatsApp (scan QR)
openclaw channels login
```

### Set up proactive monitoring

Message the agent through any connected channel:

```
Set up a cron job to check my active W&B training runs every 10 minutes.
Alert me here if you detect any anomalies (loss spikes, NaN, plateau,
divergence, overfitting). Also check for recently completed jobs and
suggest next steps.
```

The agent will use the `sofagenius-training` and `sofagenius-launch` skills
with OpenClaw's cron tool to poll periodically.

## Updating SofaGenius

SofaGenius is cloned at build time from GitHub. To update:

```bash
# Rebuild with latest SofaGenius
fly deploy -c examples/sofagenius-flyio/fly.toml
```

Or for quick updates without a full rebuild:

```bash
fly ssh console
cd /opt/sofagenius
git pull
# Restart the SofaGenius process (supervisor manages it)
supervisorctl restart sofagenius-backend
```

## Accessing the SofaGenius React UI

The SofaGenius frontend is not deployed by default (saves resources).
To use it, port-forward from your laptop:

```bash
fly proxy 8000:8000
# Then visit http://localhost:8000
```

Or for the full React dev server, SSH in and run:

```bash
fly ssh console
cd /opt/sofagenius/frontend
npm install && npm run dev -- --host 0.0.0.0
```

## Cost

- Fly.io VM (`shared-cpu-2x`, 4GB RAM): ~$20-25/month
- Modal GPU compute: pay-per-second (varies by usage)
- API costs: Anthropic, HuggingFace (mostly free), W&B (free tier)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| SofaGenius not responding | `fly ssh console` then `supervisorctl status` |
| Skills not loading | Copy skills to `/data/workspace/skills/` and restart gateway |
| API keys not available | Check `fly secrets list` — all keys should be set |
| OOM errors | Upgrade VM memory in `fly.toml` (try `4096mb` or `8192mb`) |
| Modal auth failing | `fly ssh console` then `modal token set --token-id ... --token-secret ...` |

## Files in this example

```
examples/sofagenius-flyio/
├── Dockerfile          # Builds OpenClaw + SofaGenius + Python ML stack
├── fly.toml            # Fly.io deployment config
├── supervisord.conf    # Runs both services (OpenClaw + SofaGenius)
├── openclaw.json       # OpenClaw config (sandbox off, skills loaded)
├── README.md           # This file
└── skills/
    ├── sofagenius-training/   # W&B monitoring + anomaly detection bridge
    │   ├── SKILL.md
    │   └── scripts/bridge.py
    ├── sofagenius-data/       # Dataset search + SQL + format detection bridge
    │   ├── SKILL.md
    │   └── scripts/bridge.py
    ├── sofagenius-launch/     # Modal job launching + cost estimation bridge
    │   ├── SKILL.md
    │   └── scripts/bridge.py
    └── sofagenius-scout/      # HF repo search + recommendations bridge
        ├── SKILL.md
        └── scripts/bridge.py
```
