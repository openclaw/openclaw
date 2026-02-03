---
name: reddit-insights
description: |
  Search and analyze Reddit content using semantic AI search via reddit-insights.com MCP server.
  Use when you need to: (1) Find user pain points and frustrations for product ideas, (2) Discover niche markets or underserved needs, (3) Research what people really think about products/topics, (4) Find content inspiration from real discussions, (5) Analyze sentiment and trends on Reddit, (6) Validate business ideas with real user feedback.
  Triggers: reddit search, find pain points, market research, user feedback, what do people think about, reddit trends, niche discovery, product validation.
---

# Reddit Insights MCP

Semantic search across millions of Reddit posts. Unlike keyword search, this understands intent and meaning.

## Setup

### 1. Get API Key (free tier available)
1. Sign up at https://reddit-insights.com
2. Go to Settings → API
3. Copy your API key

### 2. Install MCP Server

**For Claude Desktop** - add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "reddit-insights": {
      "command": "npx",
      "args": ["-y", "reddit-insights-mcp"],
      "env": {
        "REDDIT_INSIGHTS_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

**For Clawdbot** - add to `config/mcporter.json`:
```json
{
  "mcpServers": {
    "reddit-insights": {
      "command": "npx reddit-insights-mcp",
      "env": {
        "REDDIT_INSIGHTS_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

**Verify installation:**
```bash
mcporter list reddit-insights
```

## Available Tools

| Tool | Purpose | Key Params |
|------|---------|------------|
| `reddit_search` | Semantic search across posts | `query` (natural language), `limit` (1-100) |
| `reddit_list_subreddits` | Browse available subreddits | `page`, `limit`, `search` |
| `reddit_get_subreddit` | Get subreddit details + recent posts | `subreddit` (without r/) |
| `reddit_get_trends` | Get trending topics | `filter` (latest/today/week/month), `category` |

## Performance Notes

- **Response time:** 12-25 seconds (varies by query complexity)
  - Simple queries: ~12-15s
  - Complex semantic queries: ~17-20s
  - Heavy load periods: up to 25s
- **Best results:** Specific products, emotional language, comparison questions
- **Weaker results:** Abstract concepts, non-English queries, generic business terms
- **Sweet spot:** Questions a real person would ask on Reddit

## Best Use Cases (Tested)

| Use Case | Effectiveness | Why |
|----------|--------------|-----|
| Product comparisons (A vs B) | ⭐⭐⭐⭐⭐ | Reddit loves debates |
| Tool/app recommendations | ⭐⭐⭐⭐⭐ | High-intent discussions |
| Side hustle/money topics | ⭐⭐⭐⭐⭐ | Engaged communities |
| Pain point discovery | ⭐⭐⭐⭐ | Emotional posts rank well |
| Health questions | ⭐⭐⭐⭐ | Active health subreddits |
| Technical how-to | ⭐⭐⭐ | Better to search specific subreddits |
| Abstract market research | ⭐⭐ | Too vague for semantic search |
| Non-English queries | ⭐ | Reddit is English-dominant |

## Query Strategies (Tested with Real Data)

### ✅ Excellent Queries (relevance 0.70+)

**Product Comparisons** (best results!):
```
"Notion vs Obsidian for note taking which one should I use"
→ Relevance: 0.72-0.81 | Found: Detailed comparison discussions, user experiences

"why I switched from Salesforce to HubSpot honest experience"  
→ Relevance: 0.70-0.73 | Found: Migration stories, feature comparisons
```

**Side Hustle/Money Topics:**
```
"side hustle ideas that actually make money not scams"
→ Relevance: 0.70-0.77 | Found: Real experiences, specific suggestions
```

**Niche App Research:**
```
"daily horoscope apps which one is accurate and why"
→ Relevance: 0.67-0.72 | Found: App recommendations, feature requests
```

### ✅ Good Queries (relevance 0.60-0.69)

**Pain Point Discovery:**
```
"I hate my current CRM it is so frustrating"
→ Relevance: 0.60-0.64 | Found: Specific CRM complaints, feature wishlists

"cant sleep at night tried everything what actually works"
→ Relevance: 0.60-0.63 | Found: Sleep remedies discussions, medical advice seeking
```

**Tool Evaluation:**
```
"AI tools that actually save time not just hype"
→ Relevance: 0.64-0.65 | Found: Real productivity gains, tool recommendations
```

### ❌ Weak Queries (avoid these patterns)

**Too Abstract:**
```
"business opportunity growth potential"
→ Relevance: 0.52-0.58 | Returns unrelated generic posts
```

**Non-English:**
```
"学习编程最好的方法" (Chinese)
→ Relevance: 0.45-0.51 | Reddit is English-dominant, poor cross-lingual results
```

### Query Formula Cheat Sheet

| Goal | Pattern | Relevance |
|------|---------|-----------|
| Compare products | "[Product A] vs [Product B] which should I use" | 0.70-0.81 |
| Find switchers | "why I switched from [A] to [B]" | 0.70-0.73 |
| Money/hustle topics | "[topic] that actually [works/makes money] not [scam/hype]" | 0.70-0.77 |
| App recommendations | "[category] apps which one is [accurate/best] and why" | 0.67-0.72 |
| Pain points | "I hate my current [tool] it is so [frustrating/slow]" | 0.60-0.64 |
| Solutions seeking | "[problem] tried everything what actually works" | 0.60-0.63 |

## Response Fields

Each result includes:
- `title`, `content` - Post text
- `subreddit` - Source community  
- `upvotes`, `comments` - Engagement metrics
- `relevance` (0-1) - Semantic match score (0.5+ is good, 0.6+ is strong)
- `sentiment` - Discussion/Q&A/Story Sharing/Original Content/News
- `url` - Direct Reddit link

**Example response:**
```json
{
  "id": "1oecf5e",
  "title": "Trying to solve the productivity stack problem",
  "content": "The perfect productivity app doesn't exist. No single app can do everything well, so we use a stack of apps. But this creates another problem: multi app fragmentation...",
  "subreddit": "productivityapps",
  "upvotes": 1,
  "comments": 0,
  "relevance": 0.631,
  "sentiment": "Discussion",
  "url": "https://reddit.com/r/productivityapps/comments/1oecf5e"
}
```

## Tips

1. **Natural language works best** - Ask questions like a human would
2. **Include context** - "for small business" or "as a developer" improves results
3. **Combine emotion words** - "frustrated", "love", "hate", "wish" find stronger opinions
4. **Filter by engagement** - High upvotes/comments = validated pain points
5. **Check multiple subreddits** - Same topic discussed differently in r/startups vs r/smallbusiness

## Example Workflows

**Find SaaS opportunity:**
1. `reddit_search`: "frustrated with project management tools for remote teams"
2. Filter results with high engagement
3. Identify recurring complaints → product opportunity

**Validate idea:**
1. `reddit_search`: "[your product category] recommendations"
2. See what alternatives people mention
3. Note gaps in existing solutions

**Content research:**
1. `reddit_get_subreddit`: Get posts from target community
2. `reddit_search`: Find specific questions/discussions
3. Create content answering real user questions
