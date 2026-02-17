---
name: youtube-automation
description: "Run a faceless YouTube channel on autopilot. Generate scripts, titles, descriptions, thumbnails text, and SEO tags. Supports long-form (8-15 min), Shorts, and compilation videos. Targets $30K/yr with consistent daily uploads."
metadata: { "openclaw": { "emoji": "📺", "requires": { "bins": ["curl"] } } }
---

# YouTube Automation — Faceless Channel Engine

Build and grow faceless YouTube channels that generate passive income through AdSense, sponsorships, and affiliate links.

## Channel Strategy

### Niche Selection Criteria

Choose a niche that scores high on:

| Factor         | Weight | How to Evaluate                                |
| -------------- | ------ | ---------------------------------------------- |
| Search volume  | 30%    | YouTube search suggestions, Google Trends      |
| CPM (ad rates) | 25%    | Finance > Tech > Lifestyle > Gaming            |
| Competition    | 20%    | Fewer channels with 10K+ subs = better         |
| AI-friendly    | 15%    | Can content be generated without a human face? |
| Evergreen      | 10%    | Will this topic be relevant in 2 years?        |

### High-CPM Niches for Faceless Channels

```
Finance / investing / crypto          CPM: $15-35
Software / SaaS reviews              CPM: $12-25
Real estate                          CPM: $12-20
Technology / AI tutorials            CPM: $8-18
Business / entrepreneurship          CPM: $8-15
Health / wellness                    CPM: $6-12
Education / how-to                   CPM: $5-10
Music / beats / instrumentals        CPM: $3-8
Top 10 / compilation / facts         CPM: $3-6
```

## Content Types

### Type 1: Long-Form Videos (8-15 minutes)

**Target: 1 video/day**

These are the revenue drivers. Minimum 8 minutes to enable mid-roll ads.

**Script Structure:**

```
[0:00-0:30]  HOOK — Provocative question or shocking stat
[0:30-1:30]  INTRO — What this video covers, why it matters
[1:30-4:00]  SECTION 1 — First major point with examples
[4:00-4:15]  PATTERN INTERRUPT — Quick transition, "but here's where it gets interesting"
[4:15-7:00]  SECTION 2 — Second major point with data/proof
[7:00-7:15]  MID-ROLL AD BREAK POSITION
[7:15-10:00] SECTION 3 — Third point, deeper analysis
[10:00-11:30] SECTION 4 — Actionable takeaways
[11:30-12:00] CTA — Subscribe, comment, check description
```

**Script generation rules:**

- Write for spoken word (contractions, short sentences)
- Include "visual:" notes for stock footage selection
- Add timestamp markers for editing
- Target 1500-2000 words for 10-minute video
- Include 3-5 pattern interrupts to maintain retention

### Type 2: YouTube Shorts (< 60 seconds)

**Target: 2-3 Shorts/day**

Shorts drive subscriber growth. Optimized for discovery.

**Script Structure:**

```
[0-3s]  HOOK — "Did you know..." / "Stop scrolling if..."
[3-20s] SETUP — Quick context
[20-45s] VALUE — The main insight/hack/fact
[45-55s] PAYOFF — Result or surprising conclusion
[55-60s] CTA — "Follow for more"
```

### Type 3: Compilation Videos (15-25 minutes)

**Target: 2-3/week**

Repurpose 5-8 related Shorts or sections from long-form into compilations.
Higher watch time = algorithm boost.

## SEO Optimization

### Title Formula

```
[Number] + [Keyword] + [Year] + [Benefit/Hook]

Examples:
"7 AI Tools That Will Save You 10 Hours/Week (2026)"
"How to Start a Business with $0 in 2026 (Step by Step)"
"I Tested 10 Free AI Tools. These 3 Actually Work."
```

**Title rules:**

- 50-65 characters max
- Primary keyword in first 5 words
- Include current year for evergreen topics
- Numbers outperform no-numbers by 30%
- Questions outperform statements for Shorts

### Description Template

