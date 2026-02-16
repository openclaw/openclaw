---
name: video-quote-finder
description: Find where a quote appears in a YouTube video and return timestamped links. Use when users ask "where in this video does X say Y", "find the timestamp for this line", or "locate quote in this YouTube video".
---

# Video Quote Finder

Find quote timestamps in YouTube videos using the `summarize` CLI transcript extraction with timestamps.

## Quick start

```bash
python3 skills/video-quote-finder/scripts/find_quote_timestamp.py \
  "https://youtu.be/YFjfBk8HI5o" \
  "I think vibe coding is a slur"
```

## Workflow

1. Extract transcript with timestamps via `summarize --extract --timestamps`.
2. Score transcript lines against the requested quote.
3. Return best match + top alternatives.
4. Include direct YouTube links with `t=<seconds>`.

## Output format

- `best_match` timestamp + line + score
- `best_link` with timestamp
- up to 5 candidate timestamps with links

## Notes

- Requires `summarize` CLI (`@steipete/summarize`) in PATH.
- Works best when YouTube captions are available.
- If no exact match is found, uses fuzzy matching and suggests alternatives.

## PR hygiene (Markdown)

When this skill is added/updated in a PR, ensure docs checks pass before pushing:

```bash
pnpm format:docs:check
pnpm lint:docs
```

If a markdown CI error appears (for example `MD034/no-bare-urls`), fix the markdown and re-run both commands.
