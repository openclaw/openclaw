---
name: url-summarizer
description: Summarize web articles, blog posts, documentation pages, or any URL content. Use when the user shares a URL and asks for a summary, TL;DR, key points, or wants to understand what a page is about without reading it. Also useful for comparing multiple URLs. NOT for: downloading files, scraping entire sites, or interacting with web apps (use browser tool).
metadata:
  { "openclaw": { "emoji": "📰" } }
---

# URL Summarizer

Fetch and summarize web content for quick consumption.

## Workflow

1. Use the `web_fetch` tool to get the page content as markdown
2. Analyze the content and produce a structured summary
3. Deliver in a format appropriate for the channel

## Summary Format

For a single URL:

```
📰 **Title of Article**
Source: example.com | ~5 min read

**TL;DR:** One-sentence summary.

**Key Points:**
• Point one
• Point two
• Point three

**Notable quotes/data:** (if any)
```

For multiple URLs (comparison):

```
📰 **Comparing N articles on [topic]**

**1. Title One** (source.com)
• Key takeaway

**2. Title Two** (other.com)
• Key takeaway

**Common themes:** ...
**Differences:** ...
```

## Guidelines

- Keep summaries to 3-5 bullet points unless the user asks for more detail
- Preserve specific numbers, dates, and named entities
- Note the author and date if available
- Flag if the content is paywalled or truncated
- For technical docs, include code examples if they're central to the content
- Estimate reading time: ~200 words per minute
