# YouTube Routing Reference

**App name:** `youtube`
**Base URL proxied:** `www.googleapis.com`

## API Path Pattern

```
/youtube/youtube/v3/{resource}
```

## Common Endpoints

### Search Videos

```bash
GET /youtube/youtube/v3/search?part=snippet&q=coding+tutorial&type=video&maxResults=10
```

Query parameters:

- `part` - Required: `snippet`
- `q` - Search query
- `type` - Filter: `video`, `channel`, `playlist`
- `maxResults` - Results per page (1-50)
- `order` - Sort: `date`, `rating`, `relevance`, `title`, `viewCount`
- `videoDuration` - `short` (<4min), `medium` (4-20min), `long` (>20min)

### Get Video Details

```bash
GET /youtube/youtube/v3/videos?part=snippet,statistics,contentDetails&id={videoId}
```

Parts available: `snippet`, `statistics`, `contentDetails`, `status`, `player`

### Get Trending Videos

```bash
GET /youtube/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=US&maxResults=10
```

### Rate Video

```bash
POST /youtube/youtube/v3/videos/rate?id={videoId}&rating=like
```

Rating values: `like`, `dislike`, `none`

### Get My Channel

```bash
GET /youtube/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true
```

### Get Channel Details

```bash
GET /youtube/youtube/v3/channels?part=snippet,statistics&id={channelId}
```

### List My Playlists

```bash
GET /youtube/youtube/v3/playlists?part=snippet,contentDetails&mine=true&maxResults=25
```

### Create Playlist

```bash
POST /youtube/youtube/v3/playlists?part=snippet,status
Content-Type: application/json

{
  "snippet": {
    "title": "My New Playlist",
    "description": "A collection of videos"
  },
  "status": {
    "privacyStatus": "private"
  }
}
```

Privacy values: `public`, `private`, `unlisted`

### Delete Playlist

```bash
DELETE /youtube/youtube/v3/playlists?id={playlistId}
```

### List Playlist Items

```bash
GET /youtube/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId={playlistId}&maxResults=50
```

### Add Video to Playlist

```bash
POST /youtube/youtube/v3/playlistItems?part=snippet
Content-Type: application/json

{
  "snippet": {
    "playlistId": "PLxyz123",
    "resourceId": {
      "kind": "youtube#video",
      "videoId": "abc123xyz"
    },
    "position": 0
  }
}
```

### List My Subscriptions

```bash
GET /youtube/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=50
```

### Subscribe to Channel

```bash
POST /youtube/youtube/v3/subscriptions?part=snippet
Content-Type: application/json

{
  "snippet": {
    "resourceId": {
      "kind": "youtube#channel",
      "channelId": "UCxyz123"
    }
  }
}
```

### List Video Comments

```bash
GET /youtube/youtube/v3/commentThreads?part=snippet,replies&videoId={videoId}&maxResults=100
```

### Add Comment to Video

```bash
POST /youtube/youtube/v3/commentThreads?part=snippet
Content-Type: application/json

{
  "snippet": {
    "videoId": "abc123xyz",
    "topLevelComment": {
      "snippet": {
        "textOriginal": "Great video!"
      }
    }
  }
}
```

## Notes

- Video IDs are 11 characters (e.g., `dQw4w9WgXcQ`)
- Channel IDs start with `UC` (e.g., `UCxyz123`)
- Playlist IDs start with `PL` (user) or `UU` (uploads)
- Use `pageToken` for pagination through large result sets
- The `part` parameter is required and determines what data is returned
- Quota costs vary by endpoint - search is expensive (100 units), reads are cheap (1 unit)

## Resources

- [YouTube Data API Overview](https://developers.google.com/youtube/v3)
- [Search](https://developers.google.com/youtube/v3/docs/search/list)
- [Videos](https://developers.google.com/youtube/v3/docs/videos)
- [Channels](https://developers.google.com/youtube/v3/docs/channels)
- [Playlists](https://developers.google.com/youtube/v3/docs/playlists)
- [PlaylistItems](https://developers.google.com/youtube/v3/docs/playlistItems)
- [Subscriptions](https://developers.google.com/youtube/v3/docs/subscriptions)
- [Comments](https://developers.google.com/youtube/v3/docs/comments)
- [Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost)
