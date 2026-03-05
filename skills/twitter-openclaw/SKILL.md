---
name: twitter-openclaw
description: Interact with Twitter/X posts, timelines, and users from OpenClaw.
homepage: https://developer.x.com/en/docs
metadata:
  {
    "openclaw":
      {
        "emoji": "🐦‍⬛",
        "requires": { "bins": ["node"], "env": ["TWITTER_BEARER_TOKEN"] },
        "optionalEnv": ["TWITTER_API_KEY", "TWITTER_API_SECRET", "TWITTER_USER_ID"],
      },
  }
---

# twitter-openclaw 🐦‍⬛

Interact with Twitter/X posts, timelines, and users from OpenClaw.

## Authentication

Requires `TWITTER_BEARER_TOKEN`.

Optionally set `TWITTER_API_KEY` and `TWITTER_API_SECRET` for write operations.

Run auth check:

```bash
node {baseDir}/bin/twclaw.js auth-check
```

## Commands

### Reading

```bash
node {baseDir}/bin/twclaw.js read <tweet-url-or-id>
node {baseDir}/bin/twclaw.js thread <tweet-url-or-id>
node {baseDir}/bin/twclaw.js replies <tweet-url-or-id> -n 20
node {baseDir}/bin/twclaw.js user <@handle>
node {baseDir}/bin/twclaw.js user-tweets <@handle> -n 20
```

### Timelines

```bash
node {baseDir}/bin/twclaw.js home -n 20
node {baseDir}/bin/twclaw.js mentions -n 10
node {baseDir}/bin/twclaw.js likes <@handle> -n 10
```

### Search

```bash
node {baseDir}/bin/twclaw.js search "query" -n 10
node {baseDir}/bin/twclaw.js search "from:elonmusk AI" -n 5
node {baseDir}/bin/twclaw.js search "#trending" --recent
node {baseDir}/bin/twclaw.js search "query" --popular
```

### Trending

```bash
node {baseDir}/bin/twclaw.js trending
node {baseDir}/bin/twclaw.js trending --woeid 23424977
```

### Posting

```bash
node {baseDir}/bin/twclaw.js tweet "hello world"
node {baseDir}/bin/twclaw.js reply <tweet-url-or-id> "great thread!"
node {baseDir}/bin/twclaw.js quote <tweet-url-or-id> "interesting take"
node {baseDir}/bin/twclaw.js tweet "look at this" --media image.png
```

### Engagement

```bash
node {baseDir}/bin/twclaw.js like <tweet-url-or-id>
node {baseDir}/bin/twclaw.js unlike <tweet-url-or-id>
node {baseDir}/bin/twclaw.js retweet <tweet-url-or-id>
node {baseDir}/bin/twclaw.js unretweet <tweet-url-or-id>
node {baseDir}/bin/twclaw.js bookmark <tweet-url-or-id>
node {baseDir}/bin/twclaw.js unbookmark <tweet-url-or-id>
```

### Following

```bash
node {baseDir}/bin/twclaw.js follow <@handle>
node {baseDir}/bin/twclaw.js unfollow <@handle>
node {baseDir}/bin/twclaw.js followers <@handle> -n 20
node {baseDir}/bin/twclaw.js following <@handle> -n 20
```

### Lists

```bash
node {baseDir}/bin/twclaw.js lists
node {baseDir}/bin/twclaw.js list-timeline <list-id> -n 20
node {baseDir}/bin/twclaw.js list-add <list-id> <@handle>
node {baseDir}/bin/twclaw.js list-remove <list-id> <@handle>
```

## Output Options

```bash
--json          # JSON output
--plain         # Plain text, no formatting
--no-color      # Disable ANSI colors
-n <count>      # Number of results (default: 10)
--cursor <val>  # Pagination cursor for next page
--all           # Fetch all pages (use with caution)
--yes           # Required for write actions in non-interactive mode
```

## Guidelines

- When reading tweets, always include author, handle, text, timestamp, and engagement counts.
- For threads, present tweets in chronological order.
- For searches, summarize concisely with key metrics.
- Before posting/liking/retweeting, confirm with the user.
- Use `--json` when processing output programmatically.

## Troubleshooting

### 401 Unauthorized

Check that `TWITTER_BEARER_TOKEN` is set and valid.

### 429 Rate Limited

Wait and retry. X/Twitter API uses strict per-window limits.
