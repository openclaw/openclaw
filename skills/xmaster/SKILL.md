---
name: xmaster
description: "X/Twitter operations via xmaster CLI: post, reply, thread, search, analyze, schedule, DMs, bookmarks, metrics, engagement tracking. Use when: (1) posting, replying, or threading on X, (2) analyzing posts before posting (pre-flight scoring), (3) searching X content (API + AI search), (4) checking engagement metrics or reports, (5) managing DMs, bookmarks, or schedules. NOT for: Instagram, LinkedIn, or other social platforms."
metadata:
  {
    "openclaw":
      {
        "emoji": "𝕏",
        "requires": { "bins": ["xmaster"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "xmaster",
              "tap": "199-biotechnologies/tap",
              "bins": ["xmaster"],
              "label": "Install xmaster (Homebrew)",
            },
            {
              "id": "cargo",
              "kind": "cargo",
              "crate": "xmaster",
              "bins": ["xmaster"],
              "label": "Install xmaster (cargo)",
            },
          ],
      },
  }
---

# xmaster — X/Twitter Skill

Use the `xmaster` CLI to interact with X (Twitter): post, reply, search, analyze, schedule, track metrics, manage DMs and bookmarks.

## When to Use

**USE this skill when:**

- Posting tweets, replies, threads, or quote tweets
- Analyzing a post before publishing (pre-flight scoring with algorithm weights)
- Searching X content (structured API search or AI-powered semantic search)
- Checking engagement metrics, daily/weekly reports, or timing heatmaps
- Managing DMs (send, inbox, threads)
- Syncing, searching, or exporting bookmarks
- Scheduling posts for optimal times
- Following, liking, retweeting, or other engagement actions

**DON'T use this skill when:**

- Working with Instagram, LinkedIn, or non-X platforms
- Reading web pages or URLs that aren't x.com posts
- `xmaster` is not installed or X API credentials are not configured
- You only need raw X API access without analytics — consider the `xurl` skill instead

**How this differs from `xurl`:** xurl provides direct authenticated access to X API endpoints. xmaster adds a layer on top: pre-flight post analysis, engagement metrics, scheduling, timing heatmaps, AI-powered search, writing style persistence, and local SQLite tracking. Use xurl for raw API calls; use xmaster when you need intelligence around posting and engagement.

## Secret Safety (Mandatory)

- Never read, print, parse, or send the xmaster config file (`~/.config/xmaster/config.toml`) to the LLM context. It contains API keys.
- Never ask the user to paste API credentials into chat.
- Do not pass credentials inline in commands. The user must configure them manually via `xmaster config set` outside the agent session.
- `xmaster config check` is safe to run (keys are masked in output), but do not attempt to extract or log credential values.
- `xmaster config show` masks sensitive values by default. Do not attempt to unmask them.
- Never use shell commands to read, cat, or grep the config file directly.

## Setup

### 1. Install

```bash
# Homebrew (macOS / Linux)
brew tap 199-biotechnologies/tap && brew install xmaster

# or Cargo (any platform with Rust)
cargo install xmaster

# or one-liner install script
curl -fsSL https://raw.githubusercontent.com/199-biotechnologies/xmaster/master/install.sh | sh
```

### 2. Configure API credentials

You need X API v2 credentials from https://developer.x.com (Free tier works):

```bash
xmaster config set keys.api_key YOUR_X_API_KEY
xmaster config set keys.api_secret YOUR_X_API_SECRET
xmaster config set keys.access_token YOUR_ACCESS_TOKEN
xmaster config set keys.access_token_secret YOUR_ACCESS_TOKEN_SECRET
```

### 3. Optional: AI search (xAI/Grok)

For `search-ai` (semantic search powered by Grok), add an xAI API key from https://console.x.ai:

```bash
xmaster config set keys.xai YOUR_XAI_KEY
```

### 4. Optional: Bookmarks (OAuth 2.0)

Bookmarks require OAuth 2.0 PKCE. Run once:

```bash
xmaster config auth
```

### 5. Optional: Reply fallback (browser cookies)

X restricts programmatic replies to non-followers via API. xmaster can fall back to a web session for these cases. **Note:** This uses browser cookies outside the official API and may not comply with X's Terms of Service. Use at your own discretion.

