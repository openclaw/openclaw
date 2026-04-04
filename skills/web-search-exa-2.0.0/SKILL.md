---
name: web-search-exa
description: "Neural web search, content extraction, company and people research, code search, and deep research via the Exa MCP server. Use when you need to: (1) search the web with semantic understanding — not just keywords, (2) find research papers, news, tweets, companies, or people, (3) extract clean content from URLs, (4) find semantically similar pages to a known URL, (5) get code examples and documentation, (6) run deep multi-step research with a report, (7) get a quick synthesized answer with citations. NOT for: local file operations, non-web tasks, or anything that doesn't involve web search or content retrieval."
---

# Exa — Neural Web Search & Research

Exa is a neural search engine. Unlike keyword-based search, it understands meaning — you describe the page you're looking for and it finds it. Returns clean, LLM-ready content with no scraping needed.

**MCP server:** `https://mcp.exa.ai/mcp`
**Free tier:** generous rate limits, no key needed for basic tools
**API key:** [dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys) — unlocks higher limits + all tools
**Docs:** [exa.ai/docs](https://exa.ai/docs)
**GitHub:** [github.com/exa-labs/exa-mcp-server](https://github.com/exa-labs/exa-mcp-server)

## Setup

Add the MCP server to your agent config:

```bash
# OpenClaw
openclaw mcp add exa --url "https://mcp.exa.ai/mcp"
```

Or in any MCP config JSON:

```json
{
  "mcpServers": {
    "exa": {
      "url": "https://mcp.exa.ai/mcp"
    }
  }
}
```

To unlock all tools and remove rate limits, append your API key:

```
https://mcp.exa.ai/mcp?exaApiKey=YOUR_EXA_KEY
```

To enable specific optional tools:

```
https://mcp.exa.ai/mcp?exaApiKey=YOUR_KEY&tools=web_search_exa,web_search_advanced_exa,people_search_exa,crawling_exa,company_research_exa,get_code_context_exa,deep_researcher_start,deep_researcher_check,deep_search_exa
```

---

## Tool Reference

### Default tools (available without API key)

| Tool                   | What it does                                                    |
| ---------------------- | --------------------------------------------------------------- |
| `web_search_exa`       | General-purpose web search — clean content, fast                |
| `get_code_context_exa` | Code examples + docs from GitHub, Stack Overflow, official docs |
| `company_research_exa` | Company overview, news, funding, competitors                    |

### Optional tools (enable via `tools` param, need API key for some)

| Tool                      | What it does                                                                   |
| ------------------------- | ------------------------------------------------------------------------------ |
| `web_search_advanced_exa` | Full-control search: domain filters, date ranges, categories, content modes    |
| `crawling_exa`            | Extract full page content from a known URL — handles JS, PDFs, complex layouts |
| `people_search_exa`       | Find LinkedIn profiles, professional backgrounds, experts                      |
| `deep_researcher_start`   | Kick off an async multi-step research agent → detailed report                  |
| `deep_researcher_check`   | Poll status / retrieve results from deep research                              |
| `deep_search_exa`         | Single-call deep search with synthesized answer + citations (needs API key)    |

---

## web_search_exa

Fast general search. Describe what you're looking for in natural language.

**Parameters:**

- `query` (string, required) — describe the page you want to find
- `numResults` (int) — number of results, default 10
- `type` — `auto` (best quality), `fast` (lower latency), `deep` (multi-step reasoning)
- `livecrawl` — `fallback` (default) or `preferred` (always fetch fresh)
- `contextMaxCharacters` (int) — cap the returned content size

```
web_search_exa {
  "query": "blog posts about using vector databases for recommendation systems",
  "numResults": 8
}
```

```
web_search_exa {
  "query": "latest OpenAI announcements March 2026",
  "numResults": 5,
  "type": "fast"
}
```

---

## web_search_advanced_exa

The power-user tool. Everything `web_search_exa` does, plus domain filters, date filters, category targeting, and content extraction modes.

**Extra parameters beyond basic search:**

| Parameter             | Type     | What it does                                                                        |
| --------------------- | -------- | ----------------------------------------------------------------------------------- |
| `includeDomains`      | string[] | Only return results from these domains (max 1200)                                   |
| `excludeDomains`      | string[] | Block results from these domains                                                    |
| `category`            | string   | Target content type — see table below                                               |
| `startPublishedDate`  | string   | ISO date, results published after this                                              |
| `endPublishedDate`    | string   | ISO date, results published before this                                             |
| `maxAgeHours`         | int      | Content freshness — `0` = always livecrawl, `-1` = cache only, `24` = cache if <24h |
| `contents.highlights` | object   | Extractive snippets relevant to query. Set `maxCharacters` to control size          |
| `contents.text`       | object   | Full page as clean markdown. Set `maxCharacters` to cap                             |
| `contents.summary`    | object   | LLM-generated summary. Supports `query` and JSON `schema` for structured extraction |

**Categories:**

| Category           | Best for                                             |
| ------------------ | ---------------------------------------------------- |
| `company`          | Company pages, LinkedIn company profiles             |
| `people`           | LinkedIn profiles, professional bios, personal sites |
| `research paper`   | arXiv, academic papers, peer-reviewed research       |
| `news`             | Current events, journalism                           |
| `tweet`            | Posts from X/Twitter                                 |
| `personal site`    | Blogs, personal pages                                |
| `financial report` | SEC filings, earnings reports                        |

### Examples

**Research papers:**

```
web_search_advanced_exa {
  "query": "transformer architecture improvements for long-context windows",
  "category": "research paper",
  "numResults": 15,
  "contents": { "highlights": { "maxCharacters": 3000 } }
}
```

**Company list building with structured extraction:**

```
web_search_advanced_exa {
  "query": "Series A B2B SaaS companies in climate tech founded after 2022",
  "category": "company",
  "numResults": 25,
  "contents": {
    "summary": {
      "query": "company name, what they do, funding stage, location",
      "schema": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "description": { "type": "string" },
          "funding": { "type": "string" },
          "location": { "type": "string" }
        }
      }
    }
  }
}
```

**People search — find candidates with specific profiles:**

```
web_search_advanced_exa {
  "query": "machine learning engineers at fintech startups in NYC with experience in fraud detection",
  "category": "people",
  "numResults": 20,
  "contents": { "highlights": { "maxCharacters": 2000 } }
}
```

**Finding pages similar to a known URL:**
Use the URL itself as the query — Exa will find semantically similar pages:

```
web_search_advanced_exa {
  "query": "https://linkedin.com/in/some-candidate-profile",
  "numResults": 15,
  "contents": { "highlights": { "maxCharacters": 2000 } }
}
```

**Recent news with freshness control:**

```
web_search_advanced_exa {
  "query": "AI regulation policy updates",
  "category": "news",
  "maxAgeHours": 72,
  "numResults": 10,
  "contents": { "highlights": { "maxCharacters": 4000 } }
}
```

**Scoped domain search:**

```
web_search_advanced_exa {
  "query": "authentication best practices",
  "includeDomains": ["owasp.org", "auth0.com", "docs.github.com"],
  "numResults": 10,
  "contents": { "text": { "maxCharacters": 5000 } }
}
```

---

## company_research_exa

One-call company research. Returns business overview, recent news, funding, and competitive landscape.

```
company_research_exa { "query": "Stripe payments company overview and recent news" }
```

```
company_research_exa { "query": "what does Anduril Industries do and who are their competitors" }
```

---

## people_search_exa

Find professionals by role, company, location, expertise. Returns LinkedIn profiles and bios.

```
people_search_exa { "query": "VP of Engineering at healthcare startups in San Francisco" }
```

```
people_search_exa { "query": "AI researchers specializing in multimodal models" }
```

---

## get_code_context_exa

Search GitHub repos, Stack Overflow, and documentation for code examples and API usage patterns.

```
get_code_context_exa { "query": "how to implement rate limiting in Express.js with Redis" }
```

```
get_code_context_exa { "query": "Python asyncio connection pooling example with aiohttp" }
```

---

## crawling_exa

Extract clean content from a specific URL. Handles JavaScript-rendered pages, PDFs, and complex layouts. Returns markdown.

```
crawling_exa { "url": "https://arxiv.org/abs/2301.07041" }
```

Good for when you already have the URL and want to read the page.

---

## deep_researcher_start + deep_researcher_check

Long-running async research. Exa's research agent searches, reads, and compiles a detailed report.

**Start a research task:**

```
deep_researcher_start {
  "query": "competitive landscape of AI code generation tools in 2026 — key players, pricing, technical approaches, market share"
}
```

**Check status (use the researchId from the start response):**

```
deep_researcher_check { "researchId": "abc123..." }
```

Poll `deep_researcher_check` until status is `completed`. The final response includes the full report.

---

## deep_search_exa

Single-call deep search: expands your query across multiple angles, searches, reads results, and returns a synthesized answer with grounded citations. Requires API key.

```
deep_search_exa { "query": "what are the leading approaches to multimodal RAG in production systems" }
```

Supports structured output via `outputSchema`:

```
deep_search_exa {
  "query": "top 10 aerospace companies by revenue",
  "type": "deep",
  "outputSchema": {
    "type": "object",
    "required": ["companies"],
    "properties": {
      "companies": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "revenue": { "type": "string" },
            "hq": { "type": "string" }
          }
        }
      }
    }
  }
}
```

---

## Query Craft

Exa is neural — it matches on meaning, not keywords. Write queries like you'd describe the ideal page to a colleague.

**Do:** "blog post about using embeddings for product recommendations at scale"
**Don't:** "embeddings product recommendations"

**Do:** "Stripe payments company San Francisco fintech"
**Don't:** "Stripe" (too ambiguous)

- Use `category` when you know the content type — it makes a big difference.
- For broader coverage, run 2-3 query variations in parallel and deduplicate results.
- For agentic workflows, use `highlights` instead of full `text` — it's 10x more token-efficient while keeping the relevant parts.

## Token Efficiency

| Content mode | When to use                                                                   |
| ------------ | ----------------------------------------------------------------------------- |
| `highlights` | Agent workflows, factual lookups, multi-step pipelines — most token-efficient |
| `text`       | Deep analysis, when you need full page context                                |
| `summary`    | Quick overviews, structured extraction with JSON schema                       |

Set `maxCharacters` on any content mode to control output size.

## When to Reach for Which Tool

| I need to...                        | Use                                                        |
| ----------------------------------- | ---------------------------------------------------------- |
| Quick web lookup                    | `web_search_exa`                                           |
| Research papers, academic search    | `web_search_advanced_exa` + `category: "research paper"`   |
| Company intel, competitive analysis | `company_research_exa` or advanced + `category: "company"` |
| Find people, candidates, experts    | `people_search_exa` or advanced + `category: "people"`     |
| Code examples, API docs             | `get_code_context_exa`                                     |
| Read a specific URL                 | `crawling_exa`                                             |
| Find pages similar to a URL         | `web_search_advanced_exa` with URL as query                |
| Recent news / tweets                | Advanced + `category: "news"` or `"tweet"` + `maxAgeHours` |
| Detailed research report            | `deep_researcher_start` → `deep_researcher_check`          |
| Quick answer with citations         | `deep_search_exa`                                          |

---

**Docs:** [exa.ai/docs](https://exa.ai/docs) — **Dashboard:** [dashboard.exa.ai](https://dashboard.exa.ai) — **Support:** support@exa.ai
