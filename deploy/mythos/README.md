# Mythos-Class Deployment Guide

Production deployment guide for OpenClaw with Rust-accelerated Mythos engines.

## Quick Start

```bash
# 1. Clone repository
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# 2. Copy environment file
cp deploy/mythos/.env.example deploy/mythos/.env

# 3. Edit .env with your API keys and tokens
nano deploy/mythos/.env

# 4. Build and start
cd deploy/mythos
docker compose up -d

# 5. Check status
docker compose logs -f mythos-gateway
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Docker Compose Stack                                        │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  mythos-gateway                                      │    │
│  │  • OpenClaw Gateway + Rust Native Engines            │    │
│  │  • Port 18789 (Gateway)                              │    │
│  │  • Port 18793 (Canvas)                               │    │
│  │  • 4 CPU, 8GB RAM                                    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │ mythos-postgres  │  │  mythos-redis    │                │
│  │ (Advanced memory)│  │ (Cache/rate limit│                │
│  │ 2 CPU, 4GB RAM   │  │ 1 CPU, 1GB RAM   │                │
│  └──────────────────┘  └──────────────────┘                │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## Rust Native Engines

The Mythos deployment includes 6 Rust-accelerated engines:

| Engine | Purpose | Speed Gain |
|---|---|---|
| `mythos-vector-engine` | HNSW vector search | 100x faster |
| `mythos-search-engine` | BM25 text search | 10x faster |
| `mythos-embedding-runtime` | GPU embeddings | 50x faster |
| `mythos-execution-sandbox` | OS sandboxing | 100x less overhead |
| `mythos-protocol-codec` | JSON parsing | 5x faster |
| `mythos-causal-graph` | Causal memory | New capability |

Verify engines are loaded:

```bash
docker compose exec mythos-gateway openclaw doctor --deep
```

Expected output:

```
✅ mythos-vector-engine: loaded (HNSW)
✅ mythos-search-engine: loaded (BM25)
✅ mythos-embedding-runtime: loaded (GPU)
✅ mythos-execution-sandbox: loaded (seccomp)
✅ mythos-protocol-codec: loaded (simd-json)
✅ mythos-causal-graph: loaded (L7 memory)
```

## Fleet Agents

The Mythos deployment includes 6 specialized agents:

| Agent | Role | Model |
|---|---|---|
| **PRIME** 🏛️ | Orchestrator | Claude Opus |
| **RESEARCH** 🔍 | Intelligence | Gemini Flash |
| **CODE** 💻 | Software Engineer | Claude Opus |
| **OPS** ⚙️ | Infrastructure | Claude Sonnet |
| **MEMORY** 🧠 | Memory Manager | Claude Haiku |
| **CRITIC** 🔬 | Validator | Claude Opus |

Agent workspace: `/home/openclaw/mythos-workspace/fleet/`

## Security Policies

Each agent has a NemoClaw security policy:

```
mythos-workspace/nemoclaw/policies/
├── prime.yaml      # Orchestrator (delegation only)
├── research.yaml   # Web access, no execution
├── code.yaml       # Full execution in sandbox
├── ops.yaml        # Infrastructure access
├── memory.yaml     # Memory access, local-only
└── critic.yaml     # Read-only audit access
```

## Workflows

Pre-configured Lobster workflows:

```
mythos-workspace/workflows/
├── github-triage.lobster      # GitHub issue triage
├── daily-brief.lobster        # Daily intelligence briefing
├── incident-response.lobster  # Incident response
└── weekly-retro.lobster       # Weekly retrospective
```

## Volumes

| Volume | Purpose | Size |
|---|---|---|
| `openclaw-config` | Configuration | ~10 MB |
| `openclaw-memory` | Memory index | ~1 GB |
| `openclaw-sessions` | Session transcripts | ~5 GB |
| `openclaw-logs` | Logs | ~500 MB |
| `mythos-workspace` | Agent workspace | ~100 MB |
| `postgres-data` | PostgreSQL data | ~2 GB |
| `redis-data` | Redis data | ~512 MB |

## Monitoring

### Health Checks

```bash
# Gateway health
curl http://localhost:18789/health

# Detailed status
docker compose exec mythos-gateway openclaw status

# Memory status
docker compose exec mythos-gateway openclaw memory status

# Native engines
docker compose exec mythos-gateway openclaw doctor --deep
```

### Logs

```bash
# Gateway logs
docker compose logs -f mythos-gateway

# Last 100 lines
docker compose logs --tail=100 mythos-gateway

# Since specific time
docker compose logs --since=1h mythos-gateway
```

### Metrics

Enable OpenTelemetry:

```bash
# In .env
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
```

## Scaling

### Horizontal Scaling

```bash
# Scale gateway instances
docker compose up -d --scale mythos-gateway=3
```

Requires external load balancer and shared storage.

### Vertical Scaling

Edit resource limits in `docker-compose.yml`:

```yaml
deploy:
  resources:
    limits:
      cpus: '8.0'    # Increase CPU
      memory: 16G    # Increase memory
```

## Backup

```bash
# Backup all volumes
docker run --rm \
  -v mythos_openclaw-memory:/data/openclaw-memory:ro \
  -v mythos_openclaw-sessions:/data/openclaw-sessions:ro \
  -v mythos_mythos-workspace:/data/mythos-workspace:ro \
  -v $(pwd):/backup \
  alpine \
  tar czf /backup/mythos-backup-$(date +%Y%m%d).tar.gz /data

# Restore
docker run --rm \
  -v mythos_openclaw-memory:/data/openclaw-memory \
  -v $(pwd):/backup \
  alpine \
  tar xzf /backup/mythos-backup-YYYYMMDD.tar.gz -C /
```

## Troubleshooting

### Gateway won't start

```bash
# Check logs
docker compose logs mythos-gateway

# Check config
docker compose exec mythos-gateway openclaw config validate

# Reset config
docker compose exec mythos-gateway openclaw config reset
```

### Native engines not loading

```bash
# Check Rust build
docker compose logs mythos-gateway | grep "mythos"

# Rebuild
docker compose build --no-cache mythos-gateway
```

### Memory issues

```bash
# Check memory status
docker compose exec mythos-gateway openclaw memory status

# Rebuild index
docker compose exec mythos-gateway openclaw memory rebuild

# Check disk space
docker compose exec mythos-gateway df -h
```

### Performance issues

```bash
# Check resource usage
docker stats

# Check logs for errors
docker compose logs --tail=100 mythos-gateway | grep -i error

# Restart services
docker compose restart
```

## Production Checklist

- [ ] Set strong `OPENCLAW_GATEWAY_TOKEN`
- [ ] Configure all model provider API keys
- [ ] Set up channel tokens (Telegram, Discord, Slack)
- [ ] Configure GitHub token and webhook secret
- [ ] Set up PostgreSQL password
- [ ] Configure timezone
- [ ] Set up monitoring (OpenTelemetry)
- [ ] Configure backup schedule
- [ ] Set up log rotation
- [ ] Review security policies
- [ ] Test all agents
- [ ] Verify native engines loaded
- [ ] Test workflows
- [ ] Document runbook for your team

## Support

- Documentation: https://docs.openclaw.ai/
- GitHub: https://github.com/openclaw/openclaw
- Discord: https://discord.gg/openclaw

## License

MIT
