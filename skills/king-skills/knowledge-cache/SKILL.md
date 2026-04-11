---
name: king_skill_knowledge_cache
description: Cache verified results to avoid recomputation. Check BEFORE any computation.
metadata:
  openclaw:
    emoji: 💾
    requires:
      bins: ["python3"]
    install: []
    os: ["darwin", "linux", "win32"]
---

# Knowledge Cache

Cache verified results to avoid recomputation.

## When to Use

**USE this skill when:**
- Caching computation results
- Checking for existing results
- Memoizing expensive functions
- Reusing verified results
- Storing computation metadata

**DON'T use when:**
- Result is not deterministic
- Cache invalidation is complex

## Commands

```python
import json
import hashlib
import os
from datetime import datetime, timezone

CACHE_DIR = '/tmp/openclaw_cache'

def _key(query: str) -> str:
    return hashlib.sha256(query.encode()).hexdigest()[:16]

def cache_set(query: str, result, metadata: dict = {}) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    entry = {
        'query': query,
        'result': result,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'verified': metadata.get('verified', False),
        **metadata,
    }
    path = f'{CACHE_DIR}/{_key(query)}.json'
    with open(path, 'w') as f:
        json.dump(entry, f, indent=2)
    return path

def cache_get(query: str):
    path = f'{CACHE_DIR}/{_key(query)}.json'
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return None

def cache_list() -> list:
    if not os.path.exists(CACHE_DIR):
        return []
    return [json.load(open(f'{CACHE_DIR}/{f}'))
            for f in os.listdir(CACHE_DIR) if f.endswith('.json')]

def smart_compute(query: str, compute_fn):
    """Check cache first. Call compute_fn only on miss."""
    cached = cache_get(query)
    if cached:
        return cached['result'], True
    result = compute_fn(query)
    cache_set(query, result, {'verified': True})
    return result, False

# Usage:
# result, from_cache = smart_compute('eigenvals_A', lambda _: np.linalg.eigvals(A).tolist())
# if from_cache: print('0 tokens, 0 compute')
```

## Notes

- Check BEFORE any computation
- Uses SHA256 for cache keys
- Token savings: ★★★★☆
- Status: ✅ Verified
