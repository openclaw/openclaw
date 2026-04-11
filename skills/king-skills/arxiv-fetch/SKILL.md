---
name: king_skill_arxiv_fetch
description: Fetch and search arXiv papers via API. Use instead of recalling paper contents from memory.
metadata:
  {
    "openclaw":
      {
        "emoji": "📚",
        "requires": { "bins": ["python3", "pip"] },
        "install":
          [
            {
              "id": "pip",
              "kind": "pip",
              "packages": ["feedparser", "requests"],
              "label": "Install feedparser and requests (pip)",
            },
          ],
        "os": ["darwin", "linux", "win32"],
      },
  }
---

# arXiv Fetch

Fetch and search arXiv papers via API.

## When to Use

**USE this skill when:**
- Searching for academic papers
- Finding citations
- Looking up related work
- Fetching paper abstracts
- Verifying author publications

**DON'T use when:**
- Full text PDF parsing is needed (use `king_skill_doc_transform`)
- The paper is not on arXiv

## Commands

```python
import urllib.request
import urllib.parse
import feedparser

def arxiv_search(query: str, max_results: int = 5) -> list[dict]:
    base = 'https://export.arxiv.org/api/query?'
    params = urllib.parse.urlencode({
        'search_query': query,
        'max_results': max_results,
        'sortBy': 'relevance',
    })
    req = urllib.request.Request(
        base + params,
        headers={'User-Agent': 'OpenClaw-Agent/2.0'}
    )
    data = urllib.request.urlopen(req, timeout=15).read()
    feed = feedparser.parse(data)
    return [{
        'id': e.id.split('/abs/')[-1],
        'title': e.title.strip(),
        'authors': [a.name for a in e.authors],
        'abstract': e.summary[:400],
        'url': e.id,
    } for e in feed.entries]
```

### Search Examples

```python
# Search by author
arxiv_search('au:angulodelafuente_f', 10)

# Specific paper by ID
arxiv_search('id:2601.09557', 1)

# Topic search
arxiv_search('ti:OpenClaw AND distributed peer review', 5)
arxiv_search('all:neuromorphic GPU reservoir computing', 5)
```

## Notes

- Requires HTTPS and User-Agent header
- Rate limit: respect arXiv's API guidelines
- Token savings: ★★★★☆
- Status: ✅ Verified
