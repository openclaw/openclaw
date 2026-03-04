---
summary: "Automate social media posting (X/Twitter, Xiaohongshu, etc.) with OpenClaw agents, cron jobs, and browser automation"
read_when:
  - Automating social media posts with OpenClaw
  - Setting up scheduled X/Twitter posting
  - Using browser automation for platforms without APIs (Xiaohongshu, Instagram)
  - Building a multi-agent social media workflow
title: "Social Media Automation"
---

# Social Media Automation

OpenClaw can automate social media posting across platforms like X (Twitter),
Xiaohongshu (小红书), Instagram, and LinkedIn — using a combination of CLI tools,
browser automation, cron scheduling, and multi-agent workflows.

## Overview

| Platform             | Method             | Skill / Tool                   |
| -------------------- | ------------------ | ------------------------------ |
| X (Twitter)          | CLI (API)          | [xurl](/skills) + cron         |
| Xiaohongshu (小红书) | Browser automation | [browser](/tools/browser) tool |
| Instagram            | Browser automation | [browser](/tools/browser) tool |
| LinkedIn             | Browser automation | [browser](/tools/browser) tool |

---

## X (Twitter) — Automated Posting with xurl

The [xurl skill](/skills) provides direct X API access. Combined with
[cron jobs](/automation/cron-jobs), you can schedule fully automated posting.

### Prerequisites

1. Install xurl: `npm install -g @xdevplatform/xurl`
2. Authenticate: `xurl auth oauth2` (do this manually, not through the agent)
3. Verify: `xurl auth status`

### Post from an agent

In your agent's `SOUL.md` or `HEARTBEAT.md`, instruct the agent to post:

```markdown
## X Posting Workflow

When creating X posts:

1. Draft the post text (≤280 chars)
2. Run `xurl post "your text here"`
3. If posting with media, upload first: `xurl media upload image.jpg`
4. Then post with media: `xurl post "text" --media-id MEDIA_ID`
```

### Schedule daily posts with cron

Create a cron job that triggers an agent to generate and post content:

```bash
openclaw cron add \
  --name "Daily X post" \
  --cron "0 10 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Generate and post today's content to X. Topic: AI video generation trends. Keep it engaging, under 280 chars. Use xurl post to publish." \
  --announce
```

### Multi-post workflow (threads)

```bash
# Post a thread by replying to your own posts
xurl post "1/5 Thread on AI video generation in 2026..."
# Get the post ID from the response, then:
xurl reply POST_ID "2/5 The key players are..."
xurl reply POST_ID "3/5 What makes this different..."
```

### Monitor engagement

```bash
# Check mentions and replies
xurl mentions -n 20

# Read a specific post's metrics
xurl read POST_ID

# Search for your brand mentions
xurl search "your-brand OR @yourhandle" -n 20
```

---

## Xiaohongshu (小红书) — Browser Automation

Xiaohongshu doesn't offer a public posting API, so OpenClaw uses
[browser automation](/tools/browser) to create posts through the web interface.

### Browser Setup

1. Set up the OpenClaw browser: `openclaw browser start`
2. Log in to Xiaohongshu manually in the browser first (session persists)
3. See [Browser login persistence](/tools/browser-login) for keeping sessions alive

### Posting workflow

Use the browser tool to navigate and fill in the Xiaohongshu creator interface:

```markdown
## Xiaohongshu Posting (in SOUL.md)

When posting to Xiaohongshu:

1. Use browser to navigate to https://creator.xiaohongshu.com/publish/publish
2. Take a snapshot to see the current UI state
3. Upload images using the upload button
4. Fill in the title (≤20 chars recommended)
5. Fill in the content body
6. Add relevant hashtags (#AI视频 #科技)
7. Click publish
8. Verify the post was published successfully
```

### Scheduling Xiaohongshu posts

Combine browser automation with cron for scheduled posting:

```bash
openclaw cron add \
  --name "Daily Xiaohongshu post" \
  --cron "0 12 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "Create and publish a Xiaohongshu post about today's AI video trend. Use browser automation to post on creator.xiaohongshu.com. Include relevant Chinese hashtags." \
  --announce
```

### Tips for Xiaohongshu automation

- **Image-first platform**: always include compelling images or cover photos
- **Hashtags**: use trending Chinese hashtags for discoverability
- **Timing**: post during peak hours (12:00–14:00, 19:00–22:00 CST)
- **Content style**: conversational, personal tone works best on 小红书
- **Session persistence**: check browser login status before posting — sessions can expire

---

## Multi-Agent Social Media Setup

For teams managing multiple platforms, use OpenClaw's
[multi-agent](/concepts/multi-agent) feature to dedicate agents to different tasks:

```
agents/
├── social/          # Social media agent
│   ├── SOUL.md      # Posting guidelines, brand voice
│   ├── AGENTS.md    # Platform credentials, workflow rules
│   └── memory/      # Post history, engagement metrics
├── content/         # Content creation agent
│   ├── SOUL.md      # Writing style, topics
│   └── memory/      # Content calendar, drafts
└── shared/          # Shared assets
    ├── brand/       # Brand guidelines, logos
    └── content-queue/  # Pending posts across platforms
```

### Content pipeline

1. **Content agent** generates drafts → writes to `shared/content-queue/`
2. **Social agent** picks up drafts → posts to X, Xiaohongshu, etc.
3. **Cron job** triggers the pipeline on schedule

Example cron for the content pipeline:

```bash
# Content agent generates daily content
openclaw cron add \
  --name "Generate content" \
  --cron "0 8 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --agent content \
  --message "Generate today's social media content for all platforms. Save drafts to ~/agents/shared/content-queue/" \
  --announce

# Social agent posts content
openclaw cron add \
  --name "Post to X" \
  --cron "0 10 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --agent social \
  --message "Check ~/agents/shared/content-queue/ for pending posts. Post to X using xurl. Mark posted items as done." \
  --announce
```

---

## Best Practices

### Content quality

- **Don't spam**: maintain natural posting frequency (2–5 posts/day on X, 1–2 on Xiaohongshu)
- **Platform-native**: adapt tone and format for each platform
- **Engagement**: monitor replies and mentions; respond authentically
- **A/B testing**: track which content styles perform best

### Reliability

- **Verify posts**: always check the response after posting
- **Error handling**: retry failed posts; log errors to agent memory
- **Rate limits**: respect platform rate limits (X API has per-endpoint limits)
- **Session checks**: for browser-based platforms, verify login before posting

### Security

- **Credentials**: never expose API keys or tokens in agent context
- **Browser sessions**: use dedicated browser profiles for social accounts
- **Audit trail**: log all automated posts to agent memory for review

---

## See Also

- [xurl skill](/skills) — X/Twitter CLI tool
- [Browser automation](/tools/browser) — for platforms without APIs
- [Browser login persistence](/tools/browser-login) — keeping sessions alive
- [Cron jobs](/automation/cron-jobs) — scheduling automated tasks
- [Multi-agent routing](/concepts/multi-agent) — dedicating agents to tasks
