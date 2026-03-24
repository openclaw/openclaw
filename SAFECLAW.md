# SafeClaw — The Safe Version of OpenClaw

Same agent. Same capabilities. With safety and accountability built in.

SafeClaw wraps [OpenClaw](https://github.com/openclaw/openclaw) with the [AEP safety proxy](https://github.com/aceteam-ai/aceteam-aep). Every LLM call gets cost tracking, PII detection, agent threat blocking, and a real-time dashboard. Zero code changes to OpenClaw.

## Why SafeClaw?

OpenClaw is powerful. It has 332K+ GitHub stars. But deploying it safely is the #1 concern holding back adoption:

- **Cost blowups.** A founder woke up to a $135K API bill. No visibility into what happened.
- **No safety enforcement.** Agents can leak PII, execute exploits, or take unauthorized actions.
- **Enterprise blockers.** CISOs won't approve agent deployment without accountability.

SafeClaw solves this by routing all LLM traffic through the AEP safety proxy. The proxy inspects every request and response, blocks threats before they reach the LLM, and produces receipts for every action.

## Quick Start

### Option 1: Docker (recommended)

```bash
git clone https://github.com/aceteam-ai/safeclaw.git
cd safeclaw
cp .env.example .env
# Add your OPENAI_API_KEY to .env

# Start with safety
docker compose -f docker-compose.yml -f docker-compose.safe.yml up
```

Dashboard: **http://localhost:8899/aep/**

### Option 2: Wrap any existing OpenClaw install

```bash
pip install aceteam-aep[all]
aceteam-aep wrap -- openclaw run "your task here"
```

### Option 3: Proxy mode (any install method)

```bash
pip install aceteam-aep[all]
aceteam-aep proxy --port 8899

# In OpenClaw settings, set the model provider base URL to:
# http://localhost:8899/v1
```

## What Gets Blocked?

| Threat                   | Example                                | AEP Action              |
| ------------------------ | -------------------------------------- | ----------------------- |
| **Port scanning**        | `socket.connect()` on localhost        | BLOCK (HTTP 400)        |
| **Subprocess execution** | `subprocess.run()` exploit payloads    | BLOCK                   |
| **Credential access**    | Reading `/etc/passwd` or `/etc/shadow` | BLOCK                   |
| **PII in responses**     | SSN, credit card numbers in LLM output | BLOCK                   |
| **Cost anomalies**       | 5x average cost spike                  | FLAG                    |
| **Normal calls**         | Regular agent tasks                    | PASS (receipt recorded) |

Blocked calls never reach the LLM. $0 cost. The agent receives an error, not the dangerous response.

## What You See on the Dashboard

Open **http://localhost:8899/aep/** while your agent runs:

- Real-time cost counter
- Safety status: green (PASS), yellow (FLAG), red (BLOCK)
- Every LLM call with model, tokens, duration
- Safety signals: PII detected, threats blocked, anomalies flagged
- Governance context (if using X-AEP-\* headers)

## How It Works

```
OpenClaw Agent → AEP Safety Proxy → LLM API (OpenAI, Anthropic, etc.)
                      ↓
              Dashboard + Receipts
```

The AEP proxy is a reverse proxy. It reads every request and response. Safe calls pass through with receipts. Dangerous calls are blocked before they reach the LLM.

## Tested With

- OpenClaw (this repo)
- NemoClaw (NVIDIA OpenShell sandboxes)
- NanoClaw
- Any OpenAI-compatible client

## Upstream

SafeClaw tracks [openclaw/openclaw](https://github.com/openclaw/openclaw) main branch. The only additions are the safety proxy configuration. To sync with upstream:

```bash
git fetch upstream
git merge upstream/main
```

## Links

- **AEP Package:** https://pypi.org/project/aceteam-aep/
- **AEP Source:** https://github.com/aceteam-ai/aceteam-aep
- **AEP Quickstart:** https://github.com/aceteam-ai/aep-quickstart
- **AceTeam:** https://aceteam.ai
