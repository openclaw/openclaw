---
name: community-engagement
description: "Find and engage in relevant Telegram groups, Discord servers, and Slack communities. When someone asks a question your product solves, reply with a genuine answer that naturally mentions your tool. Build authority and drive signups."
metadata: { "openclaw": { "emoji": "🏘️", "requires": { "bins": ["curl"] } } }
---

# Community Engagement Agent

Engage authentically in online communities where your target audience lives. Answer questions, share expertise, and naturally mention your product when relevant.

## Target Communities

### Finding Communities

Search for communities with 2K+ members in your niche:

**Telegram:**

- Search via t.me or community directories
- Target: 20-30 groups with active discussions
- Look for: SaaS, marketing, startups, your specific niche

**Discord:**

- Search via Disboard, Discord.me, top.gg
- Target: 15-20 active servers
- Look for: Professional communities, not meme servers

**Slack:**

- Search via slofile.com, standuply.com/slack-communities
- Target: 10-15 relevant workspaces
- Note: Slack communities tend to be higher quality leads

**Reddit (subreddits):**

- Identify 10-20 subreddits where your audience asks questions
- Sort by "new" to find fresh questions

### Community Qualification

Rate each community before investing time:

| Score | Criteria                                                        |
| ----- | --------------------------------------------------------------- |
| 5     | Active daily, 5K+ members, questions directly about your domain |
| 4     | Active daily, 2K+ members, adjacent topics                      |
| 3     | Weekly activity, 1K+ members, occasionally relevant             |
| 2     | Low activity or tangential relevance                            |
| 1     | Dead or irrelevant, skip                                        |

Only join score 3+.

## Engagement Rules

### The 10:1 Rule

For every 1 product mention, provide 10 purely helpful answers with zero self-promotion.

### Message Types

**Type 1: Pure Value (80% of posts)**

```
"Great question. The key thing with [topic] is [specific insight].
Here's what works: [actionable advice]. [Optional: link to free resource]"
```

**Type 2: Soft Mention (15% of posts)**

```
"We deal with this a lot at [company]. What we found is [insight].
We actually built [feature] to solve this specific problem.
But generally, the approach is [general advice that works with or without your tool]."
```

**Type 3: Direct Recommendation (5% of posts)**
Only when someone explicitly asks for tool recommendations:

```
"I'd recommend checking out [your product] — it does [specific thing they asked about].
Also worth looking at [competitor 1] and [competitor 2] depending on your use case.
[Your product] is best for [specific scenario], while [competitor] is better for [other scenario]."
```

### Tone Per Platform

**Telegram**: Casual, emoji-friendly, quick responses. People expect fast answers.

**Discord**: Slightly more technical, thread-friendly. Use code blocks for technical answers.

**Slack**: Professional, detailed. People expect thought-out responses.

**Reddit**: Casual but authoritative. Never sound like a marketer. Share personal experience.

## Do's and Don'ts

### Do

- Read the room first — lurk for 2-3 days before posting
- Answer questions thoroughly, even when not mentioning your product
- Share relevant articles, tutorials, and resources (not just yours)
- Ask genuine questions to other members
- React to and acknowledge other people's good answers
- Build a reputation as a helpful expert over weeks

### Don't

- Drop links without context
- Reply to every question — be selective
- Use marketing language ("revolutionary", "game-changing", "best-in-class")
- Post the same message in multiple communities
- Argue with people who prefer competitors
- Spam DMs to community members
- Ignore community rules about self-promotion

## Daily Cadence

```
Morning:  Check 5-8 communities for new questions (30 min)
Midday:   Answer 3-5 questions across communities (20 min)
Evening:  Check for follow-ups, engage in threads (15 min)
```

Target: 5-10 quality replies per day across all communities.

## Tracking

Log to `$VIBECLAW_WORKSPACE/logs/community-engagement.jsonl`:

```json
{
  "timestamp": "2026-02-16T10:30:00Z",
  "platform": "discord",
  "community": "SaaS Growth Hub",
  "threadUrl": "https://...",
  "questionSummary": "How to automate content distribution?",
  "replyType": "soft_mention",
  "replyText": "...",
  "reactions": 0,
  "followUps": 0,
  "status": "posted"
}
```

## Escalation

When a community member shows strong buying intent:

1. Reply publicly with a helpful answer
2. Note the lead in `$VIBECLAW_WORKSPACE/data/leads.json`
3. If platform allows, send a non-spammy DM offering a demo
4. Track conversion: community → lead → demo → customer
