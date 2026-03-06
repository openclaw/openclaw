---
name: youtube-summary
description: Summarize a YouTube video by extracting transcript text with summarize CLI and returning summary-only output (never transcript text).
user-invocable: false
metadata: { "openclaw": { "emoji": "🎬", "requires": { "bins": ["summarize"] } } }
---

# YouTube Summary

Use this skill when the user asks for a summary of a YouTube video.

## Behavior

1. Accept a YouTube URL from the user.
2. Run:

```bash
summarize "<url>" --youtube auto --extract-only
```

3. If extraction succeeds, summarize the extracted transcript in your own words.
4. Return only the summary. Do not include transcript text or transcript quotes.

## Failure handling

- If transcript extraction fails, respond with a short error and ask for another URL.
- If transcript is missing/empty, say that no transcript was available for that video.
