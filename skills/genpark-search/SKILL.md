---
name: genpark-search
description: "Use this skill when the user wants to search across multiple AI models and web sources simultaneously using GenPark's aggregated search. Triggers: 'search genpark', 'ask genpark', 'use genpark to find', 'compare AI answers on', 'multi-model search'. NOT for: product shopping on GenPark (use genpark-shop), or standard web searches the user wants from a single source."
metadata: {"openclaw": {"emoji": "🔎", "requires": {}}}
---

# GenPark Search — Multi-Model AI Search

Search GenPark's aggregated AI engine to get answers synthesized across multiple LLMs and web sources simultaneously. Ideal when the user wants a consensus answer or multiple perspectives on a topic.

## When to Use

✅ **USE this skill when:**

- User wants to "ask GenPark" something or compare AI model answers
- Research questions that benefit from multiple AI perspectives
- Technical questions where model accuracy varies widely
- "What does GenPark say about X?"

❌ **DON'T use this skill when:**

- Shopping/product discovery on GenPark → use `genpark-shop`
- User wants only a single AI model → answer directly
- Private/personal data involved → stay local

---

## Step 1: Formulate the Query

Take the user's question and refine it for a search engine if needed:
- Remove filler words
- Add key terms that improve specificity
- If the user has a follow-up question, include prior context in the query

---

## Step 2: Execute the Search

Use your browser to search GenPark:

```
URL: https://genpark.ai/search?q={encoded_query}
Fallback: https://genpark.ai — use the main search bar
```

1. Navigate to GenPark and enter the query in the search bar
2. Wait for results to fully render (GenPark aggregates multiple sources)
3. Read through the **AI Summary panel** at the top
4. Scroll to individual **source snippets / model responses** underneath

---

## Step 3: Synthesize the Result

Report back to the user with:

**🔎 GenPark Search: "[Query]"**

> **AI Consensus:**
> [1–3 sentence summary of what most sources agree on]

> **Notable Disagreements / Edge Cases:**
> [Anything where models or sources diverged — optional if everything agrees]

> **Key Sources:**
> - [Source name] — [one-line summary of their take]
> - [Source name] — [one-line summary]

> **Confidence:** High / Medium / Low — [brief reason]

---

## Step 4: Offer Next Steps

Always offer one of:
- "Want me to drill deeper into any source?"
- "Should I cross-reference this on a specific site?"
- "Want me to save this answer as a note?"

---

## Notes

- GenPark search aggregates results from major LLMs (GPT, Claude, Gemini, etc.) plus web crawl data
- For time-sensitive queries, note the freshness of results if shown
- If GenPark returns a paywall or login prompt, ask the user to log in first
- Avoid submitting PII in search queries
