# Node Map

Exact roles and responsibilities of each cluster node.

---

## Cluster Overview

```
┌─────────────────────────────────┐
│  M4 Mac Mini — THE BRAIN        │
│  Gateway · Orchestrator · Triage│
│  Port 18789 / 8000 / 8001      │
└──────────────┬──────────────────┘
               │ local network
┌──────────────┴──────────────────┐
│  M1 Mac Studio — THE WORKHORSE  │
│  Ollama · Worker · Heavy Compute│
│  Port 11434 / 8002              │
└──────────────┬──────────────────┘
               │
┌──────────────┴──────────────────┐
│  i7 MacBook Pro — THE SENTINEL  │
│  Cron · Monitoring · Failover   │
│  Backup worker                  │
└─────────────────────────────────┘
```

---

## M4 Mac Mini

| Property | Value |
|----------|-------|
| Hostname | `claw-m4` |
| Role | Brain — primary orchestrator |
| IP | Assigned via DHCP / static |
| Key services | Gateway (18789), webhook-gateway (8000), orchestrator (8001) |

**Owns:**
- Agent routing and channel binding
- Intent classification (triage model)
- Plan execution coordination
- Approval management
- Cron job scheduling
- Webhook reception and verification

**Ollama:** Fallback only (uses smaller models if M1 is down)

---

## M1 Mac Studio

| Property | Value |
|----------|-------|
| Hostname | `claw-m1` |
| Role | Workhorse — heavy compute |
| IP | `10.0.0.145` (static) |
| Key services | Ollama (11434), worker (8002) |

**Owns:**
- Primary Ollama inference (all model sizes: 2b, 4b, 9b, 27b)
- Content generation tasks
- Research and analysis tasks
- Media processing and rendering
- Long-running job execution

**Critical:** If M1 goes down, inference falls back to M4 with smaller
models. Use `make failover` to switch.

---

## i7 MacBook Pro

| Property | Value |
|----------|-------|
| Hostname | `claw-i7` |
| Role | Sentinel — monitoring and backup |
| IP | Assigned via DHCP |
| Key services | Cron, monitoring, backup worker |

**Owns:**
- Scheduled healthchecks (every 15 min)
- Memory sync across nodes (every 30 min)
- Log rotation (weekly)
- Alerting when nodes go down
- Failover monitoring
- Backup task execution when primary nodes are overloaded

**Note:** The i7 is the last line of defense. If both M4 and M1 are
down, i7 switches to read-only mode and alerts DA.

---

## Network

All nodes communicate over the local network. No services are exposed
to the public internet unless explicitly configured behind a reverse proxy.

SSH is used for inter-node management (rsync, tmux sessions, service control).
