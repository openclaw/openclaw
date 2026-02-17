# Vibeclaw Setup Guide

## Prerequisites

- OpenClaw installed and running (`openclaw health` shows OK)
- Anthropic API key configured (`openclaw onboard`)

## Step 1: Enable the Plugin

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "enabled": true,
    "entries": {
      "vibeclaw": {
        "enabled": true,
        "config": {
          "workspace": "~/vibeclaw-workspace"
        }
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "vibeclaw",
        "name": "Vibeclaw Marketing Agent",
        "default": true,
        "workspace": "~/vibeclaw-workspace",
        "skills": [
          "vibeclaw-orchestrator",
          "intent-sniper",
          "content-syndication",
          "directory-submitter",
          "social-content-factory",
          "x-reply-agent",
          "job-sniper",
          "seo-gap-exploiter",
          "community-engagement",
          "skill-learner",
          "youtube-automation",
          "code-factory"
        ]
      }
    ]
  }
}
```

## Step 2: Initialize Workspace

```bash
openclaw vibeclaw init ~/vibeclaw-workspace
```

This creates:

```
~/vibeclaw-workspace/
├── config.json          ← Edit this with your product info
├── campaigns/           ← Campaign state files
├── logs/                ← Agent JSONL logs
├── data/                ← Persistent data (submissions, leads)
├── learnings/           ← Knowledge files (compounding)
│   ├── platforms.md
│   ├── templates.md
│   ├── hooks.md
│   ├── seo.md
│   └── errors.md
└── drafts/              ← Generated content drafts
    ├── social/
    ├── youtube/
    ├── articles/
    └── emails/
```

## Step 3: Configure Your Product

Edit `~/vibeclaw-workspace/config.json`:

```json
{
  "product": {
    "name": "Your Product Name",
    "url": "https://yourproduct.com",
    "description": "One-liner about your product",
    "category": "SaaS",
    "competitors": ["Competitor A", "Competitor B"]
  }
}
```

## Step 4: Verify

```bash
openclaw vibeclaw status
```

Should show:

- Workspace path
- Product name
- Available skills (11 skills)
- Campaign status

## Step 5: Run Your First Campaign

```bash
# Via agent (interactive)
openclaw agent --agent vibeclaw -m "Plan a product launch campaign for my SaaS tool"

# The agent will use vibeclaw_campaign tool to create and manage the campaign
```

## Available CLI Commands

```bash
openclaw vibeclaw init [path]     # Initialize workspace
openclaw vibeclaw status          # Show workspace status
openclaw vibeclaw report [name]   # Generate metrics report
```

## Available Agent Tools

When talking to the vibeclaw agent, these tools are available:

| Tool                | Purpose                                  |
| ------------------- | ---------------------------------------- |
| `vibeclaw_campaign` | Plan, launch, pause, report on campaigns |
| `vibeclaw_status`   | Check workspace and agent metrics        |
| `vibeclaw_learn`    | Record learnings for skill compounding   |
| `vibeclaw_log`      | Write structured agent log entries       |
| `vibeclaw_draft`    | Save/list content drafts                 |
| `vibeclaw_config`   | Read/update workspace config             |

## Environment Variables

| Variable             | Purpose                                 |
| -------------------- | --------------------------------------- |
| `VIBECLAW_WORKSPACE` | Override workspace path                 |
| `X_BEARER_TOKEN`     | X/Twitter API token (for x-reply-agent) |

## Troubleshooting

**Plugin not loading?**

- Run `openclaw plugins list` and check if vibeclaw shows as `loaded`
- Make sure `plugins.entries.vibeclaw.enabled: true` is in your config

**Agent fails with "No API key"?**

- Run `openclaw onboard` to configure your Anthropic API key
- Or set `ANTHROPIC_API_KEY` environment variable

**"unknown command 'vibeclaw'"?**

- The plugin must be enabled before CLI commands register
- Check `openclaw plugins list` first
