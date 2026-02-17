# Agent System - Operating Instructions

## Architecture

```
YOU (via Telegram/WhatsApp/Discord/CLI)
  │
  ▼
COMMANDER (orchestrator)
  ├── RESEARCHER (AI news scout)
  ├── CREATOR (content & creative)
  ├── DEPLOYER (sites & code)
  └── VOICE (TTS & cloning)
```

## How It Works

1. **All messages go to Commander** - routes tasks to the right agent
2. **Agents work independently** - each has its own session and skills
3. **Research runs automatically** - cron scans X.com, HackerNews, GitHub daily
4. **Agents propose work** - they find opportunities and ask before acting
5. **You approve or reject** - nothing publishes without your OK

## Quick Commands

| Say this                 | What happens                         |
| ------------------------ | ------------------------------------ |
| "Status"                 | Commander reports all agent activity |
| "Research AI agents"     | Researcher scans all sources         |
| "Write a blog about X"   | Creator drafts content               |
| "Deploy my site"         | Deployer handles deployment          |
| "Clone this voice"       | Voice agent processes audio          |
| "Creative mode"          | Creator enters autonomous brainstorm |
| "What's new?"            | Researcher shares latest findings    |
| "Assign X to researcher" | Direct task assignment               |

## Automated Schedule

| Time          | Agent      | Task                 |
| ------------- | ---------- | -------------------- |
| 08:00 daily   | Researcher | Morning AI digest    |
| 09:30 Mon-Fri | Creator    | Content proposals    |
| 10:00 Sunday  | Researcher | Weekly deep research |
| Every 6h      | Commander  | System health check  |

## Agent Rules

1. **Never publish without approval** - agents propose, you decide
2. **Max 4 concurrent agents** - prevents Mac overload
3. **Free models only** - Kimi K2.5 default, DeepSeek/MiMo fallback
4. **Auto-archive at 60 min** - idle agents clean up automatically
5. **Research is cached** - same queries don't re-fetch within 15 min

## Workspace Structure

```
~/workspace/
├── research/
│   ├── digest-YYYY-MM-DD.md      (daily research digest)
│   ├── weekly-YYYY-MM-DD.md      (weekly deep research)
│   └── topics.md                  (running topic list)
├── content/
│   ├── proposals/                 (content proposals)
│   ├── blog/                      (blog drafts)
│   ├── social/                    (social media posts)
│   └── scripts/                   (video scripts)
└── deployments/
    └── log.md                     (deployment history)
```

## Proposal Format

When agents find work, they ask:

```
[PROPOSAL] Topic: <what they found>
Source: <where they found it>
Action: <what they want to do>
Effort: low/medium/high
```

Reply "go" to approve, "skip" to reject, or give specific instructions.

## Troubleshooting

- **Agent stuck?** → "Reset researcher" or "Kill all sub-agents"
- **Too slow?** → Reduce concurrent agents: `maxConcurrent: 2`
- **Wrong agent?** → "Reassign this to deployer"
- **Mac hot?** → "Pause all agents" then resume one at a time
