---
summary: "Persistent context, self-improving skills, command-center goals, and scheduled workflows with human checkpoints"
read_when:
  - Designing recurring agent workflows
  - Setting up shared brand or project context
  - Adding human-reviewed scheduled automation
title: "High ROI Agent System"
---

# High ROI Agent System

This pattern turns a single assistant into a maintained operating system for work:

- persistent context split across small files
- skills that collect and promote learnings
- a lightweight command-center goal board
- scheduled workflows that draft reviewable outputs
- human checkpoints before public or risky actions
- sandbox-style hardening checks for always-on agents
- change-specific JiT tests and browser-flow artifacts

## Folder layout

Use a private runtime folder outside the repo for personal or business-specific context:

```text
~/.openclaw/brain/
  agent/context.md
  brand/voice.md
  brand/icp.md
  brand/positioning.md
  projects/<project>.md
  skills/learnings.md

~/.openclaw/command-center/
  goals.json
  status.md

~/.openclaw/workflows/
  openclaw-install-maintenance.md
  business-brain-review.md
  skill-improvement-review.md
  command-center-refresh.md
  human-checkpoint-inbox.md
  hardening-review.md
  jit-diff-test-review.md
  browser-flow-review.md
  gated-model-access-review.md
  local-model-routing-review.md
  channels-remote-control-review.md
  business-agent-productization-review.md
  subagent-roster-review.md

~/.openclaw/review/
~/.openclaw/reports/
```

Keep secrets out of these files. Reference secret locations only at a high level.

## Persistent context

Do not put everything in one large instruction file. Load the smallest useful layer:

| Layer           | Purpose                                            |
| --------------- | -------------------------------------------------- |
| Agent context   | Operating rules, safety checkpoints, access policy |
| Brand context   | Voice, ICP, positioning, proof points              |
| Project memory  | Project-specific decisions and current state       |
| Skill learnings | Reusable lessons from failed or successful runs    |

## Self-improving skills

Skills should stay concise. Scheduled review jobs should draft improvements, not silently mutate active skills.

Recommended loop:

1. Capture a short lesson in `brain/skills/learnings.md`.
2. Weekly, draft proposed skill edits under `review/skills/`.
3. Human approves or rejects the draft.
4. Approved lessons are promoted into the relevant skill.

## Command center

Use `command-center/goals.json` as the stable source of truth and generate `status.md` from reports and review folders.

Goal entries should include:

- title
- lane
- cadence
- review path
- checkpoint rule

## Scheduled workflows

Use OpenClaw cron for recurring work:

```bash
openclaw cron add \
  --name "system:command-center-refresh-daily" \
  --cron "10 8 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Read ~/.openclaw/workflows/command-center-refresh.md and refresh ~/.openclaw/command-center/status.md." \
  --no-deliver
```

Use stable names so jobs can be edited deterministically.

## Human checkpoints

Scheduled workflows may:

- read context
- run read-only checks
- generate reports
- draft patches or review notes

Scheduled workflows must not, without approval:

- publish or send messages
- merge PRs
- delete data
- change credentials
- alter network exposure
- apply security or daemon fixes

## Always-on hardening

For a Mac mini or other always-on host, use a deny-first posture:

- gateway bound to loopback with token auth
- secrets outside agent-readable config where possible
- no wildcard elevated allowlists
- `tools.exec.security` set to `allowlist`
- cron disabled by default until each job is reviewed
- public/network actions routed through a human checkpoint

Run the local audit:

```bash
pnpm audit:hardening
```

## JiT catching tests

For AI-heavy development, do not rely only on long-lived test suites. Generate a
change-specific test plan for every meaningful diff:

```bash
pnpm test:jit:plan
```

The output maps changed files to targeted test commands and mutation-style prompts.
Use those prompts to create catching tests that fail on realistic mutants and pass
on the intended implementation.

## Browser flows

Use real browser automation for user-facing and SaaS workflows:

```bash
pnpm browser:flow -- --spec automation/browser-flows/openclaw-dashboard-smoke.json
```

Each run writes screenshots, trace data, and result JSON under
`.artifacts/playwright-flows/`. On failure, inspect artifacts, fix selectors or app
behavior, and rerun the same spec.

## Gated models

Do not add invitation-only preview models to live configs or cron jobs until the
account is explicitly approved and a smoke test passes in the same runtime profile.
Track gated models as watchlist items, not production fallbacks.

## Repo ROI delegation

Before asking an agent to "improve this repo", generate a bounded delegation brief:

```bash
pnpm repo:roi -- --repo /path/to/repo
```

Use the output to select work with high human-time savings and low review cost:

- repo familiarization and impact analysis
- roadmap-constrained feature ideas
- feature scaffolding across boring integration surfaces
- mechanical refactors with clear test gates
- draft PR creation after checks pass

## Headless capability registry

Expose repeatable work through CLI/workflow/browser-flow capabilities:

```bash
pnpm headless:registry
pnpm agent-script:check -- --file automation/agent-scripts/human-checkpoint-review.json
```

Use static, deterministic agent scripts for customer-facing or external-state
work. Use dynamic loops for employee-facing research/coding work, with review
before anything ships.

## Public challenge packaging

When a public challenge or writing opportunity appears, turn existing artifacts
into drafts instead of improvising a post:

```bash
pnpm dev:challenge-pack
```

This writes local DEV Challenge drafts and a checklist under
`~/.openclaw/review/dev-challenge/`. Publishing remains human-only.

## Local model routing

Use local Ollama/Gemma-style models for private, low-risk tasks only after the
local gate passes:

```bash
pnpm local-model:gate -- --model gemma4:e4b
pnpm local-model:gate -- --model minimax/minimax-m2.7
```

Local models are best for private summarization, classification, RAG drafts, and
offline review notes. Keep complex code generation and production fixes on
approved cloud models unless the exact workflow has a passing smoke test.
Models with memory requirements above the host capacity stay on the watchlist or
run remotely; they do not enter live config or cron.

## Chat-channel control

Remote control from Telegram, Discord, iMessage, or similar channels must be
default-deny and allowlisted:

```bash
pnpm channels:policy:check -- --init
```

Channel agents may draft patches and reports. They must not publish, merge,
deploy, spend money, alter credentials, or enable cron without a human checkpoint.

## Business agent packs

Package reusable skills as sellable business-agent offers:

```bash
pnpm business-agent:pack
pnpm agent-marketplace:pack
```

Each agent must define the job it replaces, inputs, reviewable outputs, pricing
band, external-action checkpoints, trust controls, and publish blockers.

Marketplace-ready agents need distribution metadata, a target buyer, sanitized
demo evidence, support ownership, licensing/source credits, and default-deny
customer access. Draft listings remain local until a human approves publishing.

## Specialist subagents

Keep the primary agent focused by delegating bounded work to specialist agents:

```bash
pnpm subagents:check
```

Use read-only subagents for codebase investigation, JiT tests, browser-flow
debugging, security hardening review, and business-agent packaging. Use parallel
subagents only when their scopes are independent or their write sets are
explicitly disjoint.

## Temporary tunnels

Use zrok-style localhost sharing only through an explicit policy check:

```bash
pnpm tunnel:policy:check -- --target localhost:3000 --mode private
```

Default to private token-based access. Public shares, drive shares, control-plane
targets, and long-lived tunnels require human approval. OpenClaw control ports
stay blocked from tunnel exposure by default.
