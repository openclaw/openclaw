# SafeClaw — Run OpenClaw Safely

> **OpenClaw is powerful. It has access to your email, your files, your credentials. SafeClaw puts it in a container where it can't touch any of that — and blocks dangerous actions before they execute.**

## The Problem

OpenClaw runs on your laptop with full access to everything you're logged into. The community knows this is a risk:

- **"How safe is it to install on my laptop?"** — The #1 question at every OpenClaw workshop.
- **"If you're logged into Gmail, it can send email to your entire contact list"** — Real scenario discussed by workshop organizers.
- **"A dependency had a vulnerability that gave access to whatever you're logged into"** — Actually happened.
- **"People are buying Mac Minis just to run it safely"** — $600 for hardware isolation.

SafeClaw solves this for $0.

## How It Works

```
Your laptop (safe)          Docker container (sandboxed)
┌─────────────────┐        ┌──────────────────────────────┐
│ Your files      │        │ OpenClaw Agent               │
│ Your email      │   ──── │ AEP Safety Proxy             │
│ Your bank       │  port  │   ↓ blocks threats           │
│ Your credentials│  8899  │   ↓ tracks cost              │
│ Everything else │  only  │   ↓ signs every verdict      │
└─────────────────┘        └──────────────────────────────┘
                                    ↓
                              LLM API (OpenAI, etc.)
```

The agent runs inside a Docker container. It **cannot** access your files, email, browser cookies, or credentials. The only thing exposed is port 8899 — the safety dashboard.

## Quick Start

```bash
# One command. No Node. No Python. Just Docker.
docker run -p 8899:8899 -e OPENAI_API_KEY=$OPENAI_API_KEY ghcr.io/aceteam-ai/aep-proxy
```

Dashboard: **http://localhost:8899/aep/**

That's it. Every LLM call is tracked. Every threat is blocked. Every verdict is signed.

## What Gets Blocked

| Threat                                     | What happens                      | Cost    |
| ------------------------------------------ | --------------------------------- | ------- |
| Agent tries to scan your ports             | **BLOCKED.** HTTP 400.            | $0      |
| Agent tries to run subprocess exploits     | **BLOCKED.** Never reaches LLM.   | $0      |
| Agent tries to read /etc/passwd            | **BLOCKED.**                      | $0      |
| Agent response contains SSN or credit card | **BLOCKED.** Agent never sees it. | $0      |
| Agent cost spikes 5x average               | **FLAGGED.** Alert raised.        | Tracked |
| Normal agent task                          | **PASS.** Receipt recorded.       | Tracked |

## Three Enforcement Actions

Every call gets exactly one verdict:

- **PASS** — Safe. Receipt recorded. Response delivered.
- **FLAG** — Suspicious. Alert raised. Response delivered with warning.
- **BLOCK** — Dangerous. Request rejected. $0 cost. Agent gets an error, not the dangerous response.

## Signed Verdicts (Cryptographic Proof)

Every verdict is Ed25519 signed and Merkle chained. Like a blockchain for agent safety.

```
V0 ──→ V1 ──→ V2 ──→ V3 ──→ ...
Each links to the previous. Change one, the chain breaks.
```

This answers: **"How do we know the safety checks actually ran?"**

```bash
# Generate signing keys
aceteam-aep keygen

# Run with signed verdicts
docker run -p 8899:8899 \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -v ./aep.key:/app/aep.key:ro \
  ghcr.io/aceteam-ai/aep-proxy \
  proxy --port 8899 --host 0.0.0.0 --sign-key /app/aep.key
```

## Your Rules, Your Agents

Every company defines what "safe" means:

```yaml
# Healthcare
detectors:
  hipaa_compliance: { action: block }
  pii: { action: block }
  medication_check: { action: flag }

# Finance
detectors:
  sox_compliance: { action: block }
  trading_auth: { action: block }

# Startup
detectors:
  pii: { action: flag }
  agent_threat: { action: block }
  cost_anomaly: { action: flag, multiplier: 10 }
```

One YAML file. Different industries, different rules, same enforcement engine.

## Dashboard

Open **http://localhost:8899/aep/** while your agent runs:

- Real-time cost counter
- PASS / FLAG / BLOCK badges per call
- Safety signals: PII, threats, anomalies
- Merkle chain: signed verdicts with chain height
- Governance context: entity, classification, trace ID

## Works With Everything

| Framework                             | How                       | Verified |
| ------------------------------------- | ------------------------- | -------- |
| OpenClaw                              | Docker compose overlay    | Yes      |
| NemoClaw (NVIDIA OpenShell)           | Gateway routing           | Yes      |
| NanoClaw, CrewAI, DeerFlow, LangChain | `OPENAI_BASE_URL` env var | Yes      |
| Claude Code, Codex, OpenCode          | Proxy or MCP skill        | Yes      |
| Any OpenAI-compatible client          | Point at proxy            | Yes      |

## Install Options

**Docker (recommended — sandboxed, no file access):**

```bash
docker run -p 8899:8899 -e OPENAI_API_KEY=$OPENAI_API_KEY ghcr.io/aceteam-ai/aep-proxy
```

**pip (developer mode — runs on host):**

```bash
pip install aceteam-aep[all]
aceteam-aep proxy --port 8899
```

**Wrap any script:**

```bash
pip install aceteam-aep[all]
aceteam-aep wrap -- python my_agent.py
```

## Links

|                 |                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **Workshop**    | [SafeClaw Bootcamp](https://github.com/aceteam-ai/aep-quickstart/blob/main/workshop/bootcamp.html) |
| **AEP Package** | [pypi.org/project/aceteam-aep](https://pypi.org/project/aceteam-aep/)                              |
| **AEP Source**  | [github.com/aceteam-ai/aceteam-aep](https://github.com/aceteam-ai/aceteam-aep)                     |
| **Examples**    | [github.com/aceteam-ai/aep-quickstart](https://github.com/aceteam-ai/aep-quickstart)               |
| **AceTeam**     | [aceteam.ai](https://aceteam.ai)                                                                   |
| **Contact**     | jason@aceteam.ai                                                                                   |

---

_OpenClaw gives agents power. SafeClaw makes them accountable._
