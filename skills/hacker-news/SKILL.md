---
name: hacker-news
description: "Browse Hacker News top/new/best stories, search HN posts and comments, or fetch a specific submission. Use when: 'what's on HN today', 'search HN for', 'top hacker news stories', 'show me HN comments on', 'find HN discussion about'. No API key needed. NOT for: posting comments (HN has no write API), aggregating non-HN tech news, or stock tickers."
homepage: https://hn.algolia.com/api
metadata: {"openclaw": {"emoji": "🗞️", "requires": {"bins": ["curl"]}}}
---

# Hacker News Skill

Read top stories, search discussions, and fetch HN comments — all via the free Algolia HN API and the official Firebase HN API. No login required.

## When to Use

✅ **USE this skill when:**

- "What's trending on Hacker News?"
- "Find HN discussions about Rust / LLMs / startups"
- "Show me the comments on that HN post"
- "What's the HN community saying about [topic]?"
- "Show me Ask HN posts about career advice"

❌ **DON'T use this skill when:**

- Writing or deleting HN comments (no write API)
- Need non-HN tech news → use a news skill
- User wants to actually browse with a GUI → open browser

---

## API Overview

**Algolia Search API** (search, filters):
```
Base: https://hn.algolia.com/api/v1
```

**Firebase HN API** (live front page, top stories):
```
Base: https://hacker-news.firebaseio.com/v0
```

---

## Common Commands

### Top Stories Right Now

```bash
# Get top 10 story IDs then fetch each title
curl -s "https://hacker-news.firebaseio.com/v0/topstories.json" | \
  python3 -c "
import json, sys, urllib.request
ids = json.load(sys.stdin)[:10]
for i, sid in enumerate(ids, 1):
    item = json.loads(urllib.request.urlopen(f'https://hacker-news.firebaseio.com/v0/item/{sid}.json').read())
    print(f'{i}. [{item.get(\"score\",0)}pts] {item.get(\"title\",\"?\")} — {item.get(\"url\",\"text post\")}')
"
```

### New Stories

```bash
curl -s "https://hacker-news.firebaseio.com/v0/newstories.json" | \
  python3 -c "
import json, sys, urllib.request
ids = json.load(sys.stdin)[:10]
for i, sid in enumerate(ids, 1):
    item = json.loads(urllib.request.urlopen(f'https://hacker-news.firebaseio.com/v0/item/{sid}.json').read())
    print(f'{i}. {item.get(\"title\",\"?\")} ({item.get(\"url\",\"text\")[:60]})')
"
```

### Search HN Stories by Keyword

```bash
# Search stories mentioning a keyword (last 24h)
QUERY="large language models"
curl -s "https://hn.algolia.com/api/v1/search?query=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$QUERY'))")&tags=story&hitsPerPage=10" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for h in data['hits']:
    print(f'[{h.get(\"points\",0)}pts] {h[\"title\"]}')
    print(f'  https://news.ycombinator.com/item?id={h[\"objectID\"]}')
"
```

### Search Comments Only

```bash
QUERY="rust vs go performance"
curl -s "https://hn.algolia.com/api/v1/search?query=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$QUERY'))")&tags=comment&hitsPerPage=5" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for h in data['hits']:
    print(f'--- Comment by {h.get(\"author\",\"?\")} ---')
    print(h.get('comment_text','')[:300])
    print()
"
```

### Fetch a Specific Story + Top Comments

```bash
# Replace with actual HN item ID
ITEM_ID=43219876
curl -s "https://hacker-news.firebaseio.com/v0/item/$ITEM_ID.json" | \
  python3 -c "
import json, sys, urllib.request
item = json.load(sys.stdin)
print(f'Title: {item.get(\"title\")}')
print(f'Score: {item.get(\"score\")} | Comments: {item.get(\"descendants\",0)}')
print(f'URL: {item.get(\"url\",\"text post\")}')
print()
# Top 5 comments
for cid in item.get('kids',[])[:5]:
    c = json.loads(urllib.request.urlopen(f'https://hacker-news.firebaseio.com/v0/item/{cid}.json').read())
    if c and not c.get('deleted'):
        print(f'@{c.get(\"by\",\"?\")} [{c.get(\"time\")}]:')
        import html
        print(html.unescape(c.get('text',''))[:300])
        print()
"
```

### Ask HN / Show HN Stories

```bash
# Ask HN posts
curl -s "https://hn.algolia.com/api/v1/search?query=&tags=ask_hn&hitsPerPage=10" | \
  python3 -c "
import json, sys
for h in json.load(sys.stdin)['hits']:
    print(f'[{h.get(\"points\",0)}] {h[\"title\"]} ({h.get(\"num_comments\",0)} comments)')
"
```

---

## Response Format Tips

When presenting HN stories to the user, use this format:

```
🗞️ Hacker News — Top Stories

1. [250pts] Title of the story
   🔗 https://example.com | 💬 143 comments
   https://news.ycombinator.com/item?id=XXXXXXX

2. [180pts] Another story title
   ...
```

---

## Notes

- The Algolia API supports `dateRange` filters: `last_24h`, `pastWeek`, `pastMonth`, `custom`
- No rate limits documented, but be reasonable (don't spam hundreds of requests)
- Comments contain HTML; strip tags or use `html.unescape()` before displaying
- HN item IDs are monotonically increasing — higher = more recent
- `best stories` endpoint: `https://hacker-news.firebaseio.com/v0/beststories.json`
