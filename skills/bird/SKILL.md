# bird — Twitter/X CLI

`bird` is a CLI tool for interacting with Twitter/X. Use it via the `exec` tool.

## Common Commands

```bash
# Post a tweet
bird tweet "your tweet text"

# Reply to a tweet
bird reply <tweet-id> "your reply text"

# Read a tweet
bird read <tweet-id-or-url>

# Get a conversation thread
bird thread <tweet-id-or-url>

# Search tweets
bird search "query" -n 10 --json

# Get a user's recent tweets
bird user-tweets @handle -n 10 --json

# Get mentions
bird mentions -n 10 --json

# Check who you're logged in as
bird whoami
```

## Options

- `--json` — output as JSON (supported by most read commands)
- `--plain` — plain text output, no emoji or color
- `-n <count>` — limit number of results
- `--media <path>` — attach image or video to a tweet (up to 4 images or 1 video)

## Notes

- Authentication uses Chrome browser cookies automatically
- Always use `--plain` or `--json` when parsing output programmatically
- Tweet IDs are numeric strings (e.g., `2041821711922860350`)
