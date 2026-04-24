---
name: deep-research
description: Multi-source deep research using OpenClaw web search and Firecrawl tools. Searches the web, reads key sources, synthesizes findings, and delivers cited reports with source attribution. Use when the user wants thorough research on any topic with evidence and citations.
origin: ECC
metadata: { "openclaw": { "emoji": "DR" } }
---

# Deep Research

Produce thorough, cited research reports from multiple web sources using OpenClaw web search and Firecrawl extraction tools.

## When to Activate

- User asks to research any topic in depth
- Competitive analysis, technology evaluation, or market sizing
- Due diligence on companies, investors, or technologies
- Any question requiring synthesis from multiple sources
- User says "research", "deep dive", "investigate", or "what's the current state of"

## Tool Requirements

At least one of:

- `web_search` configured with Exa or Firecrawl
- `firecrawl_search` and `firecrawl_scrape` from the Firecrawl plugin

Both Exa and Firecrawl together give the best coverage.

Configure credentials in the Gateway environment or OpenClaw plugin config:

- Exa: `EXA_API_KEY` or `plugins.entries.exa.config.webSearch.apiKey`
- Firecrawl search: `FIRECRAWL_API_KEY` or `plugins.entries.firecrawl.config.webSearch.apiKey`
- Firecrawl scrape/fetch: `FIRECRAWL_API_KEY` or `plugins.entries.firecrawl.config.webFetch.apiKey`

## Workflow

### Step 1: Understand the Goal

Ask 1-2 quick clarifying questions when the goal is ambiguous:

- "What's your goal: learning, making a decision, or writing something?"
- "Any specific angle or depth you want?"

If the user says "just research it", continue with reasonable defaults.

### Step 2: Plan the Research

Break the topic into 3-5 research sub-questions. Example:

- Topic: "Impact of AI on healthcare"
  - What are the main AI applications in healthcare today?
  - What clinical outcomes have been measured?
  - What are the regulatory challenges?
  - What companies are leading this space?
  - What's the market size and growth trajectory?

### Step 3: Execute Multi-Source Search

For each sub-question, search using available tools:

```text
web_search({ query: "<sub-question keywords>", count: 8 })
firecrawl_search({ query: "<sub-question keywords>", count: 8 })
```

When Exa is the active `web_search` provider, use neural/deep modes and content extraction for synthesis-heavy work:

```text
web_search({
  query: "<sub-question keywords>",
  count: 8,
  type: "deep",
  contents: { highlights: true, summary: true }
})
```

Search strategy:

- Use 2-3 different keyword variations per sub-question
- Mix general, official, academic, and news-focused queries
- Aim for 15-30 unique sources total
- Prioritize academic, official, reputable news, and primary sources before blogs or forums

### Step 4: Deep-Read Key Sources

For the most promising URLs, fetch full content:

```text
web_fetch({ url: "<url>" })
firecrawl_scrape({ url: "<url>", maxChars: 12000, onlyMainContent: true })
```

Read 3-5 key sources in full for depth. Do not rely only on search snippets.

### Step 5: Synthesize and Write Report

Structure the report:

```markdown
# [Topic]: Research Report

_Generated: [date] | Sources: [N] | Confidence: [High/Medium/Low]_

## Executive Summary

[3-5 sentence overview of key findings]

## 1. [First Major Theme]

[Findings with inline citations]

- Key point ([Source Name](url))
- Supporting data ([Source Name](url))

## 2. [Second Major Theme]

...

## 3. [Third Major Theme]

...

## Key Takeaways

- [Actionable insight 1]
- [Actionable insight 2]
- [Actionable insight 3]

## Sources

1. [Title](url) - [one-line summary]
2. ...

## Methodology

Searched [N] queries across web and news. Analyzed [M] sources.
Sub-questions investigated: [list]
```

### Step 6: Deliver

- Short topics: post the full report in chat
- Long reports: post the executive summary and key takeaways, then save the full report to a file

## Parallel Research

For broad topics, split the research across independent sub-questions when parallel agents are available:

1. Agent 1: research sub-questions 1-2
2. Agent 2: research sub-questions 3-4
3. Agent 3: research sub-question 5 plus cross-cutting themes

Each agent searches, reads sources, and returns findings. The main session synthesizes the final report.

## Quality Rules

1. Every claim needs a source. No unsourced assertions.
2. Cross-reference. If only one source says it, flag it as unverified.
3. Recency matters. Prefer sources from the last 12 months when the topic is current.
4. Acknowledge gaps. If good evidence was not found for a sub-question, say so.
5. No hallucination. If the evidence is insufficient, say "insufficient data found."
6. Separate fact from inference. Label estimates, projections, and opinions clearly.

## Examples

```text
"Research the current state of nuclear fusion energy"
"Deep dive into Rust vs Go for backend services in 2026"
"Research the best strategies for bootstrapping a SaaS business"
"What's happening with the US housing market right now?"
"Investigate the competitive landscape for AI code editors"
```
