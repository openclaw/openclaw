# Benchwork Systems — Project Context

## What This Is
Benchwork Systems is an AI-as-a-service company deploying automated workflows and autonomous AI agents for SMBs in regulated industries. The founder is a commercial real estate professional (Lyons Industrial Properties, Tiber Capital, Canopy Lawn Care) building this as a new venture in Greenville, SC.

## Target Verticals (in launch order)
1. **CPA/Accounting firms** — first vertical, shortest sales cycle, seasonal pain
2. **Healthcare practices** — HIPAA compliance = moat, high admin burden
3. **Law firms** — attorney-client privilege needs on-prem, fat margins

## Two-Lane Delivery Model
- **Lane 1 — Benchwork Automations**: Deterministic workflows (trigger → steps → output). Priced per workflow. Built with n8n/Make + AI. 1–3 day deploys.
- **Lane 2 — Benchwork Agents**: Autonomous AI employees handling judgment work. Priced as "roles" ($1K–$2.5K/mo). 30-day calibration with human-in-the-loop.
- Every proposal stacks both lanes.

## Tech Stack
- **Core platform**: Proprietary fork of OpenClaw (MIT licensed, github.com/openclaw/openclaw)
- **This repo**: The fork — crossingtiber/benchwork_systems
- **Strategy**: Option B — fork, strip consumer features, rebrand as Benchwork
- **AI models**: Claude API (primary), GPT-4o (fallback), Ollama for on-prem
- **Orchestration**: n8n for deterministic workflows
- **Skills**: TypeScript modules, 70% pre-built / 30% customized per client

## Pricing (internal, not shown to clients)
- Starter: $750/mo (2 automations)
- Professional: $2,000/mo — TARGET TIER (2 automations + 1 agent)
- Growth: $4,000/mo (4 automations + 2 agents)
- Enterprise: $7K–$10K/mo (custom suite + 3–5 agents)
- Setup fees: $1,500–$15,000 depending on tier

## Current Phase
Week 1–2: Deploy OpenClaw internally, then begin stripping consumer features and rebranding.

## Key Reference Files
- `planning/openclaw-fork-plan.md` — Technical implementation plan for the fork
- `planning/vertical-skills.md` — Skill specifications for each vertical
- `planning/security-hardening.md` — Security requirements for regulated industry deployments
- `planning/pricing-economics.md` — Unit economics and pricing logic
- `planning/discovery-process.md` — Sales process and workflow audit framework

## Engineering Principles
- Security-first: audit every skill before deployment, no community skills unreviewed
- Isolated environments per client (no shared tenancy)
- Disable features by default (browser control, shell execution)
- Keep CLAUDE.md lean; reference planning/ files for detail
