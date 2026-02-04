name: dj-research
description: Research a topic using web search with budget-controlled depth.
metadata:
  {
    "openclaw":
      {
        "emoji": "🔍",
        "requires": { "env": ["NOTION_API_KEY"] },
        "commands":
          [
            { "name": "research", "description": "Research a topic" },
            { "name": "research save", "description": "Research and save to Notion" },
          ],
      },
  }
---

# dj-research

Research a topic using web search and fetch, with budget-aware depth limits and optional Notion persistence.

## Usage

```
/research <query>
/research save <query>    # Force save to Notion Research Radar
```

## How It Works

1. Use `web_search` to find relevant sources
2. Use `web_fetch` to retrieve content from top results
3. Synthesize findings into structured output
4. Optionally save to Notion Research Radar database

## Budget Profiles

Research depth is automatically bounded by the active budget profile:

| Profile | Max Searches | Max Fetches | Max Chars/Fetch | Notes |
|---------|-------------|-------------|-----------------|-------|
| **cheap** | 1 | 2 | 10,000 | Quick lookup only |
| **normal** | 2 | 5 | 50,000 | Standard research |
| **deep** | 5 | 10 | 100,000 | Must be explicitly armed |

**Important**: Browser is NOT used unless explicitly requested. Prefer `web_search` + `web_fetch` for efficiency.

## Implementation

When `/research <query>` is invoked:

### Step 1: Check Budget Profile

```typescript
const profile = await getBudgetProfile();
const limits = RESEARCH_LIMITS[profile];

if (profile === "cheap") {
  // Warn about limited depth
  notify("Running in cheap mode - results may be limited");
}
```

### Step 2: Web Search

```typescript
// Perform web search
const searchResults = await web_search(query, { maxResults: limits.maxSearches * 5 });

// Select top results to fetch
const toFetch = searchResults.slice(0, limits.maxFetches);
```

### Step 3: Fetch Content

```typescript
const fetchedContent = [];
for (const result of toFetch) {
  // Check cache first
  const cacheKey = hashCacheKey(query, result.url);
  const cached = await checkCache(cacheKey);

  if (cached) {
    fetchedContent.push(cached);
    continue;
  }

  // Fetch with char limit
  const content = await web_fetch(result.url, { maxChars: limits.maxCharsPerFetch });
  fetchedContent.push(content);

  // Cache for future requests
  await setCache(cacheKey, content);
}
```

### Step 4: Synthesize Output

Format findings as:

```markdown
## Research: <query>

### Key Findings
- Finding 1 with key insight
- Finding 2 with supporting data
- Finding 3 with relevant context
- [5-10 bullet points total]

### Sources
1. [Source Title](URL) - Brief description
2. [Source Title](URL) - Brief description
...

### Next Actions
- [ ] Suggested follow-up action 1
- [ ] Suggested follow-up action 2

### Uncertainty / Assumptions
- Area where information was incomplete or conflicting
- Assumption made due to lack of data
```

### Step 5: Save to Notion (if requested)

When "save" is requested or `DJ_RESEARCH_AUTO_SAVE=true`:

```typescript
const researchEntry = {
  Query: query,
  Summary: synthesizedFindings,
  Sources: sourceUrls.join(", "),
  Profile: profile,
  CacheKey: cacheKey,
  SearchedAt: new Date().toISOString(),
};

await notion.pages.create({
  parent: { database_id: DJ_NOTION_RESEARCH_RADAR_DB },
  properties: formatNotionProperties(researchEntry),
});
```

## Caching

To avoid repeated fetch spend on the same query:

1. Generate cache key: `sha256(query + sorted(urls))`
2. Check `~/.openclaw/cache/research/<cacheKey>.json`
3. If cache hit and not expired (default: 24h), return cached results
4. If cache miss or expired, perform fresh research

Cache files contain:
```json
{
  "query": "original query",
  "urls": ["https://..."],
  "content": ["..."],
  "synthesized": "...",
  "cachedAt": "ISO timestamp",
  "expiresAt": "ISO timestamp"
}
```

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `DJ_NOTION_RESEARCH_RADAR_DB` | - | Notion database ID for Research Radar |
| `DJ_RESEARCH_AUTO_SAVE` | `false` | Auto-save all research to Notion |
| `DJ_RESEARCH_CACHE_TTL_HOURS` | `24` | Cache expiration time |
| `DJ_RESEARCH_CHEAP_MAX_SEARCHES` | `1` | Max searches in cheap mode |
| `DJ_RESEARCH_CHEAP_MAX_FETCHES` | `2` | Max fetches in cheap mode |
| `DJ_RESEARCH_NORMAL_MAX_SEARCHES` | `2` | Max searches in normal mode |
| `DJ_RESEARCH_NORMAL_MAX_FETCHES` | `5` | Max fetches in normal mode |
| `DJ_RESEARCH_DEEP_MAX_SEARCHES` | `5` | Max searches in deep mode |
| `DJ_RESEARCH_DEEP_MAX_FETCHES` | `10` | Max fetches in deep mode |

## Citation Rules

1. **Always cite sources** - Every factual claim must link to a source
2. **Use original URLs** - Don't use Google cache or AMP links
3. **Note access date** - For time-sensitive topics
4. **Flag paywalled content** - Note if content was partially inaccessible

## Examples

### Quick Lookup (cheap profile)
```
/research "OpenAI GPT-5 release date"
```
Returns: Quick 2-3 bullet summary from 1-2 sources.

### Standard Research (normal profile)
```
/research "AI regulation EU AI Act 2024"
```
Returns: 5-7 bullet synthesis with 3-5 sources.

### Deep Dive (deep profile)
```
/budget deep
/research "quantum computing timeline commercial viability"
```
Returns: Comprehensive 8-10 bullet analysis with 8-10 sources.

### Save to Notion
```
/research save "podcast guest research: Jane Smith AI ethics"
```
Returns: Research output + confirmation of Notion save.

## Notion Research Radar Schema

| Property | Type | Description |
|----------|------|-------------|
| Query | Title | Original search query |
| Summary | Rich Text | Synthesized findings |
| Sources | URL | Comma-separated source URLs |
| Profile | Select | Budget profile used |
| Status | Select | New, Reviewed, Archived |
| Tags | Multi-Select | Topic tags |
| SearchedAt | Date | When research was performed |
| ReviewedAt | Date | When DJ reviewed |

## Notes

- Research is non-destructive (read-only web operations)
- BudgetGovernor tracks `web_search` and `web_fetch` tool calls
- Cache prevents repeated API spend on identical queries
- Notion saves create audit trail for reference
