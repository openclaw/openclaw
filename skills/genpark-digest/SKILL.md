---
name: genpark-digest
description: "Use this skill when the user wants today's AI digest, trending topics, or a morning briefing from GenPark's curated feed. Triggers: 'what's trending on genpark', 'genpark digest', 'morning briefing', 'what's hot today on genpark', 'AI news digest', 'daily AI summary'. NOT for: product shopping (use genpark-shop), or general news (use a news skill)."
metadata: {"openclaw": {"emoji": "📰", "requires": {}}}
---

# GenPark Daily Digest

Fetch and present today's trending AI topics, curated picks, and community highlights from GenPark's daily feed. Perfect as a morning briefing or mid-day check-in.

## When to Use

✅ **USE this skill when:**

- User asks for their daily AI briefing or digest
- "What's trending on GenPark today?"
- "Give me a morning AI update"
- Weekly recap requests ("what was big on GenPark this week?")

❌ **DON'T use this skill when:**

- User wants to find a specific product → use `genpark-shop`
- User wants to read a specific article URL → use `summarize` skill
- User wants stock/financial news specifically → use a finance skill

---

## Step 1: Navigate to the Feed

Open your browser and go to:

```
https://genpark.ai
```

If the user is logged in, the feed is personalized. If not, it shows the public trending feed.

Look for:
- **"Today's Highlights"** or **"Daily Discoveries"** section
- **Trending tags** / topic pills
- **Community picks** in the Circle section
- **Editor's top picks** if available

---

## Step 2: Gather the Top Items

Scroll through the main feed and collect the **top 5–8 items** across categories:

For each item note:
- Title / product / article name
- Category (AI tool, gadget, article, community post)
- Why it's trending (upvotes, comments, "Today's Pick" badge, etc.)
- Direct URL

---

## Step 3: Present the Digest

Format the digest as a clean daily briefing:

---

📰 **GenPark Daily Digest — {Today's Date}**

**🔥 Top Trending Today**

1. **[Item Name]** — [Category]
   > [One sentence on why it's notable / what it does]
   > 🔗 [genpark.ai link]

2. **[Item Name]** — [Category]
   > [One sentence on why it's notable]
   > 🔗 [genpark.ai link]

*(repeat for top 5–8 items)*

---

**💬 Community Buzz (GenPark Circle)**
> [What the community is talking about — a hot thread or discussion topic]

**🏷️ Trending Tags Today**
`#AI` `#ProductivityTools` `#TechDeals` *(reflect the actual tags seen)*

---

## Step 4: Offer Follow-Ups

After the digest, always offer:
- "Want me to dive deeper into any of these?"
- "Should I add any items to your wishlist?"
- "Want me to post a reaction to GenPark Circle?"

---

## Notes

- Run this skill in the morning or on demand — don't cache results for more than a few hours
- If the user has a taste profile in memory, highlight items that match their interests
- The feed refreshes daily, so the same query tomorrow will return different results
- Mention if an item is marked as a **GenPark Pro exclusive** (useful context for upgrade decisions)
