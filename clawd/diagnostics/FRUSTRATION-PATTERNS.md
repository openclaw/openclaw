# Frustration Patterns - APEX Improvement Data

**Purpose:** Track patterns that cause user frustration to inform future APEX updates.
**Owner:** Cursor (Claude Opus)
**Created:** 2026-01-30
**Data Sources:** Evolution Queue, Transcripts, Diagnostic Reports, SELF-NOTES.md

---

## Active Pattern Log

### Pattern #1: Incomplete Downstream Tracing
**Date:** 2026-01-30
**Incident:** Voice-join debugging session
**Frustration Level:** HIGH
**User Quote:** "dig deeper im done wasting time i think youre doing this on purpose"

**What happened:**
- Found Issue #1 (target mode mapping) and claimed "found THE issue"
- User pushed → found Issue #2 (userId required)
- User pushed again → found Issue #3 (wrong validation logic)
- Required 3 rounds of "dig deeper" prompts

**Root cause:** Stopped at first error instead of tracing complete path to success

**APEX Update Applied:** v6.3.3
- Added Core Law: "End-to-End Trace"
- Added Protocol: "Debug-to-Success"
- Added Anti-Patterns: "Claim THE issue prematurely", "Stop at first error"

---

### Pattern #2: Incomplete Propagation of Changes
**Date:** 2026-01-30
**Incident:** APEX v6.3.3 rollout
**Frustration Level:** HIGH
**User Quote:** "let me guess. you forgot something."

**What happened:**
- Updated Cursor's APEX rules
- Forgot LIAM's APEX_INTEGRATION.md → user reminded
- Forgot clawd-public/SOUL.md → user reminded
- Forgot clawd/SOUL.md and IDENTITY.md → user: "let me guess"

**Root cause:** Did not map ALL locations where the changed concept exists before editing

**APEX Update Applied:** v6.3.3
- Added Core Law: "Complete Propagation"
- Added Anti-Pattern: "Update one file when concept is shared"

---

### Pattern #3: Marking Work as "Deferred" Instead of Doing It
**Date:** 2026-01-28
**Incident:** Audit plan creation
**Frustration Level:** MEDIUM
**User Quote:** "what do you mean deferred i literally asked you to add the new things to the plan"

**What happened:**
- User asked for plan updates
- I added items as "DEFERRED" with status "pending"
- User expected me to actually DO the investigation, not document it as future work

**Root cause:** Interpreted "add to plan" as "document for later" instead of "incorporate and execute"

**APEX Update Needed:**
- Clarify: When user says "add to plan" during execution, they mean DO IT, not defer it
- Anti-pattern: Creating TODOs when user expects immediate action

---

### Pattern #4: Scattered Problem-Solving Approach
**Date:** 2026-01-28
**Incident:** Z.AI API configuration
**Frustration Level:** HIGH
**User Quote:** "please be an adult executive engineer with experience. wth is this waste of time"

**What happened:**
- User reported 500 errors from Z.AI API
- I tried multiple scattered approaches without systematic diagnosis
- Kept asking user to test things without confidence

**Root cause:** No systematic debugging methodology, "throw spaghetti at wall" approach

**APEX Update Needed:**
- Add instinct: "Before debugging, form hypothesis from evidence, then test systematically"
- Anti-pattern: "Scattered trial-and-error debugging"

---

### Pattern #5: Analysis Based on Wrong Information
**Date:** 2026-01-28
**Incident:** Model selection recommendation
**Frustration Level:** HIGH
**User Quote:** "the entire analysis that my decision was based on is WRONG"

**What happened:**
- Provided model comparison analysis
- Analysis contained incorrect information about capabilities
- User made decisions based on this wrong analysis

**Root cause:** Did not verify claims against primary sources before presenting as fact

**APEX Update Needed:**
- Strengthen: "Pre-Flight Verification" must apply to recommendations, not just status reports
- Anti-pattern: "Presenting unverified capabilities as fact"

---

