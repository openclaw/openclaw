---
name: aep-safety
description: "Safety and accountability for AI agents via AEP proxy. Use when: user wants to monitor agent costs, enforce safety policies, block PII/threats, or add accountability to agent workflows. Wraps any LLM call with cost tracking, safety enforcement (PASS/FLAG/BLOCK), and governance headers."
homepage: https://github.com/aceteam-ai/aceteam-aep
metadata: { "openclaw": { "requires": { "anyBins": ["pip", "uv", "pipx"] } } }
---

# AEP Safety — Agent Accountability & Enforcement

Add safety enforcement, cost tracking, and accountability to any agent workflow. Every LLM call gets a receipt. Dangerous calls get blocked before they reach the LLM.

## When to Use

Use this skill when:

- "Make my agent safe" or "add safety to my workflow"
- "Track how much my agent is spending"
- "Block PII from leaking in agent responses"
- "Monitor what my agent is doing"
- "Add accountability to my agents"
- "Set up a safety proxy"
- Setting up a new agent and wanting guardrails from the start

## When NOT to Use

- Model selection or performance tuning (use model-usage skill)
- Rate limiting at the API level (use provider settings)
- Network security or firewall rules (use system tools)

## Quick Start — Proxy Mode (zero code changes)

Start the AEP safety proxy. All LLM calls routed through it get safety enforcement.

### 1. Install

```bash
pip install aceteam-aep[all]
```

### 2. Start the proxy

```bash
aceteam-aep proxy --port 8899
```

Dashboard opens at http://localhost:8899/aep/

### 3. Route your agent through it

Set the environment variable before running your agent:

```bash
export OPENAI_BASE_URL=http://localhost:8899/v1
```

Or use the wrap command to do it automatically:

```bash
aceteam-aep wrap -- python my_agent.py
aceteam-aep wrap -- node my_bot.js
```

That's it. Every LLM call now gets:

- Cost tracking (per call, cumulative)
- Safety detection (PII, toxicity, agent threats)
- Enforcement (PASS / FLAG / BLOCK)
- Real-time dashboard

## What Gets Blocked

The proxy blocks dangerous requests BEFORE they reach the LLM:

| Threat                                    | Detection             | Action           |
| ----------------------------------------- | --------------------- | ---------------- |
| Port scanning (`socket.connect()`)        | Agent threat detector | BLOCK (HTTP 400) |
| Subprocess execution (`subprocess.run()`) | Agent threat detector | BLOCK            |
| Credential access (`/etc/passwd`)         | Agent threat detector | BLOCK            |
| PII in responses (SSN, credit cards)      | PII detector          | BLOCK            |
| Cost anomalies (5x average spike)         | Cost anomaly detector | FLAG             |

Blocked calls return HTTP 400 with a detailed error message. The agent receives an error, not the dangerous content. $0 cost for blocked calls.

## Enforcement Actions

Every call gets exactly one verdict:

- **PASS** — Safe. Receipt recorded. Response delivered.
- **FLAG** — Suspicious. Receipt recorded with warning. Response delivered.
- **BLOCK** — Dangerous. Request rejected. Response never generated. $0 cost.

## Dashboard

Open http://localhost:8899/aep/ while your agent runs:

```bash
# Check the dashboard state via API
curl http://localhost:8899/aep/api/state
```

Shows: cost counter, safety status, signal timeline, governance context.

## Governance Headers

Add organizational context to your calls:

```bash
export AEP_ENTITY="org:your-company"
export AEP_CLASSIFICATION="confidential"
export AEP_TRACE_ID="workflow-$(date +%s)"
```

Or via HTTP headers when using the proxy:

```bash
curl http://localhost:8899/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-AEP-Entity: org:acme-corp" \
  -H "X-AEP-Classification: confidential" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'
```

The proxy parses these headers, strips them before forwarding to the LLM provider, and includes them in the dashboard and audit trail.

## Docker Sidecar (containerized agents)

For agents running in containers, add AEP as a sidecar:

```yaml
services:
  aep-proxy:
    image: python:3.12-slim
    command: sh -c "pip install aceteam-aep[all] && python -c 'from aceteam_aep.proxy.app import create_proxy_app; import uvicorn; uvicorn.run(create_proxy_app(), host=\"0.0.0.0\", port=8899)'"
    ports: ["8899:8899"]
    environment:
      OPENAI_API_KEY: ${OPENAI_API_KEY}

  your-agent:
    image: your-agent:latest
    environment:
      OPENAI_BASE_URL: http://aep-proxy:8899/v1
    depends_on: [aep-proxy]
```

## Useful Commands

```bash
# Install
pip install aceteam-aep[all]

# Start proxy with dashboard
aceteam-aep proxy --port 8899

# Start proxy binding to all interfaces (Docker)
aceteam-aep proxy --port 8899 --host 0.0.0.0

# Wrap any command with safety
aceteam-aep wrap -- python my_agent.py
aceteam-aep wrap -- node my_bot.js

# Check proxy state
curl http://localhost:8899/aep/api/state

# Add custom detector
aceteam-aep proxy --detector mymodule:MyDetector
```

## Links

- PyPI: https://pypi.org/project/aceteam-aep/
- Source: https://github.com/aceteam-ai/aceteam-aep
- SafeClaw: https://github.com/aceteam-ai/safeclaw
