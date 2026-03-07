# Cluster Topology — Role Assignments

## Machine Roles

### M1 Mac Studio — Primary Inference + Heavy Worker

**This is the main local AI box.**

| Capability | Details |
|------------|---------|
| Ollama host | Primary inference endpoint (`http://10.0.0.145:11434`) |
| Models | `qwen3.5:9b` (workhorse), `qwen3.5:4b` (fast), `qwen3.5:27b` (escalation) |
| Workers | Queue workers for heavy jobs |
| Tasks | Complex reasoning, embeddings, retrieval, batch processing |

**Why M1 for inference:** Strongest all-around machine in the cluster for sustained
local AI work. Unified memory architecture handles large model contexts efficiently.

### M4 Mac mini — Gateway / Router / Orchestration

**This is the always-on coordinator.**

| Capability | Details |
|------------|---------|
| OpenClaw Gateway | WebSocket control plane on port 18789 |
| Channel integrations | Telegram, Discord, Slack bindings |
| Webhook Gateway | FastAPI on port 8000 (GHL, Stripe, etc.) |
| Cron jobs | Grant scans, digests, health checks |
| Approvals | Telegram approval routing |
| Ollama fallback | `qwen3.5:2b` for ultra-fast local triage |

**Why M4 as Gateway:** Ideal as the stable, efficient, always-on front door.
Low power consumption, high reliability.

### i7 MacBook Pro — Utility / Overflow / Admin

**This is not the main inference box.**

| Capability | Details |
|------------|---------|
| Backup worker | Overflow job processing |
| Testing/staging | Dev environment, QA |
| Browser automation | Puppeteer/Playwright jobs |
| Admin access | Failover control terminal |
| Background scripts | Low-priority batch jobs |

**Why i7 as utility:** Still useful for auxiliary work, but not anchored
to production inference. Compute-heavy UGC rendering when M1 is busy.

## Network Layout

```
Internet
    │
    │ HTTPS (no inbound ports)
    ▼
Cloudflare Edge (WAF + rate limiting + TLS)
    │
    │ Cloudflare Tunnel (outbound only)
    ▼
Home Network
    ├── VLAN 10: Trusted LAN (laptops, phones)
    ├── VLAN 30: Automation
    │   ├── M4 Mac mini    (10.0.0.10)  — Gateway + coordinator
    │   ├── i7 MacBook Pro (10.0.0.11)  — Utility worker
    │   └── M1 Mac Studio  (10.0.0.145) — Inference + heavy worker
    └── VLAN 40: IoT/Guest (untrusted)

Admin: Tailscale mesh (SSH keys only, ACLs per device)
```

## Port Map

| Port | Service | Node |
|------|---------|------|
| 18789 | OpenClaw Gateway (WebSocket) | M4 |
| 8000 | Webhook Gateway (FastAPI) | M4 |
| 8001 | Orchestrator | M4 |
| 8002 | Worker | M4, i7 |
| 8080 | Dev server | any |
| 11434 | Ollama | M1 (primary), M4 (fallback) |

## Data Flow

```
Telegram msg → M4:18789 (Gateway) → classify → bind agent
    │
    ├─ simple/FAQ → M4 local qwen3.5:2b → respond
    ├─ normal → M1:11434 qwen3.5:9b → respond
    ├─ content gen → M1:11434 qwen3.5:4b → respond
    ├─ complex → Claude API → respond
    └─ long-running → ~/cluster/jobs/ → worker picks up → result
```

## Failover Strategy

| Scenario | Action |
|----------|--------|
| M1 Ollama down | Gateway auto-routes to M4 Ollama (smaller models) |
| M4 Gateway down | Manual: start gateway on M1, update DNS/tunnel |
| i7 worker down | Jobs stale >5min → M4 worker claims them |
| All local models overloaded | Cloud escalation to Claude API |

See `scripts/failover.sh` for automated M1→M4 failover.
