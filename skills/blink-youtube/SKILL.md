---

## name: blink-youtube
description: >
  Access YouTube channel data, videos, analytics, and comments. Use when asked
  about video performance, channel subscribers, or YouTube content management.
  Requires a linked YouTube connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "youtube" } }

# Blink YouTube

Access the user's linked YouTube account. Provider key: `youtube` or `composio_youtube` (check `blink connector status` for the exact key).
Base URL: `https://www.googleapis.com/youtube/v3/` — endpoints below are relative (no leading slash).

## Get my channel info

```bash
blink connector exec youtube channels GET '{"part":"snippet,statistics,contentDetails","mine":"true"}'
```

## List my videos

```bash
blink connector exec youtube search GET '{"part":"snippet","forMine":"true","type":"video","maxResults":"20","order":"date"}'
```

## Get video statistics

```bash
blink connector exec youtube videos GET '{"part":"statistics,snippet,contentDetails","id":"{videoId}"}'
```

## Get video comments

```bash
blink connector exec youtube commentThreads GET '{"part":"snippet","videoId":"{videoId}","maxResults":"20"}'
```

## Search videos

```bash
blink connector exec youtube search GET '{"part":"snippet","q":"blink.new tutorial","type":"video","maxResults":"10"}'
```

## Get playlist items

```bash
blink connector exec youtube playlistItems GET '{"part":"snippet","playlistId":"{playlistId}","maxResults":"20"}'
```

## Common use cases

- "How many subscribers do I have?" → GET channels with mine=true (statistics.subscriberCount)
- "What are my most viewed videos?" → GET search with forMine=true, sort by views
- "Get stats for video X" → GET videos with id={id}&part=statistics
- "Show comments on my latest video" → GET commentThreads with videoId={id}

