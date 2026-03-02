# SofaGenius + OpenClaw on Fly.io

Run [SofaGenius](https://github.com/lilyzhng/SofaGenius) as a proactive ML training
assistant inside [OpenClaw](https://github.com/openclaw/openclaw), deployed on Fly.io.

## What this gives you

- **Proactive monitoring**: OpenClaw cron checks your W&B training runs and alerts you
  on Discord/WhatsApp/Slack when anomalies are detected (loss spikes, NaN, plateau, etc.)
- **Messaging access**: Interact with your ML pipeline from any messaging channel —
  check training status, launch jobs, search datasets from your phone
- **Bidirectional learning**: OpenClaw captures execution telemetry, user corrections,
  and learned patterns — then syncs them back to SofaGenius so it evolves over time
- **Teach and evolve**: Guide the agent through corrections and new workflows;
  SofaGenius absorbs this knowledge and produces better skills
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
    │       │
    │       ├── Skills (SofaGenius sub-agent bridges)
    │       │   ├── 📊 training  → SofaGenius Training Agent (W&B monitor)
    │       │   ├── 🚀 launch    → SofaGenius Launch Agent (Modal jobs)
    │       │   ├── 🗄️ data      → SofaGenius Data Agent (datasets)
    │       │   ├── 🔍 scout     → SofaGenius Scout Agent (HF search)
    │       │   ├── 🔄 feedback  → Feedback sync (OpenClaw → SofaGenius)
    │       │   └── 🧠 teach     → Skill evolution (user guidance)
    │       │           │
    │       │           ▼
    │       │   SofaGenius Backend (port 8000)  ← internal only
    │       │       │
    │       │       ├── W&B API
    │       │       ├── HuggingFace API
    │       │       └── Modal API (→ A100 GPUs)
    │       │
    │       └── Feedback Store (/data/feedback/)
    │               │
    │               ├── executions.jsonl   ← auto-captured from every skill call
    │               ├── corrections.jsonl  ← user corrections ("use lr=1e-5 not 3e-4")
    │               ├── patterns.jsonl     ← learned recurring patterns
    │               └── skill-drafts.jsonl ← user-taught workflows
    │
    └── fly ssh console (direct access)
```

### Bidirectional feedback loop

The key insight: OpenClaw is not just an executor — it's an observer that captures
operational experience. SofaGenius is not just a skill provider — it's a learner
that absorbs that experience and evolves.

```
          ┌──────────────────────────────────────────────┐
          │            The Learning Loop                  │
          │                                              │
          │  1. SofaGenius provides ML skills            │
          │         ↓                                    │
          │  2. OpenClaw executes + observes             │
          │         ↓                                    │
          │  3. User corrects + teaches                  │
          │         ↓                                    │
          │  4. Feedback store captures everything       │
          │         ↓                                    │
          │  5. Sync pushes to SofaGenius                │
          │         ↓                                    │
          │  6. SofaGenius evolves (better defaults,     │
          │     new detectors, smarter configs)          │
          │         ↓                                    │
          │  7. Updated skills flow back to OpenClaw     │
          │         ↓                                    │
          │  8. Goto 2 (each cycle gets smarter)         │
          └──────────────────────────────────────────────┘
```

### How SofaGenius sub-agents map to OpenClaw skills

SofaGenius has multiple specialized sub-agents, each with their own tools.
OpenClaw maps each sub-agent to an OpenClaw skill via a thin bridge script:

| SofaGenius Sub-Agent | OpenClaw Skill | Tools/Actions | Role |
|---------------------|----------------|---------------|------|
| Training Agent | `sofagenius-training` | status, anomalies, compare, check-active | W&B monitoring + anomaly detection |
| Launch Agent | `sofagenius-launch` | propose, modify, run, status, check-completed | Modal job lifecycle |
| Data Agent | `sofagenius-data` | search, sql, format, stats | Dataset inspection |
| Scout Agent | `sofagenius-scout` | search, recommend, draft-post | HF discovery |
| — | `sofagenius-feedback` | log-correction, log-pattern, sync, pull | Feedback loop (new) |
| — | `sofagenius-teach` | teach-workflow, refine-skill, list-lessons | Skill evolution (new) |

OpenClaw acts as the **orchestrator**: it decides which sub-agent to invoke based
on the user's message, coordinates multi-step workflows across sub-agents, and
captures the operational experience that feeds back into SofaGenius.

### Example: end-to-end workflow with feedback

```
User: "New dataset uploaded: lilyzhng/instruct-v3. Inspect it and launch a
       fine-tuning job if it looks good."

OpenClaw orchestrates:
  1. data-stats → SofaGenius Data Agent → "12k rows, ChatML format, 890 avg tokens"
  2. data-format → confirms ChatML ✓
  3. launch-propose → SofaGenius Launch Agent → config with lr=3e-4

User: "Use lr=1e-5, I always use that for instruction tuning"

OpenClaw:
  4. feedback: log-correction (captures the lr preference)
  5. launch-modify → changes lr to 1e-5
  6. launch-run → kicks off Modal job in overfit mode

  ... later (via cron) ...
  7. training-check-active → detects healthy training ✓
  8. launch-check-completed → "Job done! Final loss 0.31. Suggest: eval run"

  ... on next sync ...
  9. feedback: sync-to-sofagenius → SofaGenius learns "lr=1e-5 for instruct tuning"
  10. Next time launch-propose is called → SofaGenius defaults to lr=1e-5
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

### Set up feedback sync

Message the agent:

```
Set up a cron job to sync my execution feedback to SofaGenius every hour.
This way SofaGenius learns from my corrections and patterns over time.
```

To see what the system has learned so far:

```
Show me what you've learned from our interactions. List all corrections,
patterns, and workflows I've taught you.
```

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
| Feedback not syncing | Check `/data/feedback/` exists; run `feedback-stats` to verify |

## Files in this example

```
examples/sofagenius-flyio/
├── Dockerfile          # Builds OpenClaw + SofaGenius + Python ML stack
├── fly.toml            # Fly.io deployment config
├── supervisord.conf    # Runs both services (OpenClaw + SofaGenius)
├── openclaw.json       # OpenClaw config (sandbox off, skills loaded)
├── README.md           # This file
├── FEEDBACK_API.md     # API contract for SofaGenius feedback endpoints
└── skills/
    ├── shared/                    # Shared utilities
    │   └── feedback_store.py      # Local JSONL feedback store
    ├── sofagenius-training/       # W&B monitoring + anomaly detection bridge
    │   ├── SKILL.md
    │   └── scripts/bridge.py
    ├── sofagenius-data/           # Dataset search + SQL + format detection bridge
    │   ├── SKILL.md
    │   └── scripts/bridge.py
    ├── sofagenius-launch/         # Modal job launching + cost estimation bridge
    │   ├── SKILL.md
    │   └── scripts/bridge.py
    ├── sofagenius-scout/          # HF repo search + recommendations bridge
    │   ├── SKILL.md
    │   └── scripts/bridge.py
    ├── sofagenius-feedback/       # Feedback sync (OpenClaw → SofaGenius)
    │   ├── SKILL.md
    │   └── scripts/bridge.py
    └── sofagenius-teach/          # Skill evolution (user guidance → SofaGenius)
        ├── SKILL.md
        └── scripts/bridge.py
```
