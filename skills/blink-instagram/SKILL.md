---
name: blink-instagram
description: >
  Access Instagram media, posts, and insights. Use when asked to list posts,
  check engagement, view media details, or publish content to Instagram. Requires
  a linked Instagram connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "instagram" } }
---

# Blink Instagram

Access the user's linked Instagram Business account. Provider key: `instagram` or `composio_instagram` (check `blink connector status` for the exact key).
Base URL: `https://graph.instagram.com/v22.0/` — endpoints below are relative to this.

## Get my account info
```bash
blink connector exec instagram /me GET '{"fields":"id,name,username,biography,followers_count,media_count"}'
```

## List my media (posts)
```bash
blink connector exec instagram /me/media GET '{"fields":"id,caption,media_type,timestamp,like_count,comments_count,permalink","limit":20}'
```

## Get a specific media item
```bash
blink connector exec instagram /{media_id} GET '{"fields":"id,caption,media_type,timestamp,like_count,comments_count"}'
```

## Get media insights
```bash
blink connector exec instagram /{media_id}/insights GET '{"metric":"impressions,reach,likes,comments,shares,saved"}'
```

## Get account insights
```bash
blink connector exec instagram /me/insights GET '{"metric":"follower_count,impressions,reach","period":"day","since":1706745600,"until":1709424000}'
```

## Create a media container (step 1 for posting)
```bash
blink connector exec instagram /{user_id}/media POST '{"image_url":"https://example.com/image.jpg","caption":"My caption #hashtag"}'
```

## Publish the container (step 2 for posting)
```bash
blink connector exec instagram /{user_id}/media_publish POST '{"creation_id":"{container_id}"}'
```

## Common use cases
- "How many followers do I have?" → GET /me?fields=followers_count
- "Show my last 10 Instagram posts" → GET /me/media with limit=10
- "What's the engagement on my latest post?" → GET /{media_id}?fields=like_count,comments_count
- "Post a photo to Instagram" → POST /{user_id}/media then POST /{user_id}/media_publish
- "Get reach for my account this month" → GET /me/insights
