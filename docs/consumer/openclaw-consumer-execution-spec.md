# OpenClaw Consumer — Full Execution Spec

> Generated from founder interview, 2026-03-14
> Status: FINAL — ready for execution

---

## 0) North Star

**The consumer product IS your personal bot.** Not a fork, not a parallel thing — the same product. You're building it on the `consumer` branch, and once it's solid, it replaces your current `main` bot entirely. One codebase. One product. You use it. Others use it.

This means the refactor and the consumer build are the same work — not two separate efforts. Strip the complexity out of what exists, make it Apple-simple, keep it insanely capable. The `main` branch is just a safety net while you build. When `consumer` is ready, `consumer` becomes your daily driver.

**Philosophy:** MacBook, not a dev machine. Locked down and friendly to users, but so powerful it doesn't get in your way either.

---

## 1) One-Liner

**"Your personal AI operator in Telegram, running on your own Mac."**

---

## 2) Decisions Made (All Open Questions Resolved)

### Bot Identity Strategy

- **Decision:** Shared bot for easy onboarding + optional BYOK (Bring Your Own Bot token) for power users
- **Note:** BotFather has no programmatic API — bot creation is manual chat-based. Shared bot is the pragmatic default. BYOK is a settings toggle, not an onboarding step.

### Local App UX

- **Decision:** Rework existing desktop app (likely Electron) — menu bar + simplified full app
- **Style:** Apple-level simplicity. Strip it down, don't add features.
- **No web dashboard** for MVP. Telegram is the primary interface.

### Model Routing

- **Decision:** Bundled API keys included in subscription + BYOK option (Cursor/Windsurf model)
- **Not in week-1 scope.** For now, your own API keys.

### Sleep/Wake Strategy

- **Decision:** Smart sleep prevention during active tasks + user education + Telegram notification when agent goes offline
- **Implementation:** macOS power assertions (caffeinate-style) during task execution. Telegram push when agent loses connection.
- **Messaging to users:**
  - "Works reliably while plugged in"
  - "Unplugged, your Mac may sleep — your agent goes dark"
  - "For 24/7 availability, we recommend a dedicated Mac (Mac Mini works great)"

### Safety Profiles

- **Decision:** Power mode only for week-1 sprint. No confirmation gates.
- **Later:** Add Balanced (confirm irreversible actions) and Safe profiles.

### Legal/Liability

- **Decision:** Needs legal counsel. Must resolve before public launch. Not blocking for private beta.

### Billing

- **Decision:** Stripe (probably). Not in scope until product works. Free during beta.

### Privacy/Data Scope

- **Decision:** Avoid sensitive data for MVP. Scope to non-sensitive tasks (travel, research, drafting). User responsibility for what they expose.

### Support Model

- **Decision:** Founder-led. You personally onboard and support every early user.

### Managed Mac Hosting

- **Decision:** Strictly phase 2. Not in MVP scope.

---

## 3) Fork & Development Strategy

### Structure

- **Source clone:** `/Users/user/Programming_Projects/openclaw`
- **Live bot (personal):** `~/.openclaw/workspace` — DO NOT TOUCH during consumer development
- **Fork integration:** `main` on `artemgetmann/openclaw`
- **Consumer work:** `codex/consumer-openclaw-project` on `artemgetmann/openclaw`

### Convergence Plan

