---
name: genpark-ambassador
description: "Use this skill when the user wants to grow their GenPark presence, gain followers, become a top contributor, or build influence on the GenPark platform. Triggers: 'help me grow on genpark', 'genpark content strategy', 'how do I get more followers on genpark', 'post for engagement on genpark', 'write a genpark circle post', 'help me become a top genpark contributor'. NOT for: passive product browsing (use genpark-shop) or review reading (use genpark-review-summarizer)."
metadata: {"openclaw": {"emoji": "🌟", "requires": {}}}
---

# GenPark Ambassador Skill

Grow your presence and influence on the GenPark platform. This skill helps you craft high-engagement Circle posts, build a content calendar, and execute a strategy to become a recognized top contributor.

## When to Use

✅ **USE this skill when:**

- User wants more followers or engagement on GenPark
- Writing GenPark Circle posts for maximum visibility
- Planning a content calendar or GenPark growth sprint
- Responding to trending topics to build authority
- User says "make me a top GenPark contributor"

❌ **DON'T use this skill when:**

- User just wants to shop → use `genpark-shop`
- User is checking reviews → use `genpark-review-summarizer`
- User wants to search for AI answers → use `genpark-search`

---

## Platform Context

GenPark Circle is a community layer on GenPark where users:
- Share product discoveries and AI tool reviews
- Vote on and discuss trending finds
- Build a following by consistently posting quality content
- Earn "Top Contributor" badges for high-activity, high-upvote participation

**What works on GenPark Circle:**
1. First-mover coverage of newly launched AI tools
2. Honest "buried truth" product takes (not generic praise)
3. Curated themed lists ("5 AI tools for designers under $20")
4. Questions that spark community debate ("Is X actually worth it?")
5. Reaction posts to trending AI news

---

## Step 1: Assess Current Standing

Ask the user:
- What's their GenPark username? (Check their current post count, upvotes, followers)
- What categories do they want to post in? (tech, lifestyle, AI tools, gadgets, etc.)
- How much time per day can they invest? (5 min / 30 min / 1 hour)

Then navigate to `https://genpark.ai/circle` and check:
- What's trending right now (top upvoted posts in the last 24 hours)
- What content format dominates (lists vs. reviews vs. discussions)

---

## Step 2: Draft a High-Engagement Circle Post

When writing a post, follow these principles:

### 📋 Format Template (List Post)

```
🔥 [Attention-grabbing headline — under 15 words]

[1–2 line hook: why this matters right now]

1. **[Item Name]** — [URL]
   → [One punchy benefit sentence]

2. **[Item Name]** — [URL]
   → [One punchy benefit sentence]

3. **[Item Name]** — [URL]
   → [One punchy benefit sentence]

💬 [Engagement question: "Which one would you use?"]

#GenPark #[RelevantTag] #[RelevantTag]
```

### 💬 Format Template (Discussion Post)

```
Hot take: [Controversial but defensible opinion]

[2–3 sentences expanding the argument with evidence]

Am I wrong? Drop your opinion below 👇

#[Tag] #[Tag]
```

### 📖 Format Template (Review/Discovery Post)

```
I tried [Product] for [X days/weeks]. Here's the honest truth:

✅ Loved: [Top 2 things]
❌ Hated: [Top 1 flaw]
💡 Best for: [Specific persona]

Score: [X/10] — [One verdict sentence]

Full review → [Link]

#GenPark #[Category]
```

---

## Step 3: Content Calendar Sprint

For rapid follower growth, use the **5-Post Sprint** approach:

| Day | Post Type | Goal |
|---|---|---|
| Day 1 | Curated list (5 tools in a niche) | First impressions, discoverability |
| Day 2 | First-look review of a new AI product | Authority signal |
| Day 3 | Discussion / Hot take | Engagement + replies |
| Day 4 | "Hidden gem" discovery | Shareability |
| Day 5 | Roundup of community reactions to your posts | Relationship building |

Post between **9–11am** or **7–9pm** local time for maximum engagement.

---

## Step 4: Engagement Loop

After posting, always:
1. Reply to **every comment** within the first hour
2. Upvote the top 3 replies to signal quality
3. Tag 1–2 GenPark users who'd find the content relevant
4. Cross-reference older posts in new ones to build a content web

---

## Step 5: Track Progress

Check weekly:

```
Navigate to: https://genpark.ai/u/{username}
Check:
- Total upvotes received (week-over-week)
- Follower count delta
- Which post got the most traction
- What tags drove the most reach
```

Use these insights to double down on what's working.

---

## Notes

- GenPark's algorithm rewards **consistency** — daily posting beats weekly dumps
- First-mover advantage is huge: covering a new AI tool launch within 24 hours gets disproportionate reach
- Avoid generic review phrases ("this product is amazing!") — specificity converts readers to followers
- If a post goes viral, **immediately** write a follow-up to ride the momentum
- Coordinate with the `genpark-circle` skill for actual post submission and the `genpark-digest` skill to spot fast-breaking trends