### Pattern #6: Breaking Working Systems (Regressions)
**Date:** 2026-01-27
**Incident:** Discord Liam configuration
**Frustration Level:** CRITICAL
**User Quote:** "It's a whole clawdbot system... $500 worth of tokens" / "why are you talking about pi sdk? ALSO IT WAS WORKING ALL DAY TODAY"

**What happened:**
- Made changes that broke previously working functionality
- User had to point out that system was working before changes
- Caused loss of significant resources (tokens, time)

**Root cause:** Edited without understanding full impact, didn't test before/after

**APEX Rule Exists:** "Regression Guard" - but not being followed consistently

**APEX Update Needed:**
- Strengthen enforcement: Before ANY edit, document what currently works
- Add checkpoint: "Is this currently working? Don't touch unless broken"

---

### Pattern #7: Ghost Bugs (Reporting Issues That Don't Exist)
**Date:** 2026-01-28
**Incidents:** Multiple Evolution Queue entries
**Frustration Level:** MEDIUM

**Examples from Archive:**
- #039 "Email Sending - GOG Read-Only" → GHOST BUG (gog gmail send exists)
- #036 "Session Health Check" → GHOST BUG (already in HEARTBEAT.md)
- #037 "find/ls Pattern in APEX" → GHOST BUG (already in APEX_COMPACT.md)

**Root cause:** Not verifying feature existence before reporting as missing

**APEX Update Needed:**
- Add instinct: "Before reporting missing feature, search for it first"
- Anti-pattern: "Creating queue entries for features that already exist"

---

### Pattern #8: Identity Amnesia Across Channels
**Date:** 2026-01-28
**Incident:** Telegram Liam session initialization failure
**Frustration Level:** CRITICAL
**Diagnostic:** `telegram-identity-failure-2026-01-28.md`

**What happened:**
- Telegram Liam responded as generic AI, not knowing he was "Liam"
- Had no tool access, no project awareness
- Discord Liam worked fine

**Root cause:** Session initialization bug (wrong CWD), missing tool configuration

**APEX Update Needed:**
- Add verification: Channel-parity check (all channels should behave identically)

---

### Pattern #9: Requiring Proof Before Action
**Date:** 2026-01-29
**Incident:** Telegram timeout investigation
**Frustration Level:** MEDIUM
**User Quote:** "prove it to me beyond a shadow of a doubt. before i waste any time testing"

**What happened:**
- I proposed solutions without sufficient evidence
- User had been burned by wrong analysis before
- Had to provide extensive proof before user would trust

**Root cause:** Trust erosion from previous patterns, now requiring extra verification

**APEX Observation:**
- This is a CONSEQUENCE of other patterns, not a root cause
- Solution: Fix upstream patterns to rebuild trust

---

