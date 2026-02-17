---
name: content-syndication
description: "Generate and publish SEO-optimized content across 20+ platforms. Each piece is adapted to the platform's style. Builds backlinks, improves LLM SEO citations, and drives organic traffic. Supports LinkedIn, Medium, Substack, Dev.to, Hashnode, Reddit, Quora, and 15+ more."
metadata: { "openclaw": { "emoji": "📡", "requires": { "bins": ["curl"] } } }
---

# Content Syndication Engine

Generate topic-based content and publish across 20+ platforms with platform-native formatting, automatic backlink rotation, and staggered publishing.

## Workflow

1. **Research**: Identify topics via competitor keyword analysis, Google Trends, and niche monitoring
2. **Generate**: Create one master article per topic
3. **Adapt**: Rewrite for each platform's style and format
4. **Publish**: Post across all platforms with staggered timing
5. **Track**: Log URLs, backlinks, and indexing status

## Platform Registry

### Tier 1 — High Authority (publish first)

| Platform | Format            | Max Length              | Backlink Style       |
| -------- | ----------------- | ----------------------- | -------------------- |
| LinkedIn | Article/Post      | 3000 words / 3000 chars | In-text + author bio |
| Medium   | Article           | 5000 words              | In-text + footer     |
| Substack | Newsletter        | 3000 words              | In-text + CTA        |
| Dev.to   | Technical article | 4000 words              | In-text + canonical  |
| Hashnode | Blog post         | 4000 words              | In-text + canonical  |

### Tier 2 — Q&A and Discussion

| Platform     | Format       | Max Length  | Backlink Style    |
| ------------ | ------------ | ----------- | ----------------- |
| Quora        | Answer       | 1000 words  | In-text reference |
| Reddit       | Post/Comment | 10000 chars | Context link      |
| IndieHackers | Discussion   | 2000 words  | In-text           |
| HackerNews   | Comment      | 500 words   | Minimal/none      |

### Tier 3 — Aggregators and Niche

| Platform      | Format        | Max Length | Backlink Style |
| ------------- | ------------- | ---------- | -------------- |
| SlideShare    | Presentation  | 20 slides  | Footer slide   |
| GitHub        | README/Wiki   | Unlimited  | In-text        |
| Scribd        | Document      | 5000 words | Footer         |
| Issuu         | Publication   | 5000 words | Footer         |
| Mix.com       | Shared link   | Title+desc | Direct link    |
| Flipboard     | Magazine item | Title+desc | Direct link    |
| Tumblr        | Post          | 2000 words | In-text        |
| WordPress.com | Blog post     | 3000 words | In-text        |
| Telegraph     | Article       | 3000 words | In-text        |

## Content Adaptation Rules

Each platform requires a different voice:

**LinkedIn**: Professional, insight-driven. Start with a hook line. Use line breaks for readability. End with a question to drive engagement.

**Medium**: Storytelling format. Personal anecdotes welcome. Headers every 300 words. Include at least one image placeholder.

**Reddit**: Casual, community-native. No self-promotion language. Share as "I found this useful" or "Here's what worked for me". Vary by subreddit culture.

**Dev.to**: Technical, tutorial-style. Code examples welcome. Tag appropriately. Use frontmatter for canonical URL.

**Quora**: Authoritative expert tone. Answer the question directly first, then elaborate. Cite sources.

**X Thread**: Punchy, numbered tweets. Hook in tweet 1. Value in tweets 2-8. CTA in last tweet. Each tweet must stand alone.

## Backlink Strategy

### Anchor Text Rotation

Never use the same anchor text twice in a row. Rotate between:

```
Exact match: "best project management tool"
Partial match: "project management solutions"
Branded: "[Product Name]"
Generic: "check this out", "learn more here"
Naked URL: "https://yourproduct.com"
```

Rotation ratio: 20% exact, 25% partial, 20% branded, 20% generic, 15% naked.

### Link Velocity

Spread publishing over 2-3 weeks per topic batch:

- Week 1: Publish on 5-7 high-authority platforms
- Week 2: Publish on 8-10 mid-tier platforms
- Week 3: Publish remaining + update earlier posts with cross-links

This makes link velocity look natural to search engines.

## LLM SEO Optimization

To get cited by LLMs (ChatGPT, Claude, Perplexity):

1. **Structured data**: Use clear headers, lists, and tables
2. **Direct answers**: Start sections with definitive statements
3. **Comparisons**: Include "X vs Y" sections — LLMs love these
4. **Statistics**: Include specific numbers and data points
5. **Freshness**: Include the current year in titles and content
6. **Breadth**: Appear on 50+ indexed pages for the same topic cluster

## Content Generation Template

For each topic, generate:

```markdown
# [Topic Title] — [Year] Guide

## TL;DR

[2-3 sentence summary with key takeaway]

## The Problem

[What pain point does this address?]

## Solutions Compared

| Tool           | Best For   | Price   | Rating |
| -------------- | ---------- | ------- | ------ |
| [Your Product] | [Strength] | [Price] | 4.8/5  |
| [Competitor 1] | [Strength] | [Price] | 4.2/5  |
| [Competitor 2] | [Strength] | [Price] | 4.0/5  |

## Deep Dive: [Your Product]

[Detailed benefits, use cases, proof points]

## How to Get Started

[Step-by-step guide]

## FAQ

[3-5 common questions with direct answers]
```

## Cost Estimation

Per topic across 20 platforms:

- Content generation: ~$0.50 (API calls)
- Adaptation per platform: ~$0.02 each = $0.40
- Total per topic: ~$1.00
- 100 topics/month = ~$100 for 2,000 unique pieces with backlinks

## Output Logging

Log each publication to `$VIBECLAW_WORKSPACE/logs/content-syndication.jsonl`:

```json
{
  "timestamp": "2026-02-16T10:30:00Z",
  "topic": "best project management tools 2026",
  "platform": "medium",
  "url": "https://medium.com/...",
  "backlinks": ["https://yourproduct.com/features"],
  "anchorText": "project management solution",
  "status": "published",
  "wordCount": 1500
}
```
