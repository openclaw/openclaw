# Daily News Summary Example

This is a real-world example of how the naver-news skill is used for automated daily news summaries.

## Workflow Overview

1. **Collect** news articles by category using time filters
2. **Select** top articles based on priority criteria
3. **Format** as a concise summary for daily consumption

## Step 1: Collect News Articles

Collect sufficient recent articles using auto-pagination:

### IT News (Target: 30+ articles → Select 3)

```bash
python3 scripts/search_news.py "인공지능 IT" \
  --display 50 \
  --sort sim \
  --after "2026-01-31T09:00:00+09:00" \
  --min-results 30 \
  --json
```

### Game News (Target: 30+ articles → Select 3)

```bash
python3 scripts/search_news.py "게임" \
  --display 50 \
  --sort sim \
  --after "2026-01-31T09:00:00+09:00" \
  --min-results 30 \
  --json
```

### General News (Target: 50+ articles → Select 5)

```bash
python3 scripts/search_news.py "경제 정치 외교" \
  --display 50 \
  --sort sim \
  --after "2026-01-31T09:00:00+09:00" \
  --min-results 50 \
  --json
```

### Why These Parameters Work

- `--sort sim`: Prioritizes **relevance** over recency (finds most important recent news)
- `--after`: Filters out articles published before the last run (no duplicates)
- `--min-results`: Auto-fetches multiple pages if time filter reduces results
- `--display 50`: Balances API efficiency with pagination needs
- `--json`: Enables programmatic processing for selection

## Step 2: Selection Criteria

From collected articles, select only the most important ones:

### IT News Priority

**High Priority:**
- AI/ML technological advances, new model releases
- Major product launches from key tech companies
- IT policy and regulatory changes
- Security incidents, large-scale cyberattacks
- Cloud/SaaS infrastructure news

**Low Priority:**
- Routine personnel announcements (except C-level)
- Minor company activities
- Repetitive earnings reports

### Game News Priority

**High Priority:**
- Major game releases, large-scale updates
- Industry policy and regulatory changes
- Esports tournaments, league news
- M&A deals, strategic partnerships
- Global hit records, awards

**Low Priority:**
- Small patches, event announcements
- Indie game releases (except award-winners)
- Marketing-focused articles

### General News Priority

**High Priority:**
- Economic policy affecting Korea (interest rates, exchange rates)
- Diplomatic summits, international relations
- Global economic issues (US/China/Japan policy)
- Major legislation, policy announcements
- International conflicts, security issues
- Major corporate announcements

**Low Priority:**
- Local news without national impact
- Routine events, commemorations
- Entertainment, sports (except historic events)

### Selection Guidelines

1. **Timeliness**: Recent events take priority
2. **Impact**: News affecting many people
3. **Novelty**: First announcements, exclusive reports
4. **Continuity**: New developments in ongoing major issues

## Step 3: Output Format

Format selected articles as a concise summary:

```markdown
# 🌅 Morning News Summary - January 31, 2026

## 🤖 IT News

### 1. [Article Title]
Key summary (1-2 sentences, must explain why it matters)
Published: 09:30 | Source: <https://example.com>

### 2. [Article Title]
Key summary...
Published: 10:15 | Source: <https://example.com>

### 3. [Article Title]
Key summary...
Published: 11:20 | Source: <https://example.com>

***

## 🎮 Game News

### 1. [Article Title]
Key summary...
Published: 09:00 | Source: <https://example.com>

### 2. [Article Title]
Key summary...
Published: 10:30 | Source: <https://example.com>

### 3. [Article Title]
Key summary...
Published: 11:00 | Source: <https://example.com>

***

## 📰 General News (Economy, Politics, Diplomacy)

### 1. [Article Title]
Key summary...
Published: 08:00 | Source: <https://example.com>

### 2. [Article Title]
Key summary...
Published: 09:15 | Source: <https://example.com>

### 3. [Article Title]
Key summary...
Published: 10:00 | Source: <https://example.com>

### 4. [Article Title]
Key summary...
Published: 10:45 | Source: <https://example.com>

### 5. [Article Title]
Key summary...
Published: 11:30 | Source: <https://example.com>

***

## 🔍 Summary
Concise overview of today's key trends and insights...
```

## Best Practices

1. **Include links**: Always provide source URLs (wrapped in `<>` to prevent embeds)
2. **Explain importance**: Each article should mention *why* it matters
3. **Be concise**: 1-2 sentences per article, focus on essentials
4. **Simplify technical terms**: Make content accessible
5. **No process talk**: Deliver results only, skip explanations like "I collected..." or "I will select..."

## Automation Integration

This workflow can be automated using OpenClaw's cron system:

- **Schedule**: Run at a specific time daily (e.g., 9:00 AM)
- **State tracking**: Store last execution time in `memory/news-state.json`
- **Configuration**: Define collection and selection criteria in prompt files
- **Output**: Format and deliver summary message automatically

Example `memory/news-state.json`:
```json
{
  "lastRunAt": "2026-01-31T09:00:00+09:00"
}
```

Read this file at the start of each run and use the timestamp as the `--after` parameter to avoid duplicate articles. After completing the summary, update the file with the current timestamp.
