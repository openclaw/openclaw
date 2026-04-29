---
name: blink-twitter
description: >
  Post tweets, read timeline, search tweets, manage DMs, and view analytics on
  Twitter/X. Use when asked to tweet, reply, search Twitter/X, or check follower
  activity. Requires a linked Twitter/X connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "composio_twitter" } }
---

# Blink Twitter / X

Access the user's linked Twitter/X account. Provider key: `composio_twitter`.

Use X API v2 endpoints only. Do **not** use legacy v1.1 endpoints like `/statuses/update`.

Before posting, keep generated text under 280 characters. If a write fails, check the endpoint and text length before assuming the connector lacks write scope.

## Get my profile
```bash
blink connector exec composio_twitter users/me GET '{"user.fields":"id,name,username,public_metrics,description"}'
```

## Post a tweet
```bash
blink connector exec composio_twitter tweets POST '{"text":"Hello world!"}'
```

## Reply to a tweet
```bash
blink connector exec composio_twitter tweets POST '{"text":"Great point!","reply":{"in_reply_to_tweet_id":"{tweet_id}"}}'
```

## Get home timeline
```bash
blink connector exec composio_twitter users/{user_id}/timelines/reverse_chronological GET '{"max_results":20}'
```

## Search recent tweets
```bash
blink connector exec composio_twitter tweets/search/recent GET '{"query":"blink.new","max_results":10}'
```

## Get tweet details
```bash
blink connector exec composio_twitter tweets/{tweet_id} GET '{"tweet.fields":"public_metrics,created_at,conversation_id,referenced_tweets"}'
```

## Get my followers
```bash
blink connector exec composio_twitter users/{user_id}/followers GET '{"max_results":50}'
```

## Like a tweet
Use the authenticated `{user_id}` returned by `users/me`.

```bash
blink connector exec composio_twitter users/{user_id}/likes POST '{"tweet_id":"{tweet_id}"}'
```

## Delete my own tweet
Only do this when the user explicitly asks.

```bash
blink connector exec composio_twitter tweets/{tweet_id} DELETE
```

## Common use cases
- "Tweet: We just launched X feature!" -> `POST tweets`
- "Search Twitter/X for mentions of blink.new" -> `GET tweets/search/recent`
- "Reply to tweet {tweet_id} with ..." -> `POST tweets` with `reply.in_reply_to_tweet_id`
- "How many followers do I have?" -> `GET users/me` with `public_metrics`
- "What's trending in my timeline?" -> `GET users/{user_id}/timelines/reverse_chronological`
