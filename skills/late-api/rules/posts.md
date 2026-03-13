# Posts API

## Endpoints

| Method   | Endpoint                   | Description         |
| -------- | -------------------------- | ------------------- |
| `POST`   | `/v1/posts`                | Create post         |
| `GET`    | `/v1/posts`                | List posts          |
| `GET`    | `/v1/posts/{postId}`       | Get post            |
| `PUT`    | `/v1/posts/{postId}`       | Update post         |
| `DELETE` | `/v1/posts/{postId}`       | Delete post         |
| `POST`   | `/v1/posts/{postId}/retry` | Retry failed post   |
| `GET`    | `/v1/posts/{postId}/logs`  | Get publishing logs |
| `POST`   | `/v1/posts/bulk-upload`    | Bulk create posts   |

## Create Post

```typescript
const post = await fetch("https://getlate.dev/api/v1/posts", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    // Required
    content: "Your post content here",
    platforms: [
      {
        platform: "twitter",
        accountId: "acc_123",
        // Platform-specific data goes inside each platform entry
        platformSpecificData: {
          threadItems: [
            { content: "Tweet 2" },
            { content: "Tweet 3", mediaItems: [{ type: "image", url: "https://..." }] },
          ],
        },
      },
      {
        platform: "instagram",
        accountId: "acc_456",
        platformSpecificData: {
          contentType: "story", // only 'story' is explicit; feed/reel auto-determined by media
          firstComment: "First comment text",
        },
      },
    ],

    // Scheduling (pick one)
    publishNow: true, // Publish immediately
    // OR
    scheduledFor: "2024-03-01T10:00:00Z", // Schedule for later
    // OR
    queuedFromProfile: "prof_123", // Add to queue

    // Optional media (array of objects)
    mediaItems: [
      { type: "image", url: "https://..." },
      { type: "video", url: "https://..." },
    ],
  }),
});
```

## Post to Multiple Platforms

```typescript
await fetch("https://getlate.dev/api/v1/posts", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    content: "Announcing our new feature!",
    platforms: [
      { platform: "twitter", accountId: "tw_123" },
      { platform: "linkedin", accountId: "li_456" },
      { platform: "facebook", accountId: "fb_789" },
    ],
    publishNow: true,
  }),
});
```

## Schedule for Later

```typescript
await fetch("https://getlate.dev/api/v1/posts", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    content: "Scheduled post",
    platforms: [{ platform: "twitter", accountId: "acc_123" }],
    scheduledFor: "2024-03-15T09:00:00Z",
  }),
});
```

## Retry Failed Posts

```bash
# List failed posts
curl "https://getlate.dev/api/v1/posts?status=failed" \
  -H "Authorization: Bearer YOUR_API_KEY"

# Retry a specific post
curl -X POST "https://getlate.dev/api/v1/posts/POST_ID/retry" \
  -H "Authorization: Bearer YOUR_API_KEY"
```
