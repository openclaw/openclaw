---
summary: "Advanced X (Twitter) posting workflows — threads, media, engagement loops, and content pipelines with xurl + cron"
read_when:
  - Building automated X/Twitter posting workflows
  - Creating thread strategies with xurl
  - Setting up engagement monitoring and auto-reply
  - Integrating X posting into multi-agent pipelines
title: "X Posting Workflows"
---

# X Posting Workflows

Advanced patterns for automating X (Twitter) with OpenClaw agents, the
xurl skill, and [cron scheduling](/automation/cron-jobs).

<!-- TODO: link to /automation/social-media once the page exists -->

---

## Content Generation → Post Pipeline

### Agent-driven content creation

Configure your agent to generate platform-optimized content. In your agent's `SOUL.md`:

```markdown
## X Content Guidelines

When creating X posts:

- Hook in the first line (question, bold claim, or surprising stat)
- Keep under 280 characters for single posts
- Use line breaks for readability
- End with a call-to-action or question to drive engagement
- No more than 2 hashtags per post
- Avoid generic hashtags (#AI) — use specific ones (#AIVideo #Veo3)
```

### Scheduled content pipeline

Use a cron job to trigger daily content generation and posting:

```bash
openclaw cron add \
  --name "X content pipeline" \
  --cron "0 10,15,20 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Generate and post one engaging X post about AI video generation. Research current trends first (web_search), then craft the post. Use xurl post to publish. Log the post ID and text to memory." \
  --announce
```

This creates posts at 10 AM, 3 PM, and 8 PM — hitting different audience time zones.

---

## Thread Workflows

Threads are powerful for long-form content on X. Here's how to automate them:

### Basic thread pattern

```bash
# Post the first tweet
xurl post "🧵 Thread: Why AI video generation is about to change everything..."

# Get the post ID from the JSON response, then chain replies
xurl reply FIRST_POST_ID "1/ The quality gap between AI and human-shot video is closing fast..."
xurl reply FIRST_POST_ID "2/ Key players in 2026: Google Veo 3, Kling 3.0, Sora 2 Pro..."
xurl reply FIRST_POST_ID "3/ What this means for creators..."
xurl reply FIRST_POST_ID "4/ The tools you should try today..."
```

### Agent-driven thread generation

In your agent workflow:

```markdown
## Thread Workflow

When creating an X thread:

1. Draft 4-6 tweets, each under 280 chars
2. First tweet: hook + "🧵" indicator
3. Post first tweet with `xurl post`
4. Parse the post ID from the JSON response (data.id)
5. Reply to that ID for each subsequent tweet with `xurl reply`
6. Final tweet: summary + CTA
7. Log all post IDs to memory for tracking
```

---

## Media Posting

### Image posts

```bash
# Upload image first
xurl media upload ./chart.png
# Response includes media_id, use it in the post
xurl post "AI video quality comparison 2025 vs 2026 📊" --media-id MEDIA_ID
```

### Video posts

```bash
# Upload video (processing may take time)
xurl media upload ./demo.mp4

# Check processing status
xurl media status MEDIA_ID --wait

# Post when ready
xurl post "Watch this AI-generated video 🎬" --media-id MEDIA_ID
```

### Agent workflow with generated images

```markdown
## Media Post Workflow

When posting with images:

1. Generate or locate the image file
2. Upload with `xurl media upload <path>`
3. Extract media_id from the response JSON
4. Post with `xurl post "text" --media-id <id>`
5. Verify the post includes the image by reading it back
```

---

## Engagement Monitoring

### Track mentions and replies

```bash
# Check recent mentions
xurl mentions -n 20

# Search for brand mentions (including without @)
xurl search "kubrix OR \"AI video generator\"" -n 20

# Read engagement metrics on a specific post
xurl read POST_ID
```

### Automated engagement loop

Schedule a cron job to monitor and respond:

```bash
openclaw cron add \
  --name "X engagement check" \
  --cron "0 */4 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Check X mentions with 'xurl mentions -n 10'. For genuine questions or positive mentions, craft a helpful reply. Use 'xurl reply POST_ID response'. Don't reply to spam or trolls. Log interactions to memory." \
  --announce
```

---

## Analytics & Optimization

### Track post performance

Have your agent periodically check how posts performed:

```bash
openclaw cron add \
  --name "X analytics" \
  --cron "0 9 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Review this week's X posts from memory. For each post ID, run 'xurl read POST_ID' to get metrics. Summarize: which topics got the most engagement? What posting times worked best? Save insights to memory for future content strategy." \
  --announce
```

### A/B testing content styles

```markdown
## Content Testing (in SOUL.md)

Track two content approaches this week:

- Style A: Question-led posts ("Did you know...?")
- Style B: Statement-led posts ("Here's why...")

Tag each post in memory with its style. At week's end, compare engagement.
```

---

## Multi-Account Management

For managing multiple X accounts (e.g., personal + brand):

```bash
# Set up apps for each account (do this manually, outside agent context)
# Then switch in agent workflows:

xurl --app personal post "Personal take on..."
xurl --app brand post "Official announcement:..."

# Or set defaults before a batch
xurl auth default brand
xurl post "Brand post 1"
xurl post "Brand post 2"
xurl auth default personal
```

---

## Error Handling

Common issues and how agents should handle them:

| Error                 | Cause                        | Agent Action                            |
| --------------------- | ---------------------------- | --------------------------------------- |
| 429 Too Many Requests | Rate limit                   | Wait 15 minutes, retry                  |
| 403 Forbidden         | Token scope issue            | Log error, notify user to re-auth       |
| 400 Duplicate         | Same text posted recently    | Modify text slightly, retry             |
| Media upload timeout  | Large file / slow connection | Retry upload, check `xurl media status` |

---

## See Also

- [Cron jobs](/automation/cron-jobs) — scheduling fundamentals
- [Browser automation](/tools/browser) — for platforms without APIs
