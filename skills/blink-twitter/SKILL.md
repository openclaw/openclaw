---
name: blink-twitter
description: >
  Post tweets, read timeline, search tweets, manage DMs, and view analytics on
  X (Twitter). Use when asked to tweet, reply, search Twitter, or check follower
  activity. Requires a linked Twitter/X connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "twitter" } }
---

# Blink Twitter / X

Access the user's linked Twitter/X account. Provider key: `twitter`.

## Get my profile
```bash
bash scripts/call.sh twitter /users/me GET '{"user.fields":"public_metrics,description"}'
```

## Post a tweet
```bash
bash scripts/call.sh twitter /tweets POST '{"text":"Hello world!"}'
```

## Reply to a tweet
```bash
bash scripts/call.sh twitter /tweets POST '{"text":"Great point!","reply":{"in_reply_to_tweet_id":"{tweet_id}"}}'
```

## Get home timeline
```bash
bash scripts/call.sh twitter /users/{id}/timelines/reverse_chronological GET '{"max_results":20}'
```

## Search recent tweets
```bash
bash scripts/call.sh twitter /tweets/search/recent GET '{"query":"blink.new","max_results":10}'
```

## Get tweet details
```bash
bash scripts/call.sh twitter /tweets/{id} GET '{"tweet.fields":"public_metrics,created_at"}'
```

## Get my followers
```bash
bash scripts/call.sh twitter /users/{id}/followers GET '{"max_results":50}'
```

## Common use cases
- "Tweet: We just launched X feature!" → POST /tweets
- "Search Twitter for mentions of blink.new" → GET /tweets/search/recent
- "Reply to tweet {id} with ..." → POST /tweets with reply field
- "How many followers do I have?" → GET /users/me with public_metrics
- "What's trending in my timeline?" → GET /users/{id}/timelines/reverse_chronological
