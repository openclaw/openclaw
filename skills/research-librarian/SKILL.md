---
name: research-librarian
description: "Deep, structured web research with cited sources. Use when user needs a thorough answer with evidence: fact-checking, company/person research, technical deep-dives, investment due diligence, news verification, or any topic requiring more than one search."
metadata: { "openclaw": { "emoji": "🔬", "requires": { "bins": [] } } }
---

# Research Librarian

Conducts structured, multi-source web research and returns a properly cited briefing — not just a quick search snippet, but a thorough investigation with sources, confidence levels, and conflicting views.

## When to Use

✅ **Activate on:**

- "research [topic]", "deep dive into [topic]"
- "what do we know about [company/person/event]?"
- "fact check this", "verify: [claim]"
- "due diligence on [company]", "DD on [stock/project]"
- "I need a proper briefing on [topic]"
- "what are the arguments for and against [topic]?"
- "compare [A] vs [B]" (when factual detail matters)
- Any question where a single web search clearly won't be enough

❌ **DON'T use for:**

- Quick price lookups → crypto-tracker or market-morning-brief
- Simple factual questions answerable from training data
- Weather → weather skill
- Real-time data that doesn't need synthesis

## Research Protocol

### Step 1 — Decompose the Question

Break the research question into 3–5 sub-questions covering different angles:

- Core facts
- Context / history
- Opposing views / counterarguments
- Recent developments
- Implications / so what?

### Step 2 — Multi-Source Search

Run at least **4 separate searches** using varied queries:

- Broad query: `"[topic] overview 2025"`
- Specific angle: `"[topic] criticism problems"`
- Expert source: `"[topic] site:ft.com OR site:reuters.com OR site:bbc.co.uk"`
- Recent: `"[topic] latest news 2025"`

### Step 3 — Deep Fetch

For the 3–5 most promising results, use `web_fetch` to read the actual page, not just the search snippet. Extract key facts, quotes, and data points.

### Step 4 — Cross-Reference

Check for conflicts between sources. If sources disagree, note it explicitly — don't silently pick one.

### Step 5 — Synthesise and Cite

## Output Format

```
🔬 RESEARCH BRIEF: [Topic]
Researched: [timestamp]  |  Sources: [N]  |  Confidence: [High/Medium/Low]

## Summary (2–3 sentences)
[Concise answer to the core question]

## Key Findings

1. [Finding 1] — Source: [Name](URL)
2. [Finding 2] — Source: [Name](URL)
3. [Finding 3] — Source: [Name](URL)

## Conflicting Views / Caveats
[If sources disagree, or if there are important caveats]

## Timeline (if relevant)
- [Date]: [event]
- [Date]: [event]

## Bottom Line
[1–2 sentence synthesis — what does this all mean?]

## Sources
1. [Full title](URL) — [brief description of what it contributed]
2. [Full title](URL) — ...
3. ...
```

## Quality Standards

1. **Minimum 4 sources** — never base a research brief on a single source.
2. **Primary > secondary** — prefer original reporting, official announcements, regulatory filings over aggregator summaries.
3. **Date every fact** — if a fact is time-sensitive, note when it was true.
4. **Confidence levels**:
   - `High` — multiple independent sources agree, primary sources available
   - `Medium` — 2–3 sources, some secondary
   - `Low` — single source, unverified, or conflicting information
5. **Flag paid/paywalled sources** — if content is behind a paywall, say so. Don't hallucinate the content.
6. **No opinion, only evidence** — report what sources say; add analysis in the Bottom Line only.

## Domain Preferences (by topic)

| Topic              | Preferred Sources                            |
| ------------------ | -------------------------------------------- |
| UK Finance/Markets | ft.com, reuters.com, bbc.co.uk/news/business |
| US Markets/Stocks  | wsj.com, bloomberg.com, sec.gov (filings)    |
| Crypto             | coindesk.com, theblock.co, decrypt.co        |
| Tech               | techcrunch.com, arstechnica.com, wired.com   |
| Science/Health     | pubmed.ncbi.nlm.nih.gov, nature.com, bmj.com |
| Legal/Regulatory   | legislation.gov.uk, fca.org.uk, sec.gov      |
| General News       | reuters.com, ap.org, bbc.co.uk               |

## Handling Paywalls

If a key source is paywalled:

1. Try the cached/AMP version
2. Try searching for the same information on a non-paywalled source
3. Note in the brief: "[Source] paywalled — key claims verified via [alternative]"
