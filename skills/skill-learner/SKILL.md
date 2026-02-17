---
name: skill-learner
description: "Self-improving skill system that compounds knowledge over time. Logs successes and failures, updates skill files with new rules, templates, and formulas. Every session reads past learnings. The agent never makes the same mistake twice."
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "requires": { "env": ["VIBECLAW_WORKSPACE"] },
        "primaryEnv": "VIBECLAW_WORKSPACE",
      },
  }
---

# Skill Learner — Self-Improving Knowledge System

This skill maintains and improves all Vibeclaw skill files based on real-world results. It's the compound interest engine of the entire system.

## Core Principle

Every failure becomes a rule. Every success becomes a formula. The agents never make the same mistake twice and always replicate what works.

## Knowledge Files

Maintain these knowledge files in `$VIBECLAW_WORKSPACE/learnings/`:

### `platforms.md` — Platform-Specific Rules

```markdown
# Platform Rules

## X (Twitter)

### What Works

- Replies under 200 chars get 2x engagement
- Asking a question in reply gets 3x more interactions
- Morning posts (9-11 UTC) outperform evening

### What Doesn't Work

- Links in first reply reduce reach by 50%
- Using "check out" sounds promotional, gets flagged
- Posting more than 180 replies/day triggers shadow ban

## Reddit

### What Works

- Starting with "In my experience..." gets upvotes
- Including specific numbers/data boosts credibility
- [Add new learnings here]

### What Doesn't Work

- Mentioning product name in title gets auto-removed in r/SaaS
- [Add new learnings here]
```

### `templates.md` — Proven Templates

```markdown
# Outreach Templates

## Email — High Response Rate (23%)

Subject: Quick thought on your [Role] search
Body: [template]
Context: Works for job-sniper leads at Series A-B startups
Last updated: 2026-02-16

## Email — Got Flagged as Spam

Subject: [Product] can replace your [Role] hire
Reason: Too aggressive, sounds automated
Rule: Never claim to "replace" a hire. Say "augment" or "help while you search"

## Reddit Reply — Top Performer (45 upvotes avg)

Format: "I've been using [tool] for [time]. The thing that surprised me was [specific benefit]..."
Context: Works in product recommendation threads
Rule: Always include a timeframe of personal use

## Reddit Reply — Got Removed

Format: "Try [product]! It's the best for [category]"
Reason: Too promotional, no personal context
Rule: Never recommend without explaining WHY from experience
```

### `hooks.md` — Content Hook Formulas

```markdown
# Hook Formulas

## Performing Hooks (by engagement rate)

1. "[Person] + [conflict] → showed them [tool] → mind changed" — 12% CTR
2. "I tested [X] for 30 days. Results:" — 8% CTR
3. "Stop doing [thing]. Here's why:" — 7% CTR
4. "[Big number] in [short time]. Free method:" — 6% CTR

## Failed Hooks (retired)

1. "You won't believe..." — 0.5% CTR, feels clickbaity
2. "Thread 🧵" alone — 1% CTR, overused
3. "[emoji spam] MUST READ" — 0.3% CTR, immediate skip
```

### `seo.md` — SEO Learnings

```markdown
# SEO Rules

## What Ranks

- Articles with FAQ sections get 2x featured snippets
- "X vs Y" comparison pages rank within 3 days
- Including current year in title boosts CTR by 15%
- Tables comparing 3+ tools get cited by LLMs

## What Doesn't Rank

- Thin content under 800 words (no ranking in 30 days)
- Pages without internal links (Google doesn't crawl)
- Duplicate descriptions across directories (gets deindexed)

## Backlink Rules

- Anchor text rotation: max 20% exact match
- Link velocity: max 30 new backlinks per week
- NoFollow ratio: aim for 40% nofollow, 60% dofollow
```

### `errors.md` — Error Log and Prevention Rules

```markdown
# Error Prevention Rules

## Account Bans

- X: Stayed under 200 replies/day after ban at 250 on 2026-02-10
- Reddit: Don't post same link in 3+ subreddits within 24h
- LinkedIn: Max 50 connection requests/day

## API Failures

- Always check rate limit headers before next request
- Implement exponential backoff: 1s, 2s, 4s, 8s, 16s
- Cache responses to avoid duplicate API calls

## Content Rejections

- Product Hunt: Don't submit on weekends (lower visibility)
- Dev.to: Must include at least one code block
- Medium: Articles under 3 min read time get less distribution
```

## Learning Loop

After every agent session:

1. **Collect results** from all agent logs
2. **Identify patterns**:
   - What got the most engagement?
   - What got flagged/removed/banned?
   - What converted to leads/demos/signups?
3. **Update knowledge files**:
   - Add new rules to prevent repeat mistakes
   - Add new formulas to replicate successes
   - Update templates with better-performing versions
   - Retire underperforming strategies
4. **Notify orchestrator** of significant changes

## Knowledge File Format

When adding a new learning:

```markdown
## [Category] — [Brief Description]

- **What**: [What happened]
- **Result**: [Positive/negative outcome with numbers]
- **Rule**: [Actionable rule derived from this]
- **Date**: [When this was learned]
- **Confidence**: [High/Medium/Low — based on sample size]
```

## Compounding Effect

Week 1: Start with 20-30 lines per knowledge file
Week 2: Grow to 100+ lines as patterns emerge
Week 4: 300+ lines — agent is significantly smarter
Week 8: 500+ lines — agent operates with institutional knowledge

The key insight: **every session makes all future sessions better**. This is the unfair advantage over competitors who start from scratch each time.

## Periodic Review

Every 7 days:

1. Review all knowledge files for contradictory rules
2. Merge overlapping strategies
3. Archive rules that haven't been relevant in 30 days
4. Highlight top 5 performing strategies across all agents
5. Generate weekly performance summary
