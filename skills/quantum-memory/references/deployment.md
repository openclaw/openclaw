# Deployment Guide

## Quick Start (Single Agent)

```bash
pip install quantum-memory-graph[api]
python -m quantum_memory_graph.api
```

Server runs on `http://localhost:8000`.

## Multi-Agent Deployment

### ⚠️ Memory Isolation (IMPORTANT)

**Default: Isolated per agent.** Each agent's memories are namespaced by `agent_id`.

```python
# Agent A stores
store("Project uses React", agent_id="agent_a")

# Agent B cannot see Agent A's memories
recall("What framework?", agent_id="agent_b")  # Returns nothing
```

### Shared Memory (Opt-In Only)

For agents that SHOULD share memories (same user, same team, same trust boundary):

```python
# Both agents use same namespace
store("Shared knowledge", agent_id="shared_team")
recall("query", agent_id="shared_team")
```

**Never use shared memory for:**
- Different users
- Multi-tenant deployments
- Untrusted agent combinations

### Production Config

```bash
# Environment variables
QMG_ISOLATION=strict          # Enforce agent_id on all calls (recommended)
QMG_DEFAULT_AGENT=default     # Fallback agent_id if not provided
QMG_GRAPH_PATH=/data/qmg/     # Persistent storage path
```

## Systemd Service

```ini
[Unit]
Description=Quantum Memory Graph API
After=network.target

[Service]
Type=simple
User=qmg
Environment=QMG_ISOLATION=strict
ExecStart=/usr/local/bin/python -m quantum_memory_graph.api
Restart=always

[Install]
WantedBy=multi-user.target
```

## Health Check

```bash
curl http://localhost:8000/
# {"status": "ok", "version": "1.1.1"}
```