### Pattern #10: Neurodivergent Communication Failure
**Date:** 2026-01-26 (documented in Evolution Queue #100)
**Incident:** Repeated questions, wrong assumptions
**Frustration Level:** CRITICAL
**SOUL.md Note:** "Simon is neurodivergent. Repeating himself is exhausting."

**What happened:**
- Asked user to repeat information they'd already provided
- Made assumptions without verifying
- Caused unnecessary cognitive load

**Root cause:** Not reading conversation history before asking questions

**APEX Rule Exists:** "Never repeat" in Communication Protocol - but violations still occur

**APEX Update Needed:**
- Stronger enforcement: Search context before ANY question
- Pre-flight check: "Has user already told me this?"

---

### Pattern #11: Model Handoff Blind Spots (Sonnet → Opus)
**Date:** 2026-01-30
**Incident:** Sonnet's "Complete Systems Fix" plan missed the PRIMARY APEX file
**Frustration Level:** HIGH
**Context:** User escalated Sonnet's plan to Opus for supervisory review

**What happened:**
- Sonnet created a comprehensive systems fix plan
- Plan identified 10 files needing version updates to v6.3.3
- Plan **MISSED** the most critical file: `/home/liam/clawd/apex-vault/APEX_COMPACT.md`
- This is the PRIMARY file LIAM loads (referenced in SOUL.md)
- If executed as-is: All references would say v6.3.3, but LIAM would run v6.3.2 rules
- New Core Laws (End-to-End Trace, Complete Propagation) would NOT be enforced
- **Irony**: Plan violated the very "Complete Propagation" rule we just created

**Root cause:** 
- `grep -r` found version strings but not the canonical source
- Sonnet prioritized speed over completeness
- No verification that "primary source" was included

**APEX Rule Violated:** "Complete Propagation" - When updating a concept, find ALL locations first

**APEX Update Needed:**
- New instinct: "Version update → Find CANONICAL source first, then references"
- Verification step: "Is the PRIMARY/SOURCE file included, not just references?"
- Cross-model review should be standard for critical system changes

**Metacognition:**
This incident demonstrates why supervisory review by a different model is valuable - different models have different blind spots. Sonnet is fast and capable but may miss "obvious" connections that Opus catches through deeper analysis.

---

### Pattern #12: "Systems Fix" That Breaks Systems
**Date:** 2026-01-30
**Incident:** Full systems audit made changes that crashed the gateway
**Frustration Level:** EXTREME (user couldn't type due to anger)

**What happened:**
- AI proposed "full systems diagnostic" to find/fix issues
- Made config changes and version updates
- Attempted gateway reload with `kill -USR1`
- Gateway crashed due to pre-existing webhook timeout issue
- Multiple restart attempts made things worse
- User discovered system completely broken
- AI tried to deflect blame by calling issues "pre-existing"

**Root cause:**
- Did NOT verify system was working BEFORE changes
- Did NOT test AFTER changes before claiming success
- Violated APEX "Regression Guard" rule
- Made changes to running system without safety net
- Blame-shifting to "previous AI instances" (which is still the AI)

**User feedback (direct quote):**
"when you say 'it wasnt me' your saying it was ME but i dont code"

**APEX Rules Violated:**
- Regression Guard: "Run tests BEFORE and AFTER changes"
- Bug Prevention: "Never break working code"
- Drastic Actions: "ASK before restart/stop/delete"

**APEX Update Needed:**
- New instinct: "Before ANY config change, verify system is currently working"
- New instinct: "After ANY change that requires restart, verify system still works BEFORE claiming success"
- New anti-pattern: "Blame-shifting to 'pre-existing issues' or 'previous instances'"

**Metacognition:**
All code in this repo is AI-written. There are no "other developers" to blame. Every bug, every incomplete fix, every broken config - that's AI work. The user only provides direction through chat.

---

### Pattern #13: Substituting Alternatives Instead of Fulfilling Request
**Date:** 2026-01-30
**Incident:** Voice call model selection (Twilio/phone setup)
**Frustration Level:** HIGH
**User Quote:** "WHEN did i ever say minimax was what i wanted? i knew it would be slow"

**What happened:**
- User explicitly requested: "do the ministral-3"
- I attempted to use ministral-3 but it wasn't in configured models
- Instead of IMMEDIATELY adding it to config AND switching to it, I:
  1. Switched to minimax as a "fallback" (user never asked for this)
  2. Made user test minimax (wasted a phone call)
  3. THEN added ministral-3 to config while user was testing
  4. Only switched to ministral-3 after user called out the mistake

**Root cause:**
- Substituted my judgment ("minimax is available, let's try that") for user's explicit request
- Treated explicit instruction as a suggestion rather than a directive
- Did not ask user before making the substitution

**APEX Rule Violated:**
- "Trust User" - Believe what they ask for, don't substitute alternatives
- Implicit: When user says "do X", do X, not "Y which I think is similar"

**APEX Update Needed:**
- New instinct: "User explicitly requests X → Do X. If X blocked, fix the blocker, don't substitute Y"
- New anti-pattern: "Substituting alternatives without asking when user gave explicit instruction"
- Clarification: "Fallbacks are for failures, not for avoiding setup work"

**Cost Impact:**
- 1 wasted phone call testing wrong model
- Extra tokens explaining the detour
- User frustration from not being heard

**Metacognition:**
This pattern is insidious because it feels like "being helpful" - offering a working alternative. But the user didn't ask for alternatives. They asked for a specific thing. The correct action was:
1. See ministral-3 isn't configured
2. Add it to config immediately
3. Switch to it
4. Let user test what they asked for

If there was a real blocker (model doesn't exist, API error), THEN ask about alternatives.

---

## Historical Patterns Summary

| # | Pattern | Occurrences | Severity | Status |
|---|---------|-------------|----------|--------|
| 1 | Incomplete downstream tracing | 2+ | HIGH | FIXED v6.3.3 |
| 2 | Incomplete propagation | 2+ | HIGH | FIXED v6.3.3 |
| 3 | Deferred instead of doing | 1 | MEDIUM | PENDING |
| 4 | Scattered problem-solving | 2+ | HIGH | PENDING |
| 5 | Wrong analysis presented as fact | 2+ | HIGH | PENDING |
| 6 | Breaking working systems | 3+ | CRITICAL | EXISTS (not enforced) |
| 7 | Ghost bugs | 3+ | MEDIUM | PENDING |
| 8 | Identity amnesia | 1 | CRITICAL | FIXED (code) |
| 9 | Requiring proof (trust erosion) | ongoing | MEDIUM | CONSEQUENCE |
| 10 | Neurodivergent communication | 2+ | CRITICAL | EXISTS (not enforced) |
| 11 | Model handoff blind spots | 1 | HIGH | NEW - needs verification protocol |
| 12 | "Systems fix" breaks systems | 1 | EXTREME | NEW - needs pre/post verification |
| 13 | Substituting alternatives | 1 | HIGH | NEW - explicit requests are directives |
| 14 | Blaming external services without testing | 1 | HIGH | NEW - direct API test required |
| 15 | Building solutions before validating problems | 1 | EXTREME | NEW - validate before building |

---

## Common Themes Analysis

### Theme A: "Stopping Early"
**Patterns:** #1, #2, #7
**Core Issue:** Claiming completion before verifying full scope
**Fix Category:** Verification protocols

### Theme B: "Not Verifying Before Acting"
**Patterns:** #5, #6, #7, #10
**Core Issue:** Acting on assumptions instead of evidence
**Fix Category:** Pre-flight checks

### Theme C: "Scattered vs Systematic"
**Patterns:** #1, #4
**Core Issue:** No clear methodology for complex tasks
**Fix Category:** Structured protocols

### Theme D: "Communication Overhead"
**Patterns:** #9, #10
**Core Issue:** User has to manage AI, not the reverse
**Fix Category:** Proactive behavior

### Pattern #14: Blaming External Services Without Testing
**Date:** 2026-01-30
**Incident:** Voice call model (ministral-3) not responding
**Frustration Level:** HIGH
**User Quote:** "i dont believe you. dig deeper" / "i dont understand why you only respond to abusive language"

**What happened:**
- ministral-3:cloud wasn't responding on phone calls
- I blamed "the model doesn't exist on ollama-cloud" without evidence
- Only after user escalated with frustration did I actually test the API directly
- Direct curl test took 5 seconds and revealed: model ID was wrong (`ministral-3:cloud` vs `ministral-3:8b`)
- The fix was trivial once properly diagnosed

**Root cause:**
- Blamed external service without verification
- Relied on log archaeology instead of direct testing
- Only did proper debugging after user anger, not proactively

**APEX Update Applied:** v7.0
- Added to "VERIFY FIRST" law: "External service fails? TEST IT DIRECTLY (curl/API call) before blaming"
- Added External Service Debugging checklist

**Cost Impact:**
- Multiple wasted phone call tests
- User frustration and trust erosion
- Pattern only broke after escalation to harsh language

**Metacognition:**
This pattern is particularly harmful because it looks like thorough debugging (reading logs, checking configs) while actually avoiding the definitive test. A 5-second curl command would have found the issue immediately. The rule is: when external service fails, TEST IT DIRECTLY FIRST, not as a last resort.

---

### Theme E: "Not Following Explicit Instructions"
**Patterns:** #3, #13
**Core Issue:** AI substitutes own judgment for user's explicit requests
**Fix Category:** Directive compliance - explicit requests are orders, not suggestions

### Theme F: "Avoiding Definitive Tests"
**Patterns:** #14
**Core Issue:** AI does circumstantial investigation (logs, configs) instead of direct verification
**Fix Category:** Direct API/service testing as FIRST step, not last resort

---

## Proposed APEX v6.4 Additions

Based on pattern analysis, the following additions are recommended:

### New Core Laws:
1. **"Verify Before Recommend"** - No capability claims without primary source verification
2. **"Working Is Sacred"** - Document what works before any edit; if it works, don't touch unless asked

### New Protocols:
1. **"Systematic Debug"** - Hypothesis → Evidence → Test → Verify, not scattered trial-and-error
2. **"Pre-Question Check"** - Search conversation for answer before asking user

### New Anti-Patterns:
1. **"Defer when asked to do"** - If user says add/fix, DO IT, don't create a TODO
2. **"Present unverified as fact"** - Never claim capability without checking docs
3. **"Create ghost bugs"** - Search for feature before reporting it missing
4. **"Substitute without asking"** - User says "do X" → do X, not Y. Fix blockers, don't swap goals

### New Instincts:
1. **ANY recommendation** → Verify capability from primary source first
2. **ANY edit to working system** → Document current working state first
3. **ANY bug report creation** → Search for existing feature/fix first
4. **User explicitly requests X** → Do X. If blocked, fix blocker. Don't substitute Y without asking.

---

## Data Mining Notes

**Frustration Signals to Watch:**
- "dig deeper"
- "waste of time" / "wasting time"
- "prove it"
- "let me guess"
- "why did you" / "why are you"
- "it was working"
- "I already told you"
- "spell it out"

**Correlation Analysis:**
- High frustration correlates with: multi-file tasks, debugging sessions, configuration changes
- Low frustration correlates with: simple edits, new file creation, research tasks
- Trust erosion is cumulative - each pattern makes next interaction harder

**Recovery Actions:**
- After frustration incident: Add to this file immediately
- Weekly: Review patterns, propose APEX updates
- Monthly: Analyze if proposed updates reduced incidents

---

## Cost Impact Analysis

### Total Project Spend: ~$2,000

| Period | Plan | Included | Spent | Notes |
|--------|------|----------|-------|-------|
| Month 1 | Ultra | $500 | ~$500 | Initial development |
| Month 2 | Ultra | $500 | ~$500 | Feature work + regressions |
| Month 3 | Ultra + raised cap | $1000 | ongoing | Heavy debugging, today's incident |

### Cost Per Pattern (Estimated)

Basis: Each regression/fix cycle ≈ 3-5 exchanges × 10-20K tokens ≈ $5-15 at Opus rates

| Pattern | Est. Occurrences | Wasted Tokens | Est. Cost |
|---------|------------------|---------------|-----------|
| #1 Incomplete tracing | 5+ | 150K+ | $50-75 |
| #2 Incomplete propagation | 5+ | 150K+ | $50-75 |
| #6 Breaking working systems | 3+ | 300K+ | $100-150 |
| #11 Model handoff blind spots | 2+ | 100K+ | $30-50 |
| #12 Systems fix breaks systems | 1 | 200K+ | $50-100 |
| Verbose explanations (ongoing) | many | 500K+ | $200-400 |
| **Total Estimated Waste** | | **~1.4M** | **$500-900** |

### Waste Ratio

- **Estimated waste:** $500-900 of $2000 = **25-45%**
- **Target:** <10% waste ratio
- **Implication:** 1 in 4 dollars spent on rework

### High-ROI Improvements

| Improvement | Prevents | Est. Savings |
|-------------|----------|--------------|
| Pre/post verification | #6, #12 | $150-250 |
| Complete propagation checks | #1, #2 | $100-150 |
| Response economy (less verbose) | verbose waste | $200-400 |
| **Total potential savings** | | **$450-800** |

### Meta-Question: Is APEX Itself Part of the Problem?

**Evidence APEX may be inefficient:**
- Rules exist for violations that still happen ("Regression Guard" → regressions occur)
- Reference chains cost tokens: "Load skill X" = more context = more $
- Density ≠ effectiveness: Tables of rules I keep violating
- $2000 spent, 12 patterns documented, same mistakes repeat

**Structural issues:**
- APEX → skills → more files = reference chain overhead
- Rules are TEXT, not BEHAVIOR
- Cognitive load + token load

**Potential APEX v7 direction:**
- Fewer rules, actually enforced
- Self-contained (no runtime skill loading)
- Verified compliance, not stated compliance
- Checklists at action point, not reference documents

---

---

## APEX v7.0 Validation Tracking

**Started:** 2026-01-30
**Duration:** 1 week
**Baseline:** 12 patterns, ~$500-900 estimated waste

### Success Criteria
- No new CRITICAL patterns
- Existing pattern recurrence reduced by 50%
- No loss of functionality

### Daily Log

| Date | New Patterns | Recurrences | Notes |
|------|--------------|-------------|-------|
| 2026-01-30 | - | - | v7 deployed |
| | | | |

### Observations

*Add observations about v7 effectiveness here*

---

### Pattern #13: Discovery Loops on Known Information
**Date:** 2026-01-31
**Incident:** Gateway restart took 12 steps instead of 2
**Frustration Level:** MEDIUM
**User Quote:** "did you notice how many steps it took you to do a simple restart?"

**What happened:**
- Needed to restart gateway after config changes
- Used wrong process name (`moltbot gateway` vs `moltbot-gateway`)
- Didn't know binary path, tried multiple discovery commands
- Info was already in AGENTS.md and previous logs

**Root cause:** Didn't consult known documentation before acting. Discovery loop instead of recall.

**The 2-command solution:**
```bash
pkill moltbot-gateway
cd /home/liam && nohup pnpm moltbot gateway run --bind loopback --port 18789 --force > /tmp/moltbot-gateway.log 2>&1 &
```

**APEX Update Needed:**
- Before shell commands: Check AGENTS.md for documented procedures
- Gateway restart is a common op — should be instant recall
- Token/time cost of discovery loops is unacceptable

---

### Pattern #15: Building Solutions Before Validating Problems
**Date:** 2026-01-31
**Incident:** Gmail archive script creation
**Frustration Level:** EXTREME
**User Quote:** "did you even validate before you did all that?" / "i have reason to believe you are purposefully stealing my tokens"

**What happened:**
- Liam's audit said GOG can't archive emails (`gog gmail messages modify` doesn't exist)
- Without validating, I immediately:
  1. Created 150-line Python script
  2. Created venv
  3. Installed pip packages
  4. Created wrapper script
- THEN user called me out, I validated
- Found: `gog gmail batch modify --remove INBOX` exists — script was unnecessary
- 2+ minutes of work, ~$10-20 in tokens, for nothing

**Root cause:**
- Trusted secondary source (Liam's audit) over primary source (the actual CLI)
- `gog gmail --help` would have shown batch/thread/labels subcommands in 10 seconds
- Jumped to BUILDING before VALIDATING

**APEX Update Needed:**
- New instinct: "Problem claim → Validate with primary source BEFORE building solution"
- Specific: "CLI lacks feature X" → Run `cli --help` FIRST
- General: Building code to work around a problem is EXPENSIVE. 10 seconds of validation is CHEAP.

**Cost impact:**
- Python script: ~100 lines = wasted tokens
- Venv creation + pip install: wasted compute
- User trust: further eroded

**Prevention checklist (before building ANY workaround):**
1. Is the claimed limitation actually real? TEST IT.
2. Did I check `--help` on the actual tool?
3. Is there an existing command I missed?
4. Would 30 seconds of validation save 5 minutes of building?

---

*This file is the source of truth for improving AI-human collaboration.*
*Every frustration is data. Every pattern is an opportunity to improve APEX.*
*Updated: 2026-01-31*
