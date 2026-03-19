---
name: readwise
description: "Manage reading highlights, books, and articles via the Readwise API. Use when: listing or searching highlights, adding new highlights, reviewing today's review queue, tagging or noting passages. NOT for: purchasing ebooks, managing Kindle library directly, or reading full article text."
homepage: https://readwise.io/api_deets
metadata: {"openclaw": {"emoji": "📚", "requires": {"env": ["READWISE_ACCESS_TOKEN"]}, "primaryEnv": "READWISE_ACCESS_TOKEN"}}
---

# Readwise Skill

Interact with the Readwise API to manage your reading highlights, books, articles, and daily review queue.

## Setup

1. Get your access token at: https://readwise.io/access_token
2. Set the environment variable:

```bash
export READWISE_ACCESS_TOKEN="your_token_here"
```

Or store it:

```bash
echo "your_token_here" > ~/.config/readwise/token
export READWISE_ACCESS_TOKEN=$(cat ~/.config/readwise/token)
```

## API Basics

All requests use:

```bash
TOKEN="$READWISE_ACCESS_TOKEN"
BASE="https://readwise.io/api/v2"

curl -s -H "Authorization: Token $TOKEN" "$BASE/..."
```

---

## Common Operations

### List Recent Highlights

```bash
# Latest 20 highlights
curl -s -H "Authorization: Token $TOKEN" \
  "$BASE/highlights/?page_size=20" | \
  python3 -c "import json,sys; [print(f'{h[\"id\"]}: {h[\"text\"][:80]}') for h in json.load(sys.stdin)['results']]"
```

### Search Highlights by Keyword

```bash
# Search highlights containing a word
curl -s -H "Authorization: Token $TOKEN" \
  "$BASE/highlights/?search=focus&page_size=10" | \
  python3 -c "import json,sys; [print(f'{h[\"text\"][:100]}') for h in json.load(sys.stdin)['results']]"
```

### Get Today's Daily Review

```bash
# Fetch today's review queue
curl -s -H "Authorization: Token $TOKEN" \
  "$BASE/review/" | \
  python3 -c "import json,sys; [print(f'📖 {h[\"highlight\"][\"text\"][:120]}') for h in json.load(sys.stdin)['highlights']]"
```

### List Books / Sources

```bash
# All books/sources in your library
curl -s -H "Authorization: Token $TOKEN" \
  "$BASE/books/?page_size=20" | \
  python3 -c "import json,sys; [print(f'{b[\"id\"]} | {b[\"title\"]} by {b[\"author\"]}') for b in json.load(sys.stdin)['results']]"
```

### Add a New Highlight

```bash
curl -s -X POST -H "Authorization: Token $TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE/highlights/" \
  -d '{
    "highlights": [{
      "text": "The highlight text you want to save",
      "title": "Book or Article Title",
      "author": "Author Name",
      "source_type": "api"
    }]
  }'
```

### Update a Highlight (Add Note or Tag)

```bash
# Add a note to highlight ID 12345
curl -s -X PATCH -H "Authorization: Token $TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE/highlights/12345/" \
  -d '{"note": "This reminds me of Feynman'"'"'s approach to learning."}'
```

### Export All Highlights (EPUB/JSON)

```bash
# Export full highlights library as JSON
curl -s -H "Authorization: Token $TOKEN" \
  "$BASE/export/" | python3 -m json.tool > ~/readwise_export.json
echo "Exported to ~/readwise_export.json"
```

---

## Highlight Object Fields

| Field | Description |
|---|---|
| `id` | Unique highlight ID |
| `text` | The highlighted passage |
| `note` | Your personal note on it |
| `location` | Position in source document |
| `highlighted_at` | ISO timestamp |
| `book_id` | Source document ID |
| `tags` | Array of tag objects |

---

## Notes

- Rate limit: 20 requests/minute for most endpoints
- The `/review/` endpoint gives the daily spaced-repetition queue
- `page_size` max is 1000 for most list endpoints
- Use `cursor` pagination for large libraries: `?page_size=1000&cursor=<next_cursor>`
- Readwise syncs from Kindle, Instapaper, Pocket, Twitter, and more automatically
