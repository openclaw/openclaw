# Vimeo Routing Reference

**App name:** `vimeo`
**Base URL proxied:** `api.vimeo.com`

## API Path Pattern

```
/vimeo/{resource}
```

## Common Endpoints

### User

```bash
GET /vimeo/me
GET /vimeo/users/{user_id}
GET /vimeo/me/feed
```

### Videos

```bash
# List user videos
GET /vimeo/me/videos

# Search videos
GET /vimeo/videos?query=nature

# Get video
GET /vimeo/videos/{video_id}

# Update video
PATCH /vimeo/videos/{video_id}

# Delete video
DELETE /vimeo/videos/{video_id}
```

### Folders (Projects)

```bash
GET /vimeo/me/folders
POST /vimeo/me/folders
PATCH /vimeo/me/projects/{project_id}
DELETE /vimeo/me/projects/{project_id}

# Folder videos
GET /vimeo/me/projects/{project_id}/videos
PUT /vimeo/me/projects/{project_id}/videos/{video_id}
DELETE /vimeo/me/projects/{project_id}/videos/{video_id}
```

### Albums (Showcases)

```bash
GET /vimeo/me/albums
POST /vimeo/me/albums
PATCH /vimeo/me/albums/{album_id}
DELETE /vimeo/me/albums/{album_id}

# Album videos
GET /vimeo/me/albums/{album_id}/videos
PUT /vimeo/me/albums/{album_id}/videos/{video_id}
DELETE /vimeo/me/albums/{album_id}/videos/{video_id}
```

### Comments

```bash
GET /vimeo/videos/{video_id}/comments
POST /vimeo/videos/{video_id}/comments
DELETE /vimeo/videos/{video_id}/comments/{comment_id}
```

### Likes

```bash
GET /vimeo/me/likes
PUT /vimeo/me/likes/{video_id}
DELETE /vimeo/me/likes/{video_id}
```

### Watch Later

```bash
GET /vimeo/me/watchlater
PUT /vimeo/me/watchlater/{video_id}
DELETE /vimeo/me/watchlater/{video_id}
```

### Following

```bash
GET /vimeo/me/followers
GET /vimeo/me/following
PUT /vimeo/me/following/{user_id}
DELETE /vimeo/me/following/{user_id}
```

### Channels and Categories

```bash
GET /vimeo/channels
GET /vimeo/channels/{channel_id}
GET /vimeo/categories
GET /vimeo/categories/{category}/videos
```

## Notes

- Video and user IDs are numeric
- Folders are called "projects" in API paths
- Albums are "Showcases" in the Vimeo UI
- DELETE and PUT operations return 204 No Content
- Video uploads require TUS protocol
- Page-based pagination with `page` and `per_page` parameters

## Resources

- [Vimeo API Reference](https://developer.vimeo.com/api/reference)
- [Vimeo Developer Portal](https://developer.vimeo.com)
