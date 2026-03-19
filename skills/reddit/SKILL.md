---
name: reddit
description: "Browse subreddits, search posts, and read Reddit discussions using the Reddit JSON API. Use when: 'what does reddit say about', 'search reddit for', 'top posts in r/', 'reddit opinions on', 'r/AskReddit thread about'. No API key needed for read-only. NOT for: posting, voting, or DMing (requires OAuth), or replacing dedicated Reddit apps."
homepage: https://www.reddit.com/dev/api
metadata: {"openclaw": {"emoji": "🤖", "requires": {"bins": ["curl"]}}}
---

# Reddit Skill

Browse subreddits, search posts, and read community discussions using Reddit's public JSON API. Works anonymously for read-only access.

## When to Use

✅ **USE this skill when:**

- "What does Reddit think about X?"
- "Top posts in r/MachineLearning this week"
- "Find Reddit threads about Python debugging"
- "What's the community consensus on [product/tool/topic]?"
- "Show me Ask Reddit posts about career advice"

❌ **DON'T use this skill when:**

- Posting, commenting, or voting → requires OAuth (ask user to authenticate)
- NSFW subreddits → avoid unless user explicitly confirms
- High-frequency scraping → use the official Reddit API instead

---

## API Basics

Reddit exposes a JSON API at `reddit.com/.../.json`:

```bash
USER_AGENT="OpenClaw/1.0 (skill:reddit)"

curl -s -A "$USER_AGENT" "https://www.reddit.com/..."
```

> **Always set a descriptive User-Agent** — Reddit blocks generic curl agents.

---

## Common Commands

### Top Posts in a Subreddit

```bash
SUBREDDIT="MachineLearning"
SORT="top"  # hot | new | top | rising
TIME="week" # hour | day | week | month | year | all

curl -s -A "OpenClaw/1.0" \
  "https://www.reddit.com/r/$SUBREDDIT/$SORT.json?t=$TIME&limit=10" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for post in data['data']['children']:
    p = post['data']
    print(f'[{p[\"score\"]}↑] {p[\"title\"]}')
    print(f'  💬 {p[\"num_comments\"]} comments | 🔗 https://reddit.com{p[\"permalink\"]}')
    print()
"
```

### Search Reddit Posts

```bash
QUERY="best python debugger 2025"
SUBREDDIT="all"  # or a specific subreddit like "learnpython"

curl -s -A "OpenClaw/1.0" \
  "https://www.reddit.com/r/$SUBREDDIT/search.json?q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$QUERY'))")&sort=relevance&limit=10&restrict_sr=false" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for post in data['data']['children']:
    p = post['data']
    print(f'[{p[\"score\"]}↑] {p[\"title\"]} (r/{p[\"subreddit\"]})')
    print(f'  https://reddit.com{p[\"permalink\"]}')
    print()
"
```

### Read a Thread (Post + Top Comments)

```bash
# Replace with actual post permalink
POST_URL="https://www.reddit.com/r/MachineLearning/comments/xyz123/example_post/"

curl -s -A "OpenClaw/1.0" "${POST_URL}.json?limit=10&depth=1" | \
  python3 -c "
import json, sys, html
data = json.load(sys.stdin)
post = data[0]['data']['children'][0]['data']
print(f'📌 {post[\"title\"]}')
print(f'Score: {post[\"score\"]} | Comments: {post[\"num_comments\"]}')
print(f'Body: {post.get(\"selftext\",\"\")[:400]}')
print()
print('=== Top Comments ===')
for c in data[1]['data']['children'][:5]:
    if c['kind'] == 't1':
        body = html.unescape(c['data'].get('body',''))
        print(f'@{c[\"data\"][\"author\"]} [{c[\"data\"][\"score\"]}↑]:')
        print(body[:300])
        print()
"
```

### Subreddit Info / About

```bash
SUBREDDIT="programming"
curl -s -A "OpenClaw/1.0" \
  "https://www.reddit.com/r/$SUBREDDIT/about.json" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)['data']
print(f'r/{d[\"display_name\"]} — {d[\"subscribers\"]:,} subscribers')
print(f'Description: {d[\"public_description\"]}')
"
```

### Get Posts by a Specific User

```bash
USERNAME="spez"
curl -s -A "OpenClaw/1.0" \
  "https://www.reddit.com/user/$USERNAME/submitted.json?limit=5" | \
  python3 -c "
import json, sys
for p in json.load(sys.stdin)['data']['children']:
    d = p['data']
    print(f'[{d[\"score\"]}↑] {d[\"title\"]} (r/{d[\"subreddit\"]})')
"
```

---

## Response Format for Users

When presenting Reddit results:

```
🤖 Reddit — r/MachineLearning · Top This Week

1. [2.4k↑] Title of the post
   💬 342 comments | r/MachineLearning
   🔗 https://reddit.com/r/.../...

2. [1.1k↑] Another post title
   ...
```

---

## Pagination

Reddit uses `after` cursors for pagination:

```bash
# Get next page using the 'after' value from previous response
curl -s -A "OpenClaw/1.0" \
  "https://www.reddit.com/r/$SUBREDDIT/hot.json?limit=25&after=t3_abc123"
```

---

## Notes

- Rate limit: ~60 requests/minute per IP (anonymous)
- Post IDs have the prefix `t3_` (posts), `t1_` (comments), `t5_` (subreddits)
- Some subreddits are private or NSFW-gated — handle 403 errors gracefully
- Use `&raw_json=1` to get unescaped HTML entities in the response
- CORS is blocked in browser; always use server-side curl
- For OAuth (posting/voting), user must provide: client ID, client secret, username, password
