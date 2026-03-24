# SafeClaw — The Safe Version of OpenClaw

> **This is a fork of [OpenClaw](https://github.com/openclaw/openclaw) (332K+ stars) with safety and accountability built in.** Everything OpenClaw does, SafeClaw does — with every LLM call tracked, every threat blocked, and every action receipted. See the [original OpenClaw README](OPENCLAW-README.md) for full OpenClaw documentation.

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

## Four Pillars of Accountability

| Pillar                 | How SafeClaw Enables It                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| **Cost Tracking**      | AEP proxy counts tokens per call, per model. Dashboard shows cumulative spend.                    |
| **Safety Enforcement** | PASS/FLAG/BLOCK on every call. PII, toxicity, agent threats blocked before reaching the LLM.      |
| **Provenance**         | Set `AEP_TRACE_ID` to correlate calls across agent workflows. Citation chains track data sources. |
| **Governance**         | Set `AEP_ENTITY` and `AEP_CLASSIFICATION` to tag calls with org identity and data sensitivity.    |

### Enable Governance Headers

```bash
# In your .env or shell:
export AEP_ENTITY="org:your-company"
export AEP_CLASSIFICATION="confidential"
export AEP_TRACE_ID="workflow-$(date +%s)"
```

These headers are injected into every LLM call. The AEP proxy parses them, strips them before forwarding to the LLM provider, and includes them in the dashboard and audit trail.

## Configurable Enforcement Policy

Customize what gets blocked, flagged, or passed per detector:

```yaml
# aep-policy.yaml
default_action: flag
detectors:
  pii:
    action: block
    threshold: 0.8
  agent_threat:
    action: block
  cost_anomaly:
    action: pass
    multiplier: 10
  content_safety:
    action: flag
    threshold: 0.85
```

Set `AEP_POLICY=aep-policy.yaml` in your `.env` to apply. Enterprises can define their own safety policies without changing code.

## Custom Safety Detectors

Add your own detectors alongside the built-in ones:

```python
# my_detector.py
from aceteam_aep.safety.base import SafetySignal

class ComplianceDetector:
    name = "compliance"

    def check(self, *, input_text, output_text, call_id, **kwargs):
        # Your detection logic here
        return []
```

Load it via the proxy CLI: `aceteam-aep proxy --detector my_detector:ComplianceDetector`

## Attestation (Roadmap)

AEP is building cryptographic proof that safety claims are genuine, not just stated:

- **Level 1 — Signed Verdicts.** Each PASS/FLAG/BLOCK decision is Ed25519-signed by the proxy. Verifiable by anyone. Post-quantum hybrid signing (ML-DSA-65) ensures long-term auditability.
- **Level 2 — Detector Attestation.** Each safety detector independently signs its output. Verifiers can confirm N detectors ran and weren't tampered with.
- **Level 3 — Third-Party Verification.** External certification that the proxy runs approved detectors with valid keys. The SOC 2 model for agent safety.

Non-AEP agents get low-confidence annotations. AEP-attested agents get verified trust scores. This creates structural preference for safety-enabled agents.

See the [AEP protocol spec](https://github.com/aceteam-ai/aceteam-aep) for the full attestation architecture.

## Tested With

| Agent/Framework | Integration | Verified |
|----------------|------------|----------|
| OpenClaw (this repo) | Docker compose overlay | Yes |
| NemoClaw (NVIDIA OpenShell) | Gateway inference routing | Yes — [demo script](https://github.com/aceteam-ai/aep-quickstart/blob/main/scripts/demo-nemoclaw.sh) |
| NanoClaw | `OPENAI_BASE_URL` env var | Yes |
| CrewAI, DeerFlow, LangChain | `OPENAI_BASE_URL` env var | Yes |
| Any OpenAI-compatible client | Proxy or wrap() | Yes |

## Upstream

SafeClaw tracks [openclaw/openclaw](https://github.com/openclaw/openclaw) main branch. The only additions are the safety proxy configuration. To sync with upstream:

```bash
git fetch upstream
git merge upstream/main
```

## Learn More

| Resource | What |
|----------|------|
| [AEP Protocol Spec](https://aceteam.ai/docs/aep-overview) | Four pillars: cost, provenance, governance, safety |
| [AEP Package (PyPI)](https://pypi.org/project/aceteam-aep/) | `pip install aceteam-aep[all]` |
| [AEP Source](https://github.com/aceteam-ai/aceteam-aep) | Proxy, SDK, detectors, dashboard |
| [AEP Quickstart](https://github.com/aceteam-ai/aep-quickstart) | Examples, NemoClaw demo, sidecar pattern |
| [Safety Docs](https://aceteam.ai/docs/safety-proxy) | Detectors, enforcement, headers |
| [AceTeam](https://aceteam.ai) | The team behind AEP |
