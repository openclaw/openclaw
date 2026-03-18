---
name: blink-tiktok
description: >
  Access TikTok videos, analytics, and account data. Use when asked to list
  videos, check video performance, or access TikTok creator data. Requires a
  linked TikTok connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "tiktok" } }
---

# Blink TikTok

Access the user's linked TikTok creator account. Provider key: `tiktok`.

## Get user info
```bash
bash scripts/call.sh /user/info/ GET '{"fields":"open_id,display_name,avatar_url,follower_count,following_count,likes_count,video_count"}'
```

## List my videos
```bash
bash scripts/call.sh /video/list/ POST '{"fields":"id,title,create_time,cover_image_url,share_url,view_count,like_count,comment_count,share_count","max_count":20}'
```

## Query specific videos
```bash
bash scripts/call.sh /video/query/ POST '{"filters":{"video_ids":["{video_id}"]},"fields":"id,title,view_count,like_count,comment_count,share_count,create_time"}'
```

## Get video comments
```bash
bash scripts/call.sh /research/video/comment/list/ POST '{"video_id":"{video_id}","max_count":20,"fields":"id,text,like_count,reply_count,create_time"}'
```

## Common use cases
- "How many followers do I have on TikTok?" → GET /user/info/ with follower_count field
- "List my recent TikTok videos" → POST /video/list/ with view/like counts
- "What's the performance of my latest video?" → POST /video/query/ with video_id
- "Show comments on video X" → POST /research/video/comment/list/
- "What's my total likes count?" → GET /user/info/ with likes_count field