- Current `main` = your live personal bot (complicated, works, don't break it)
- `codex/consumer-openclaw-project` = the simplified rebuild and product branch
- When `codex/consumer-openclaw-project` is stable → switch `~/.openclaw` to run from that branch → retire `main` as your daily driver
- You end up with ONE bot, ONE codebase, that is both your personal agent AND the product

### Refactor Strategy
The refactor doesn't happen on `main`. It happens as part of building `codex/consumer-openclaw-project`.
- Branch off current `main` (so you have its working code as a starting point)
- Aggressively simplify on `codex/consumer-openclaw-project` — remove everything not needed for the core loop
- Your live bot on `main` stays untouched and working throughout
- Periodically forward genuinely useful improvements from `main` into `codex/consumer-openclaw-project`
- For upstream intake rules, use `docs/agent-guides/fork-maintenance.md`

### Workflow

```sh
# Create or refresh a consumer worktree/branch from the active product branch
cd ~/Programming_Projects/openclaw
git fetch origin --prune
git checkout codex/consumer-openclaw-project
git pull --ff-only origin codex/consumer-openclaw-project

# Test consumer build without touching live bot
pnpm install && pnpm build
OPENCLAW_HOME=/tmp/openclaw-consumer \
OPENCLAW_PROFILE=consumer-test \
pnpm openclaw gateway --port 19001 --bind loopback

# Upstream intake is selective, never a blind merge
# See docs/agent-guides/fork-maintenance.md
```

### Rule
Your personal bot stays on `main`. `codex/consumer-openclaw-project` is the product branch. Only switch your personal bot when that branch is proven stable.

---

## 4) The Week — 7-Day Sprint Plan

### Definition of Done

All three must be true:

1. ✅ Consumer branch exists and runs independently on port 19001
2. ✅ Browser spike has a clear winner with benchmark data
3. ✅ At least one killer task (flight search from Telegram) works end-to-end

---

### Days 1-3: Browser Spike

**Goal:** Benchmark 4 browser approaches on 5 real tasks. Pick a winner.

#### Approaches to Test

1. **Browserbase** — Cloud-hosted Chrome, handles CAPTCHAs, session persistence
2. **OpenClaw Chrome Extension** (improved) — Controls user's real Chrome, currently unreliable
3. **Computer-use vision** (screenshots + clicks) — Like Claude Chrome under the hood
4. **Claude Chrome approach** (investigate) — Study implementation, see what can be adapted (some sites blocked)

#### Benchmark Tasks (run each on all 4 approaches)

1. **Flight search + price comparison** — Search Google Flights/Kayak, compare 3+ options, report back
2. **Fill out a web form** — Navigate to a booking/signup form, fill fields, handle dropdowns, submit
3. **Read + summarize a webpage** — Navigate to URL, extract content, return summary
4. **Read + summarize a Twitter/X post** — Specifically test social media (ChatGPT can't do this)
5. **Multi-step: search → compare → act** — Full workflow: search, compare 3 options, take action (add to cart, save, etc.)

#### Scoring Criteria (priority order)

1. **Can use user's real browser sessions?** (highest priority — logged-in state matters)
2. **Speed** — Time to complete each task
3. **Reliability** — % of tasks completed without failure/manual intervention
4. **Bot protection handling** — Can it bypass CAPTCHAs, bot detection?
5. **Session persistence** — Does login state survive between tasks?

#### Decision Framework

- **Primary:** User's real Chrome browser (extension or vision-based)
- **Fallback:** Cloud browser (Browserbase) for when local browser isn't available or fails
- If no approach hits >80% reliability on the 5 tasks → week is about fixing the best candidate, not moving to MVP

#### Spike Output

A markdown doc: `browser-spike-results.md` with:

- Pass/fail + time for each task × each approach
- Screenshots of failures
- Recommendation with rationale
- Known limitations and workarounds

---

### Days 4-5: Consumer Branch Setup

**Goal:** Consumer branch running independently, Telegram working.

#### Tasks

- [ ] Create `consumer` branch from `main`
- [ ] Strip/simplify desktop app UI (if touching it this week — may defer)
- [ ] Set up isolated test profile (port 19001, separate OPENCLAW_HOME)
- [ ] Verify Telegram bot works on consumer build
- [ ] Verify logging works and is easily viewable (`openclaw logs --follow`)
- [ ] Integrate winning browser approach from spike
- [ ] Test the Telegram → agent → browser → response loop end-to-end

---

### Days 6-7: Killer Task — Flight Search

**Goal:** "Find me flights NYC to London in April" via Telegram → get real, compared results back.

#### Flow

1. User sends message to Telegram bot
2. Agent parses intent (flight search)
3. Agent opens browser (winning approach), navigates to flight search site
4. Searches with correct parameters
5. Extracts and compares results
6. Sends formatted comparison back to Telegram
7. (Future: user approves, agent books — not in week 1)

#### Success Criteria

- Works 3 out of 3 consecutive attempts
- Results are accurate and formatted readably
- Total time from message to results: < 3 minutes
- No manual intervention required

---

## 5) What's Cut from Week 1

| Feature                               | Status           | When                 |
| ------------------------------------- | ---------------- | -------------------- |
| Safety profiles (Safe/Balanced)       | Cut              | Week 2-3             |
| Irreversible action confirmation gate | Cut              | Week 2-3             |
| Activity timeline UI                  | Cut              | Week 3+              |
| Panic pause button                    | Cut              | Week 2               |
| Billing / Stripe integration          | Cut              | After product works  |
| Onboarding wizard                     | Cut              | Week 3               |
| Desktop app simplification            | Cut (or minimal) | Week 2-3             |
| Sleep/wake smart handling             | Cut              | Week 2               |
| Telegram offline notification         | Cut              | Week 2               |
| WhatsApp channel                      | Cut              | Phase 2              |
| Managed Mac hosting                   | Cut              | Phase 2              |
| Legal/ToS                             | Cut              | Before public launch |
| BYOK (bot token or API keys)          | Cut              | Week 3+              |

---

## 6) Onboarding Vision (Post Week 1)

Guided wizard with interactive "try this" tasks:

1. Connect Telegram → verify bot responds
2. Choose from curated first tasks:
   - "Find me flights to [destination]"
   - "Find hotels near [location]"
   - "Find good cafes near me"
3. Watch agent work in real-time (timeline)
4. "You're set up! What else can I help with?"

Target: First value in < 10 minutes.

---

## 7) Pricing (Unchanged from Brief — Not Active Yet)

| Tier                    | Price       | Scope                           |
| ----------------------- | ----------- | ------------------------------- |
| Starter (Local)         | $29/mo      | 1 device, Telegram, bundled API |
| Pro (Local+)            | $79/mo      | 2-3 devices, priority, BYOK     |
| Concierge (Managed Mac) | $249-499/mo | Phase 2                         |

---

## 8) KPIs (Track When Beta Opens)

- **Activation rate:** install → first successful delegated task
- **Time to first value:** target < 10 minutes
- **7-day retention:** 3+ delegated tasks/week
- **Autonomy success rate:** tasks completed without manual rescue
- **Trust incidents:** critical side effects (target ~0)

---

## 9) Open Items (Must Resolve Before Public Launch)

1. **Legal counsel** — liability boundaries for autonomous agent actions
2. **Billing integration** — Stripe setup, subscription management
3. **Bot identity** — shared bot infrastructure at scale (rate limits, Telegram ToS)
4. **Hardware guidance** — finalize messaging around Mac Mini vs laptop trade-offs
5. **Sensitive data policy** — what the agent should/shouldn't access, data retention

---

## 10) Red Lines (Do Not Violate)

- No approve-every-action default (kills the product)
- No Android/Linux host runtime in MVP
- No cloud-VPS-first browsing promise
- No feature work that doesn't improve activation, retention, or reliability
- No touching the live personal bot during consumer development
- No shipping browser automation that's < 80% reliable on benchmark tasks
