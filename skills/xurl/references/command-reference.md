# xurl — Command Reference

## Posting

```bash
# Simple post
xurl post "Hello world!"

# Post with media (upload first, then attach)
xurl media upload photo.jpg          # → note the media_id from response
xurl post "Check this out" --media-id MEDIA_ID

# Multiple media
xurl post "Thread pics" --media-id 111 --media-id 222

# Reply to a post (by ID or URL)
xurl reply 1234567890 "Great point!"
xurl reply https://x.com/user/status/1234567890 "Agreed!"

# Reply with media
xurl reply 1234567890 "Look at this" --media-id MEDIA_ID

# Quote a post
xurl quote 1234567890 "Adding my thoughts"

# Delete your own post
xurl delete 1234567890
```

## Reading

```bash
# Read a single post (returns author, text, metrics, entities)
xurl read 1234567890
xurl read https://x.com/user/status/1234567890

# Search recent posts (default 10 results)
xurl search "golang"
xurl search "from:elonmusk" -n 20
xurl search "#buildinpublic lang:en" -n 15
```

## User Info

```bash
xurl whoami                    # Your own profile
xurl user elonmusk             # Look up any user
xurl user @XDevelopers
```

## Timelines & Mentions

```bash
xurl timeline                  # Home timeline (reverse chronological)
xurl timeline -n 25
xurl mentions                  # Your mentions
xurl mentions -n 20
```

## Engagement

```bash
xurl like 1234567890           # Like / unlike
xurl unlike 1234567890

xurl repost 1234567890         # Repost / undo
xurl unrepost 1234567890

xurl bookmark 1234567890       # Bookmark / remove
xurl unbookmark 1234567890

xurl bookmarks -n 20           # List your bookmarks / likes
xurl likes -n 20
```

## Social Graph

```bash
xurl follow @XDevelopers       # Follow / unfollow
xurl unfollow @XDevelopers

xurl following -n 50           # List who you follow / your followers
xurl followers -n 50

xurl following --of elonmusk -n 20   # Another user's following/followers
xurl followers --of elonmusk -n 20

xurl block @spammer            # Block / unblock
xurl unblock @spammer

xurl mute @annoying            # Mute / unmute
xurl unmute @annoying
```

## Direct Messages

```bash
xurl dm @someuser "Hey, saw your post!"
xurl dms                       # List recent DM events
xurl dms -n 25
```

## Media Upload

```bash
xurl media upload photo.jpg                                    # Auto-detects type
xurl media upload video.mp4
xurl media upload --media-type image/jpeg --category tweet_image photo.jpg  # Explicit type

xurl media status MEDIA_ID                                     # Check processing status
xurl media status --wait MEDIA_ID                              # Poll until done

# Full workflow: upload then post
xurl media upload meme.png     # response includes media id
xurl post "lol" --media-id MEDIA_ID
```

## App Management

```bash
xurl auth status               # Check auth state
xurl auth apps list            # List registered apps
xurl auth apps remove NAME     # Remove an app
xurl auth default              # Set default (interactive)
xurl auth default APP [USER]   # Set default (command)
xurl --app NAME /2/users/me    # One-off app override
```

**Note:** App registration and credential updates must be done manually outside agent/LLM sessions.

## Raw API Access

For any v2 endpoint not covered by shortcuts:

```bash
xurl /2/users/me                                              # GET (default)
xurl -X POST /2/tweets -d '{"text":"Hello world!"}'           # POST with JSON
xurl -X DELETE /2/tweets/1234567890                            # DELETE
xurl -H "Content-Type: application/json" /2/some/endpoint     # Custom headers
xurl -s /2/tweets/search/stream                                # Force streaming
xurl https://api.x.com/2/users/me                             # Full URLs work too
```

## Streaming

Auto-detected endpoints:
- `/2/tweets/search/stream`
- `/2/tweets/sample/stream`
- `/2/tweets/sample10/stream`

Force streaming on any endpoint with `-s`.

## Common Workflows

### Post with image
```bash
xurl media upload photo.jpg
xurl post "Check out this photo!" --media-id MEDIA_ID
```

### Reply to a conversation
```bash
xurl read https://x.com/user/status/1234567890
xurl reply 1234567890 "Here are my thoughts..."
```

### Search and engage
```bash
xurl search "topic of interest" -n 10
xurl like POST_ID_FROM_RESULTS
xurl reply POST_ID_FROM_RESULTS "Great point!"
```

### Multiple apps
```bash
# Authenticate on each pre-configured app
xurl auth default prod && xurl auth oauth2
xurl auth default staging && xurl auth oauth2

# Switch between them
xurl auth default prod alice
xurl --app staging /2/users/me
```

## Error Handling

- Non-zero exit code on error
- API errors are JSON on stdout (parseable)
- Auth errors → re-run `xurl auth oauth2`
- User ID auto-resolved via `/2/users/me` for like/repost/bookmark/follow
- 429 → rate limited, wait and retry
- 403 → may need `xurl auth oauth2` for fresh scopes
