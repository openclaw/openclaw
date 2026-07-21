# Mythos Quick Start Guide

Get up and running with Mythos-class OpenClaw in 10 minutes.

## Prerequisites

- Node.js 22+ installed
- Rust toolchain installed
- Git installed

## Installation

```bash
# 1. Clone repository
git clone https://github.com/openclaw/openclaw.git
cd openclaw
git checkout arena/019f8084-openclaw

# 2. Install dependencies
pnpm install

# 3. Build Rust engines
pnpm build:rust:release

# 4. Build TypeScript
pnpm build

# 5. Copy environment file
cp .env.example .env
```

## Configuration

Edit `.env` and add your API keys:

```bash
# Required: At least one LLM provider
ANTHROPIC_API_KEY=sk-ant-...
# or
OPENAI_API_KEY=sk-...
# or
GEMINI_API_KEY=AIza...

# Gateway token (generate with: openssl rand -hex 32)
OPENCLAW_GATEWAY_TOKEN=your-secure-token-here

# Optional: Channel integrations
TELEGRAM_BOT_TOKEN=...
DISCORD_BOT_TOKEN=...
SLACK_BOT_TOKEN=...
```

## Start Gateway

```bash
# Start in development mode
pnpm gateway:watch

# Or start in production mode
node dist/index.js gateway
```

## Verify Installation

```bash
# Check health
openclaw doctor --deep

# Expected output:
# ✅ Gateway: running
# ✅ mythos-vector-engine: loaded (HNSW)
# ✅ mythos-search-engine: loaded (BM25)
# ✅ mythos-protocol-codec: loaded (simd-json)
```

## Access Control UI

Open http://localhost:18789 in your browser.

## Deploy Fleet Agents

Fleet agents are pre-configured in `mythos-workspace/fleet/`:

```bash
# Check agent workspaces
ls mythos-workspace/fleet/
# PRIME, RESEARCH, CODE, OPS, MEMORY, CRITIC

# Agents are automatically loaded by gateway
openclaw agents list
```

## Run First Workflow

```bash
# Register production workflows
bash scripts/mythos/register-crons.sh

# Manually trigger daily brief
openclaw cron run "Mythos Daily Brief"

# View workflow logs
openclaw logs --filter "workflow"
```

## Next Steps

1. **Connect Channels**: Set up Telegram/Discord/Slack in `.env`
2. **Customize Agents**: Edit `mythos-workspace/fleet/*/SOUL.md`
3. **Configure GitHub**: Add `GITHUB_TOKEN` for automated triage
4. **Monitor Performance**: Run `openclaw doctor --deep` daily
5. **Scale Up**: Deploy with Docker or Kubernetes

## Docker Deployment

```bash
# Build Docker image
cd deploy/mythos
docker compose up -d

# Check logs
docker compose logs -f mythos-gateway

# Verify
docker compose exec mythos-gateway openclaw doctor --deep
```

## Kubernetes Deployment

```bash
# Set environment variables
export OPENCLAW_GATEWAY_TOKEN=...
export ANTHROPIC_API_KEY=...
# ... other secrets

# Deploy
bash deploy/k8s/deploy.sh

# Check status
kubectl get pods -n mythos
```

## Performance Benchmarks

Run benchmarks to verify Rust engines:

```bash
# Run benchmark suite
node scripts/mythos/operator-runbook.js benchmark

# Expected results:
# Vector search: 100x faster than sqlite-vec
# Text search: 10x faster than FTS5
# JSON parsing: 5x faster than JSON.parse
```

## Troubleshooting

### Gateway won't start

```bash
# Check logs
openclaw logs

# Verify config
openclaw config validate

# Reset if needed
openclaw config reset
```

### Native engines not loading

```bash
# Rebuild Rust engines
pnpm build:rust:release

# Check dependencies
ldd crates/target/release/*.so  # Linux
otool -L crates/target/release/*.dylib  # macOS
```

### Memory search slow

```bash
# Rebuild memory index
openclaw memory rebuild

# Check engine status
openclaw memory status
```

## Resources

- **Documentation**: `MYTHOS-CLASS-ARCHITECTURE-SPEC.md`
- **Migration Guide**: `MYTHOS-MIGRATION-GUIDE.md`
- **Benchmark Results**: `MYTHOS-BENCHMARK-RESULTS.md`
- **Operator Runbook**: `scripts/mythos/operator-runbook.js`

## Support

- **GitHub Issues**: https://github.com/openclaw/openclaw/issues
- **Discord**: https://discord.gg/openclaw
- **Documentation**: https://docs.openclaw.ai/

---

🦞 Welcome to Mythos-class! The lobster has titanium claws.
