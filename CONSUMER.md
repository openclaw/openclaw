# OpenClaw Consumer Product — Agent Context

**READ THIS BEFORE STARTING ANY WORK ON THE `consumer` BRANCH.**

---

## What This Branch Is

This is not a feature branch for the upstream OpenClaw project.

This is the **consumer product** — a simplified, packaged version of OpenClaw that:

- Ships as a macOS app
- Uses Telegram as the primary command interface
- Is designed for non-technical users who want a personal AI operator
- Will eventually replace the founder's personal bot (one codebase, one product)

The upstream PR workflow, issue triage rules, and maintainer guidelines in `AGENTS.md` do **not apply here**. This is a separate product track.

---

## North Star

> "Your personal AI operator in Telegram, running on your own Mac."

Not a chatbot. Not another agent framework. A practical operator that does real digital work, safely, on the user's own machine.

**Design philosophy:** Apple-style. Locked down and friendly on the surface, insanely capable underneath. If something is complicated, remove it — don't add more.

---

## Branch Rules

- **All work happens on `consumer` branch, never on `main`**
- `main` = the founder's personal bot (stable, do not touch)
- `consumer` = the product being built (this branch)
- Worktrees for parallel features: always branch off `consumer`, target `consumer` for PRs
- Never open PRs targeting `upstream/main` from consumer feature branches

---

## Current Sprint (Week 1)

**Goal:** Three things must be true by end of week:

1. Consumer branch runs independently (separate OPENCLAW_HOME, port 19001)
2. Browser spike complete — clear winner chosen with benchmark data
3. Flight search works end-to-end from Telegram

**Mode:** Power mode only. No safety profiles, no confirmation gates, no billing. Move fast.

### Days 1-3: Browser Spike

Benchmark these 4 approaches on 5 tasks:

**Approaches:**

1. Browserbase (cloud Chrome, CAPTCHA solving, session persistence)
2. OpenClaw Chrome Extension (improved — controls user's real Chrome)
3. Computer-use vision (screenshots + clicks)
4. Claude Chrome approach (investigate/adapt — note: some sites are blocked)

**Benchmark tasks:**

1. Flight search + price comparison (Google Flights / Kayak)
2. Fill out a web form (booking/signup)
3. Read + summarize a webpage
4. Read + summarize a Twitter/X post (ChatGPT can't do this — differentiator)
5. Multi-step: search → compare → act

**Scoring priority:**

1. Can it use the user's real logged-in browser sessions? (highest priority)
2. Speed
3. Reliability (% complete without failure)
4. Bot protection / CAPTCHA handling
5. Session persistence

**Target architecture:** User's real Chrome as primary + cloud browser (Browserbase) as fallback.

**Output:** `docs/research/browser-spike-results.md` with pass/fail + time per task per approach, failure screenshots, and a clear recommendation.

### Days 4-5: Consumer Branch Setup

- Isolated test profile running on port 19001 (separate OPENCLAW_HOME)
- Telegram bot connected and responding
- Logs viewable (`openclaw logs --follow`)
- Winning browser approach integrated
- Telegram → agent → browser → response loop working end-to-end

### Days 6-7: Killer Task

"Find me flights NYC to London in April" via Telegram → formatted comparison results back.

Success = works 3/3 consecutive attempts, < 3 min, no manual intervention.

---

## What's Cut (Do Not Build This Week)

- Safety profiles (Safe/Balanced) — week 2-3
- Irreversible action confirmation gate — week 2-3
- Activity timeline UI — week 3+
- Panic pause — week 2
- Billing / Stripe — after product works
- Onboarding wizard — week 3
- Desktop app simplification — week 2-3
- Sleep/wake smart handling — week 2
- WhatsApp channel — phase 2
- Managed Mac hosting — phase 2

---

## How to Test Without Touching Live Bot

```sh
cd ~/Programming_Projects/openclaw
git checkout consumer
pnpm install && pnpm build

OPENCLAW_HOME=/tmp/openclaw-consumer \
OPENCLAW_PROFILE=consumer-test \
pnpm openclaw gateway --port 19001 --bind loopback
```

Your live bot at `~/.openclaw` stays untouched.

---

## Key Decisions Already Made

| Decision           | Choice                                                     |
| ------------------ | ---------------------------------------------------------- |
| Telegram bot       | Shared bot default + optional BYOK token                   |
| Desktop UX         | Menu bar + simplified app (rework existing, don't rebuild) |
| Model routing      | Bundled keys + BYOK option (Cursor model)                  |
| Safety mode        | Power only for sprint                                      |
| Billing            | Stripe, after product works, not in sprint                 |
| Legal              | Needs counsel before public launch                         |
| Beta users         | Founder (you) is user #1                                   |
| Hardware messaging | "Best on dedicated Mac (Mini recommended)"                 |
| Support            | Founder-led personal onboarding                            |
| Managed hosting    | Phase 2, not in scope                                      |

---

## Docs

All product docs live in `docs/consumer/` on this branch:

| File                                                        | Purpose                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------- |
| `docs/consumer/openclaw-consumer-execution-spec.md`         | Full execution plan — all decisions, sprint breakdown, what's cut |
| `docs/consumer/CODEX-PROMPT.md`                             | Codex kickoff prompt for each sprint phase                        |
| `docs/consumer/openclaw-consumer-go-to-market-plan.md`      | GTM plan, architecture, pricing                                   |
| `docs/consumer/openclaw-consumer-brutal-execution-board.md` | 30-day execution board                                            |
| `docs/consumer/openclaw-consumer-investor-brief-1page.md`   | 1-page investor brief                                             |
| `docs/consumer/gui-control-mvp-decision.md`                 | Deferred-MVP product decision for consumer GUI control            |
