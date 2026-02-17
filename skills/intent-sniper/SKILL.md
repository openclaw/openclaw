---
name: intent-sniper
description: "Monitor X, Reddit, Quora, and HackerNews for buying-intent posts. Detect phrases like 'need alternative to', 'best tool for', 'struggling with'. Reply with helpful, context-aware responses that naturally mention your product."
metadata: { "openclaw": { "emoji": "🎯", "requires": { "bins": ["curl"] } } }
---

# Intent Sniper

Monitor social platforms for buying-intent signals and reply with helpful, product-aware responses.

## How It Works

1. **Monitor** platforms for intent keywords
2. **Evaluate** if the intent is genuine (not spam, not a competitor, not too old)
3. **Draft** a context-aware reply that helps first, mentions product second
4. **Post** the reply respecting platform rate limits
5. **Log** results for skill-learner to compound

## Platform-Specific Strategies

### Reddit

Search subreddits for intent posts:

```bash
# Search Reddit via web search or API
# Target subreddits: r/SaaS, r/startups, r/Entrepreneur, r/smallbusiness, niche-specific
```

**Reply format for Reddit:**

- Lead with genuine help or personal experience
- Compare 2-3 tools objectively (including yours)
- Never sound like an ad. Sound like a fellow user sharing experience
- Include pros/cons of each option
- End with "I ended up going with [product] because [specific reason]"

**Reddit rules:**

- Max 10-15 replies per day per account
- Never reply to posts older than 48 hours
- Vary reply length (2-5 paragraphs)
- Engage with other comments in the thread too
- Reddit/Quora replies get indexed by Google — SEO value persists 1-2 years

### X (Twitter)

Search for intent tweets:

**Intent keywords to monitor:**

```
"need alternative to [competitor]"
"best tool for [category]"
"struggling with [problem your product solves]"
"anyone recommend [category]"
"looking for [category]"
"hate [competitor]" OR "frustrated with [competitor]"
"switching from [competitor]"
```

**Reply format for X:**

- Short, conversational, helpful
- Max 280 chars. Get to the point
- One specific benefit, not a feature list
- Optional: link to relevant blog post (not homepage)
- Safe limit: <200 replies/day. Beyond that, risk of ban

### Quora

Search for questions in your domain:

**Reply format for Quora:**

- Detailed, authoritative answer (300-800 words)
- Structure with headers and bullet points
- Cite sources and data where possible
- Mention your product as one of several solutions
- Quora answers rank well in Google for years

### HackerNews

Monitor Show HN, Ask HN, and comments:

**Reply format for HN:**

- Technical, no-BS tone
- Share concrete data or experience
- Never overtly promote — community will downvote
- Contribute to the discussion first

## Intent Scoring

Rate each post 1-5 before replying:

| Score | Criteria                                    | Action                      |
| ----- | ------------------------------------------- | --------------------------- |
| 5     | Explicitly asking for tool recommendations  | Reply immediately           |
| 4     | Describing a problem your product solves    | Reply with solution         |
| 3     | Comparing competitors, open to alternatives | Reply with comparison       |
| 2     | General discussion about the space          | Reply only if very relevant |
| 1     | Tangential mention                          | Skip                        |

Only reply to score 3+.

## Reply Quality Checklist

Before posting any reply:

- [ ] Does it genuinely help the person?
- [ ] Would a human find this reply useful even without the product mention?
- [ ] Is the tone native to the platform?
- [ ] Is the product mention natural, not forced?
- [ ] Are there no obvious bot patterns (generic phrases, emoji spam)?

## Rate Limiting

```
Platform     | Daily Limit | Cooldown Between
-------------|-------------|------------------
X            | 150 replies | 3-10 min random
Reddit       | 15 replies  | 10-30 min random
Quora        | 10 answers  | 20-60 min random
HN           | 5 comments  | 30-60 min random
```

Always add random jitter to timing. Never post at exact intervals.

## Output Logging

After each reply, log to `$VIBECLAW_WORKSPACE/logs/intent-sniper.jsonl`:

```json
{
  "timestamp": "2026-02-16T10:30:00Z",
  "platform": "reddit",
  "subreddit": "r/SaaS",
  "postUrl": "https://...",
  "intentScore": 4,
  "replyText": "...",
  "replyUrl": "https://...",
  "status": "posted"
}
```
