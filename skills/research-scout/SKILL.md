---
name: research-scout
description: Research agent that scans X.com (Twitter), tech blogs, HackerNews, Reddit, and AI newsletters for the latest AI hacks, tools, blueprints, and breakthroughs. Use when the user wants to find trending AI topics, discover new tools, monitor competitors, scan social media for AI news, or compile research digests. Triggers for "what's new in AI", "scan X.com", "find latest AI tools", "research digest", "trending AI topics", or "scout for new hacks".
metadata: { "openclaw": { "emoji": "🔍" } }
---

# Research Scout

Systematic AI research agent. Scans multiple sources for the latest AI tools, hacks, blueprints, and breakthroughs.

For search query templates, see [references/search-queries.md](references/search-queries.md).

## Sources (Priority Order)

| Source              | Method                          | Best For                                |
| ------------------- | ------------------------------- | --------------------------------------- |
| **X.com**           | `web_search` + `web_fetch`      | Real-time AI discussions, tool launches |
| **HackerNews**      | `web_fetch` hn.algolia.com API  | Deep tech discussions, new repos        |
| **Reddit**          | `web_search` site:reddit.com    | Community reviews, comparisons          |
| **GitHub Trending** | `web_fetch` github.com/trending | New open-source AI tools                |
| **AI Newsletters**  | `web_fetch` specific URLs       | Curated AI news                         |
| **ArXiv**           | `web_search` site:arxiv.org     | Research papers                         |

## Workflow

### 1. Quick Scan (5 minutes)

Fast sweep of top sources for breaking AI news:

```
# X.com - latest AI agent discussions
web_search query:"AI agents site:x.com" freshness:"pd"
web_search query:"new AI tool launch site:x.com" freshness:"pd"

# HackerNews - top AI stories
web_fetch url:"https://hn.algolia.com/api/v1/search?query=AI+agents&tags=story&numericFilters=created_at_i>NOW-86400" prompt:"Extract title, URL, and points for top 10 stories"

# GitHub Trending
web_fetch url:"https://github.com/trending?since=daily&spoken_language_code=en" prompt:"List trending AI/ML repositories with descriptions and star counts"
```

### 2. Deep Research (15-30 minutes)

Thorough multi-source investigation on a specific topic:

```
# Phase 1: Broad search
web_search query:"<topic> AI 2026"
web_search query:"<topic> site:x.com" freshness:"pw"
web_search query:"<topic> site:reddit.com/r/MachineLearning OR site:reddit.com/r/LocalLLaMA"

# Phase 2: Deep dive on promising results
web_fetch url:"<promising-url>" prompt:"Extract key insights, tools mentioned, and actionable takeaways"

# Phase 3: Related tools & repos
web_search query:"<tool-name> github repository"
web_fetch url:"<github-repo>" prompt:"Extract README summary, features, and installation instructions"

# Phase 4: Compile findings
# Save to workspace for other agents to use
```

### 3. Automated Daily Digest

Set up via cron for daily research:

```
cron action:"add" name:"AI Research Digest" schedule:"0 8 * * *" tz:"Europe/Berlin" session:"isolated" message:"Run a full research scan: 1) Check X.com for trending AI agent discussions 2) Check HackerNews for top AI stories 3) Check GitHub trending for new AI repos 4) Compile findings into ~/workspace/research/digest-YYYY-MM-DD.md with sections: Breaking, Tools, Papers, Discussions. End with 3 actionable recommendations for improving our system." announce:true channel:"last"
```

## Output Format

### Research Digest Template

```markdown
# AI Research Digest - YYYY-MM-DD

## Breaking News

- [Title](url) - One-line summary
- [Title](url) - One-line summary

## New Tools & Repos

- **[Tool Name](url)** - What it does, why it matters
  - Stars: X | Language: Y | License: Z

## Key Discussions (X.com)

- [@handle](url): "Key quote or insight"
- [@handle](url): "Key quote or insight"

## Papers & Research

- [Paper Title](arxiv-url) - Plain-language summary

## Actionable Recommendations

1. **[Action]** - Why and how it improves our system
2. **[Action]** - Why and how it improves our system
3. **[Action]** - Why and how it improves our system
```

## X.com Scanning Strategy

### Search Patterns

```
# AI agent frameworks and tools
"AI agents" OR "agent framework" OR "agentic" filter:links min_faves:10

# Coding AI tools
"AI coding" OR "code assistant" OR "vibe coding" filter:links min_faves:20

# Local AI / self-hosted
"local AI" OR "self-hosted" OR "ollama" OR "open source LLM"

# Automation and workflows
"AI automation" OR "n8n" OR "make.com" OR "zapier AI"

# AI business/monetization
"AI SaaS" OR "AI side hustle" OR "AI business" min_faves:50
```

### Key Accounts to Monitor

```
@kaborobot @_akhaliq @roaborot @_philschmid @hwchase17
@langaborot @llamaindex @OpenAI @anthropicai @GoogleAI
@huggingface @weights_biases @modal_labs @replaborot
```

## Resource-Efficient Scanning

- Use `web_search` instead of `browser` for most queries (faster, less RAM)
- Only use `browser` tool for JavaScript-heavy pages that `web_fetch` can't parse
- Limit concurrent web fetches to 3
- Cache results in workspace files to avoid re-fetching
- Set `freshness:"pd"` (past day) for daily scans, `freshness:"pw"` (past week) for weekly deep dives

## Integration with Other Agents

After research, hand off to:

- **Creator agent**: "Write a blog post based on ~/workspace/research/digest.md"
- **Commander**: "Here are 3 recommendations. Which should we implement?"
- **Deployer**: "Found a new tool at <repo>. Clone and test it."

## Proposal Format

When finding actionable items, submit proposals:

```
[PROPOSAL] Found: <what>
Source: <url>
Relevance: <why it matters for our system>
Action: <what we should do>
Effort: <low/medium/high>
```