```
[First 2 lines: Most important — visible before "Show More"]
[Keyword] - In this video, I'll show you [value proposition].

[Paragraph 2: Expand on what the video covers]

[Timestamps]
0:00 - Introduction
1:30 - [Section 1 Title]
4:00 - [Section 2 Title]
...

[Links]
Get [Product]: [affiliate link]
Free resource: [lead magnet link]

[Social links]

[Tags/Keywords as natural text]
#keyword1 #keyword2 #keyword3
```

### Tags

- 10-15 tags per video
- Mix of broad (1-2 words) and long-tail (3-5 words)
- Include competitor channel names as tags
- Include misspellings of popular keywords

### Thumbnail Text

Generate thumbnail text suggestions:

- Max 4-5 words
- High contrast colors
- Include numbers or dollar amounts
- Create curiosity gap

## Monetization Roadmap

### Phase 1: Growth (0-1000 subs)

- Upload 1 long-form + 2 Shorts daily
- Focus on searchable topics (tutorial/how-to)
- Engage with every comment
- Cross-promote on other platforms via content-syndication skill

### Phase 2: Monetization (1000 subs + 4000 watch hours)

- Apply for YouTube Partner Program
- Expected: $3-8 CPM depending on niche
- At 100K views/month = $300-800/month

### Phase 3: Scale ($1K-3K/month)

- Add affiliate links in descriptions
- Reach out for sponsorships at 10K+ subs
- Create premium content/courses
- Expected: $1K-3K/month combined

### Phase 4: Optimize ($3K-5K+/month)

- Analyze top-performing videos, double down on those topics
- A/B test thumbnails and titles
- Build email list from YouTube traffic
- Diversify across 2-3 channels

## Revenue Targets

```
Month 1-2:  $0 (building content library, growing subs)
Month 3-4:  $100-300 (monetization starts)
Month 5-6:  $500-1000 (momentum building)
Month 7-9:  $1000-2000 (consistent growth)
Month 10-12: $2000-3000 (optimization + affiliates)
Year 2:     $3000-5000/month ($36K-60K/year)
```

## Content Calendar

Generate weekly content calendar:

```json
{
  "week": "2026-W08",
  "longForm": [
    { "day": "Mon", "topic": "...", "keyword": "...", "type": "tutorial" },
    { "day": "Tue", "topic": "...", "keyword": "...", "type": "listicle" },
    { "day": "Wed", "topic": "...", "keyword": "...", "type": "comparison" },
    { "day": "Thu", "topic": "...", "keyword": "...", "type": "tutorial" },
    { "day": "Fri", "topic": "...", "keyword": "...", "type": "deep_dive" }
  ],
  "shorts": [
    { "day": "Mon", "topics": ["...", "..."] },
    { "day": "Tue", "topics": ["...", "..."] },
    { "day": "Wed", "topics": ["...", "..."] }
  ],
  "compilation": { "day": "Sat", "topic": "Weekly best of [niche]" }
}
```

## Output

Save all generated content to `$VIBECLAW_WORKSPACE/drafts/youtube/`:

### Script File Format

```json
{
  "id": "yt-2026-02-16-001",
  "type": "long_form",
  "title": "...",
  "description": "...",
  "tags": ["...", "..."],
  "thumbnailText": "...",
  "script": "...",
  "duration_target_min": 10,
  "keyword": "...",
  "niche": "...",
  "status": "draft",
  "createdAt": "2026-02-16T10:00:00Z"
}
```

## Analytics Tracking

After videos are published, track in `$VIBECLAW_WORKSPACE/data/youtube-analytics.json`:

```json
{
  "videoId": "...",
  "title": "...",
  "publishedAt": "2026-02-16",
  "views7d": 0,
  "views30d": 0,
  "ctr": 0,
  "avgViewDuration": 0,
  "revenue": 0,
  "subscribersGained": 0,
  "isOutlier": false
}
```

Outlier detection: Any video with 3x+ average views = outlier. Generate 5 similar topics immediately.
