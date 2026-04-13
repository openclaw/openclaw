---
name: bluesky
description: "Bluesky social media CLI tool and MCP server for AI agents. Use when: (1) posting to Bluesky, (2) liking/replying/reposting, (3) viewing timelines and threads, (4) searching posts, (5) managing profiles and chats, (6) following users. NOT for: non-Bluesky platforms, complex web UI interactions requiring manual browser flows."
metadata:
  {
    "openclaw":
      {
        "emoji": "🦋",
        "requires": { "bins": ["python3"], "python": ["atproto", "mcp"] },
        "install":
          [
            {
              "id": "pip",
              "kind": "pip",
              "packages": ["atproto", "mcp"],
              "label": "Install Bluesky dependencies (pip)",
            },
          ],
      },
  }
---

# Bluesky Skill

Comprehensive command-line tool and MCP server for interacting with Bluesky social media platform.

## When to Use

✅ **USE this skill when:**

- Creating posts with or without images
- Liking, reposting, or replying to posts
- Viewing timelines and notifications
- Navigating conversation threads
- Searching posts by keyword
- Viewing user profiles and posts
- Managing chat conversations
- Following users
- Downloading images from posts

## When NOT to Use

❌ **DON'T use this skill when:**

- Non-Bluesky platforms (Twitter/X, Mastodon, etc.) → different APIs
- Complex web UI interactions requiring manual browser flows
- Bulk operations across many accounts → rate limits apply
- Real-time streaming → use Bluesky's firehose API directly

## Setup

### 1. Install Dependencies

```bash
pip install atproto mcp
```

### 2. Configure Credentials

Create `credentials.json` in the skill directory:

```json
{
  "_description": "Bluesky CLI Bot and MCP Server credentials",
  "_note": "Generate an App Password at: https://bsky.app/settings/app-passwords",
  "username": "your-handle.bsky.social",
  "password": "your-app-password"
}
```

To get an app password:
1. Go to https://bsky.app/settings/app-passwords
2. Create a new app password
3. Use it in credentials.json

## CLI Usage

### Interactive Mode

```bash
python bluesky-cli.py interactive
```

### Direct Commands

```bash
# Create a post
python bluesky-cli.py post "Hello, Bluesky!"

# Create post with images
python bluesky-cli.py post "Check this out" --images image1.jpg image2.png

# View timeline
python bluesky-cli.py timeline --limit 10

# Like a post
python bluesky-cli.py like --uri "at://did:plc:example/app.bsky.feed.post/123"

# Reply to a post
python bluesky-cli.py reply --uri "at://did:plc:example/app.bsky.feed.post/123" --text "Great post!"

# View thread
python bluesky-cli.py thread --uri "at://did:plc:example/app.bsky.feed.post/123" --depth 5

# Search posts
python bluesky-cli.py search --query "python" --limit 20

# View profile
python bluesky-cli.py profile --handle "example.bsky.social"

# View user posts
python bluesky-cli.py userposts --handle "example.bsky.social" --limit 30

# View notifications
python bluesky-cli.py notifications --limit 15

# Follow a user
python bluesky-cli.py follow --handle "example.bsky.social"

# Download images
python bluesky-cli.py download-images --uri "at://did:plc:example/app.bsky.feed.post/123" --output-dir ./downloaded

# List chats
python bluesky-cli.py chats

# View chat messages
python bluesky-cli.py messages --convo-id "convo123" --limit 50

# Send chat message
python bluesky-cli.py chatmsg --convo-id "convo123" --text "Hello!"
```

## MCP Server

### Starting the MCP Server

```bash
python mcp_server.py
```

### Available MCP Tools

- `bluesky_post`: Create a new post
- `bluesky_timeline`: Get timeline feed
- `bluesky_notifications`: Get notifications
- `bluesky_like`: Like a post
- `bluesky_repost`: Repost a post
- `bluesky_reply`: Reply to a post
- `bluesky_thread`: View a thread
- `bluesky_search`: Search posts
- `bluesky_profile`: Get user profile
- `bluesky_user_posts`: Get user posts
- `bluesky_chats`: List chats
- `bluesky_chat_messages`: Get chat messages
- `bluesky_send_chat`: Send chat message
- `bluesky_follow`: Follow a user
- `bluesky_post_likes`: Get post likes
- `bluesky_download_images`: Download images
- `bluesky_get_mentions`: Get mentions

## URI Format

Bluesky URIs follow this format:
```
at://did:plc:[identifier]/app.bsky.feed.post/[post-id]
```

Copy URIs directly from CLI output when possible.

## Security

- Never commit credentials.json to version control
- Use dedicated app passwords (not your account password)
- Keep credentials.json secure
- Review permissions carefully when generating app passwords

## Rate Limits

Bluesky has rate limits on API calls. If you encounter rate limit errors:
- Wait before retrying
- Use caching for repeated queries
- Batch operations when possible

## Troubleshooting

### Authentication Error
- Ensure your app password is correct
- Check that your Bluesky handle is valid
- Verify internet connectivity

### File Not Found (for images)
- Check that image paths are correct
- Ensure files exist and are accessible
- Use absolute paths if relative paths don't work

### URI Format Errors
- Bluesky URIs must follow the format: `at://did:plc:[identifier]/app.bsky.feed.post/[post-id]`
- Copy URIs directly from the CLI tool's output when possible