```bash
xmaster config web-login
```

### 6. Verify setup

```bash
xmaster config check
```

## Common Commands

### Posting

```bash
# Post a tweet
xmaster post "Hello from OpenClaw"

# Reply to a tweet
xmaster reply 1234567890 "Great point"

# Post a thread
xmaster thread "First tweet" "Second tweet" "Third tweet"

# Quote tweet
xmaster post "This is important" --quote 1234567890

# Attach media
xmaster post "Check this out" --media photo.jpg
```

### Pre-flight Analysis

Scores your post before publishing. Catches weak hooks, link penalties, engagement bait, and character limits using real weights from the open-source X ranking code.

```bash
xmaster analyze "your tweet text" --goal replies
```

Returns a score (0-100), grade (A-F), and actionable issues.

### Search

```bash
# X API v2 search (structured, filterable)
xmaster search "rust CLI tools" -c 10

# AI-powered semantic search (xAI/Grok)
xmaster search-ai "interesting longevity research from this week"

# Trending topics
xmaster trending --region US
```

### Reading Posts

```bash
# Read a post by ID or URL
xmaster read 1234567890
xmaster read https://x.com/user/status/1234567890

# Get replies to a post
xmaster replies 1234567890
```

### Metrics & Reports

```bash
# Single post metrics
xmaster metrics 1234567890

# Daily/weekly performance report
xmaster report daily
xmaster report weekly

# Best posting times from your history
xmaster suggest best-time

# Check if safe to post now (cannibalization guard)
xmaster suggest next-post
```

### Engagement

```bash
xmaster like 1234567890
xmaster retweet 1234567890
xmaster bookmark 1234567890
xmaster follow username
xmaster unfollow username
```

### DMs

```bash
xmaster dm send username "Hello"
xmaster dm inbox
xmaster dm thread CONVERSATION_ID
```

### Bookmarks

```bash
# Sync bookmarks to local SQLite (survives tweet deletion)
xmaster bookmarks sync -c 200

# Search your bookmarks locally
xmaster bookmarks search "rust async"

# Weekly digest
xmaster bookmarks digest -d 7

# Export
xmaster bookmarks export -o ~/bookmarks.md
```

### Scheduling

```bash
# Schedule a post for a specific time
xmaster schedule add "Tweet text" --at "2026-04-01 09:00"

# Auto-pick best time from engagement history
xmaster schedule add "Tweet text" --at auto

# List scheduled posts
xmaster schedule list

# Enable automatic posting daemon (macOS launchd)
xmaster schedule setup
```

### Account Info

```bash
xmaster me                          # Your profile
xmaster user username               # Any user's profile
xmaster followers username -c 50    # List followers
xmaster following username          # List following
xmaster rate-limits                 # API quota status
```

## JSON Output

All commands support `--json` for structured output. Auto-enabled when piped.

```bash
xmaster --json post "Hello" | jq '.data.id'
xmaster search "query" --json | jq '.data.tweets[].text'
```

**Success envelope:**
```json
{
  "version": "1",
  "status": "success",
  "data": { ... },
  "metadata": { "elapsed_ms": 342, "provider": "x_api" }
}
```

**Exit codes:** 0 = success, 1 = runtime error, 2 = config error, 3 = auth missing, 4 = rate limited.

### Agent Discovery

```bash
# Machine-readable capabilities, version, and algorithm weights
xmaster agent-info --json
```

## Writing Style

Save your X writing voice. The agent drafts in your style automatically:

```bash
xmaster config set style.voice "direct, lowercase, no fluff, data-driven"
```

Read it back via `xmaster agent-info --json` under `writing_style`.

## Notes

- X API Free tier allows 1,500 tweets/month and basic read access
- `search-ai` uses xAI credits (separate from X API)
- Bookmarks and reply fallback each need one-time auth setup
- All data (metrics, bookmarks, schedules) stored locally in SQLite
- Self-updates: `xmaster update`

## Links

- **Repo:** https://github.com/199-biotechnologies/xmaster
- **crates.io:** https://crates.io/crates/xmaster
- **License:** MIT
