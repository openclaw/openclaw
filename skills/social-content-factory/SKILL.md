---
name: social-content-factory
description: "Generate TikTok carousels, YouTube Shorts scripts, Instagram Reels content, and X threads on autopilot. Creates hooks, scripts, slide content, and captions. Posts as drafts for human review. Cost: ~$0.50/post."
metadata: { "openclaw": { "emoji": "🎬", "requires": { "bins": ["curl"] } } }
---

# Social Content Factory

Generate short-form video scripts, carousels, and social content at scale. Human adds music and publishes. Everything else is automated.

## Content Types

### TikTok/Instagram Carousels (6-slide format)

**Structure:**

```
Slide 1: HOOK — Stop the scroll
Slide 2: PROBLEM — Relatable pain point
Slide 3: AGITATE — Make it worse
Slide 4: SOLUTION — Introduce the fix
Slide 5: PROOF — Show results/data
Slide 6: CTA — What to do next
```

**Hook Formula That Works:**
`[Person] + [conflict] -> showed them [AI/tool] -> mind changed`

Examples:

- "My boss said AI can't do marketing. I showed him this."
- "Client wanted 100 blog posts in a week. Here's what happened."
- "They laughed when I said I automate my SEO. Then they saw the traffic."

### YouTube Shorts (60-second scripts)

**Structure:**

```
0-3s:  HOOK — Provocative statement or question
3-15s: SETUP — Context and relatable scenario
15-40s: REVEAL — The method/tool/hack
40-55s: PROOF — Results, numbers, screenshots
55-60s: CTA — "Follow for more" or "Link in bio"
```

### X Threads (8-12 tweets)

**Structure:**

```
Tweet 1: Hook + promise ("I grew X to Y in Z days. Here's the exact playbook:")
Tweet 2-3: Context / why this matters
Tweet 4-7: Step-by-step method (one step per tweet)
Tweet 8-9: Results and proof
Tweet 10: Common mistakes to avoid
Tweet 11: CTA (follow, retweet, check link)
```

## Batch Generation

When generating content batches:

1. **Pick a topic cluster** (5-10 related topics)
2. **Generate 3 formats** per topic (carousel + short + thread)
3. **Vary hooks** — never reuse the same hook formula twice in a row
4. **Vary CTAs** — rotate between follow, link, comment, share
5. **Output as drafts** for human review

## Hook Bank

Proven hook patterns (rotate through these):

```
"Nobody talks about this [topic] hack"
"I tested [X] for 30 days. Results shocked me"
"Stop doing [common mistake]. Do this instead"
"[Big number] [result] in [short time]. Free method"
"The [industry] secret they don't want you to know"
"I asked ChatGPT to [task]. Here's what happened"
"[Person/Company] makes $[amount] doing [thing]. Here's how"
"You're losing money if you don't know about [topic]"
"[Year] changed everything about [topic]"
"I replaced [old method] with [new method]. 10x results"
```

## Visual Direction Notes

Include visual directions for each slide/scene:

```
[VISUAL: Screenshot of analytics dashboard showing growth]
[VISUAL: Side-by-side comparison before/after]
[VISUAL: Screen recording of the tool in action]
[VISUAL: Text overlay on dark gradient background]
[VISUAL: Stock footage of person working at laptop]
```

## Publishing Schedule

Optimal posting times (UTC):

```
TikTok:    10:00, 14:00, 19:00
Instagram: 11:00, 15:00, 20:00
X:         09:00, 13:00, 17:00
YouTube:   12:00, 16:00
```

Daily targets:

- 2-3 TikTok/Instagram posts
- 1-2 X threads
- 1 YouTube Short

## Cost Per Post

- Content generation (API): $0.02-0.05
- Image generation (if needed): $0.10-0.30
- Total per post: ~$0.15-0.50
- Daily (8 posts): ~$1.50-4.00

## Output Format

Save drafts to `$VIBECLAW_WORKSPACE/drafts/social/`:

```json
{
  "id": "tiktok-2026-02-16-001",
  "type": "carousel",
  "platform": "tiktok",
  "topic": "AI marketing automation",
  "hook": "My boss said AI can't do marketing...",
  "slides": [
    { "number": 1, "text": "...", "visual": "..." },
    { "number": 2, "text": "...", "visual": "..." }
  ],
  "caption": "...",
  "hashtags": ["#ai", "#marketing", "#automation"],
  "status": "draft",
  "createdAt": "2026-02-16T10:00:00Z"
}
```
