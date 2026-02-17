# Research Search Query Templates

## X.com (Twitter) Queries

### AI Agents & Frameworks

```
"AI agents" OR "agent framework" OR "agentic AI" min_faves:10 -is:retweet
"multi-agent" OR "agent orchestration" OR "agent swarm" min_faves:5
"MCP server" OR "model context protocol" min_faves:5
```

### AI Coding Tools

```
"AI coding" OR "code agent" OR "vibe coding" OR "AI developer" min_faves:20
"Claude Code" OR "Cursor" OR "Copilot" OR "Windsurf" min_faves:10
"codex" OR "devin" OR "replit agent" min_faves:10
```

### Open Source AI

```
"open source LLM" OR "local AI" OR "self-hosted AI" min_faves:10
"ollama" OR "llama.cpp" OR "vllm" OR "mlx" min_faves:5
"fine-tuning" OR "LoRA" OR "GGUF" min_faves:10
```

### AI Automation & Workflows

```
"AI automation" OR "AI workflow" OR "n8n AI" OR "make.com AI" min_faves:10
"AI pipeline" OR "AI orchestration" OR "langchain" OR "llamaindex" min_faves:5
"AI API" OR "free API" OR "AI endpoint" min_faves:10
```

### AI Business & Monetization

```
"AI SaaS" OR "AI startup" OR "AI business" min_faves:50
"AI side project" OR "built with AI" OR "AI tool launch" min_faves:20
"ProductHunt AI" OR "AI launch" min_faves:10
```

### Voice & Media AI

```
"voice cloning" OR "text to speech" OR "AI voice" min_faves:10
"AI video" OR "AI image" OR "AI music" min_faves:20
"ElevenLabs" OR "Suno" OR "Kling" OR "Runway" min_faves:10
```

## HackerNews API Queries

Base URL: `https://hn.algolia.com/api/v1/search`

```
# Top AI stories (last 24h)
?query=AI+agents&tags=story&numericFilters=created_at_i>NOW-86400&hitsPerPage=20

# AI coding tools
?query=AI+coding+tool&tags=story&numericFilters=points>10,created_at_i>NOW-86400

# LLM discussions
?query=LLM+open+source&tags=story&numericFilters=points>20,created_at_i>NOW-604800

# Agent frameworks
?query=agent+framework&tags=story&numericFilters=created_at_i>NOW-604800
```

Note: Replace `NOW` with actual Unix timestamp. `86400` = 24h, `604800` = 7 days.

## Reddit Queries (via web_search)

```
# r/MachineLearning
site:reddit.com/r/MachineLearning "AI agents" OR "new tool"

# r/LocalLLaMA
site:reddit.com/r/LocalLLaMA "new model" OR "benchmark" OR "release"

# r/artificial
site:reddit.com/r/artificial "breakthrough" OR "new AI"

# r/selfhosted
site:reddit.com/r/selfhosted "AI" OR "LLM" OR "local"
```

## GitHub Trending

```
# Daily trending (all languages, AI topic)
https://github.com/trending?since=daily&spoken_language_code=en

# Python AI repos
https://github.com/trending/python?since=daily

# TypeScript AI repos
https://github.com/trending/typescript?since=daily
```

## ArXiv Queries (via web_search)

```
site:arxiv.org "AI agents" 2026
site:arxiv.org "multi-agent" OR "agent framework" 2026
site:arxiv.org "large language model" "tool use" 2026
site:arxiv.org "code generation" OR "program synthesis" 2026
```

## Newsletter & Blog Sources

| Source            | URL                             | Focus                 |
| ----------------- | ------------------------------- | --------------------- |
| The Batch         | deeplearning.ai/the-batch       | Andrew Ng's AI weekly |
| AI News           | artificialintelligence-news.com | Industry news         |
| Papers With Code  | paperswithcode.com              | SOTA papers           |
| Hugging Face Blog | huggingface.co/blog             | Open source AI        |
| Simon Willison    | simonwillison.net               | AI tools & LLMs       |
| Latent Space      | latent.space                    | AI engineering        |

## Freshness Filters (web_search)

| Filter           | Meaning        | Use Case       |
| ---------------- | -------------- | -------------- |
| `freshness:"pd"` | Past day (24h) | Daily scan     |
| `freshness:"pw"` | Past week      | Weekly digest  |
| `freshness:"pm"` | Past month     | Monthly review |
| `freshness:"py"` | Past year      | Annual trends  |
