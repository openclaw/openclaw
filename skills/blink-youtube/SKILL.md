---
name: blink-youtube
description: >
  Access YouTube channel data, videos, analytics, and comments. Use when asked
  about video performance, channel subscribers, or YouTube content management.
  Requires a linked YouTube connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "youtube" } }
---

# Blink YouTube

Access the user's linked YouTube account. Provider key: `youtube`.

## Get my channel info
```bash
bash scripts/call.sh /channels GET '{"part":"snippet,statistics,contentDetails","mine":"true"}'
```

## List my videos
```bash
bash scripts/call.sh /search GET '{"part":"snippet","forMine":"true","type":"video","maxResults":20,"order":"date"}'
```

## Get video statistics
```bash
bash scripts/call.sh /videos GET '{"part":"statistics,snippet,contentDetails","id":"{videoId}"}'
```

## Get video comments
```bash
bash scripts/call.sh /commentThreads GET '{"part":"snippet","videoId":"{videoId}","maxResults":20}'
```

## Search videos
```bash
bash scripts/call.sh /search GET '{"part":"snippet","q":"blink.new tutorial","type":"video","maxResults":10}'
```

## Get playlist items
```bash
bash scripts/call.sh /playlistItems GET '{"part":"snippet","playlistId":"{playlistId}","maxResults":20}'
```

## Get video analytics (YouTube Analytics API)
```bash
bash scripts/call.sh /reports GET '{"ids":"channel==MINE","metrics":"views,likes,comments","dimensions":"day","startDate":"2024-01-01","endDate":"2024-01-31"}'
```

## Common use cases
- "How many subscribers do I have?" → GET /channels?mine=true (statistics.subscriberCount)
- "What are my most viewed videos?" → GET /search?forMine=true, sort by views
- "Get stats for video X" → GET /videos?id={id}&part=statistics
- "Show comments on my latest video" → GET /commentThreads?videoId={id}
- "How many views did I get this month?" → GET /reports with date range
