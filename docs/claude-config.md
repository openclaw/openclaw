# Building Your Own AI Personal Assistant with Warelay

> **TL;DR:** Warelay lets you turn Claude into a proactive personal assistant that lives in your pocket via WhatsApp. It can check in on you, remember context across conversations, run commands on your Mac, and even wake you up with music. This doc shows you how.

---

## ⚠️ Warning: Here Be Dragons

**This setup gives an AI full access to your computer.** Before you proceed, understand what you're signing up for:

- 🔓 **`--dangerously-skip-permissions`** means Claude can run *any* shell command without asking
- 💸 **Costs add up fast** - Opus 4.5 with extended thinking on every message isn't cheap
- 🤖 **AI makes mistakes** - it might delete files, send emails, or do things you didn't intend
- 🔥 **Heartbeats run autonomously** - your AI acts even when you're not watching
- 📱 **WhatsApp is not encrypted E2E here** - messages pass through your Mac in plaintext

**Start conservative:**
1. Use `claude-sonnet-4-5` instead of Opus (faster, cheaper, still great)
2. Skip `--dangerously-skip-permissions` until you trust the setup
3. Set `heartbeatMinutes: 0` to disable proactive pings initially
4. Use a test phone number in `allowFrom` first

This is experimental software running experimental AI. The author uses it daily, but your mileage may vary. **You are responsible for what your AI does.**

---

## Meet Clawd 👋

Clawd is @steipete's personal AI assistant built on warelay. Here's what makes it special:

- **Always available** via WhatsApp - no app switching, works on any device
- **Proactive heartbeats** - Clawd checks in every 10 minutes and can alert you to things (low battery, calendar reminders, anything it notices)
- **Persistent memory** - conversations span days/weeks with full context
- **Full Mac access** - can run commands, take screenshots, control Spotify, read/write files
- **Personal workspace** - has its own folder (`~/clawd`) where it stores notes, memories, and artifacts

The magic is in the combination: WhatsApp's ubiquity + Claude's intelligence + warelay's plumbing + your Mac's capabilities.

## Prerequisites

- Node 22+, `warelay` installed: `npm install -g warelay`
- Claude CLI installed and logged in:
  ```sh
  brew install anthropic-ai/cli/claude
  claude login
  ```
- Optional: set `ANTHROPIC_API_KEY` in your shell profile for non-interactive use

## The Config That Powers Clawd

This is the actual config running on @steipete's Mac (`~/.warelay/warelay.json`):

```json5
{
  logging: { level: "trace", file: "/tmp/warelay/warelay.log" },
  inbound: {
    allowFrom: ["+1234567890"],  // your phone number
    reply: {
      mode: "command",
      cwd: "/Users/steipete/clawd",              // Clawd's home - give your AI a workspace!
      bodyPrefix: "ultrathink ",                 // triggers extended thinking on every message
      sessionIntro: "You are Clawd, an AI assistant running on the user's Mac. User writes messages via WhatsApp and you respond. This folder (/Users/steipete/clawd) is your personal workspace - you can store Markdown files, images, notes, and any data you like here. Keep WhatsApp replies under 1500 characters (platform limit), but feel free to save longer content to files in your folder.",
      command: [
        "claude",
        "--model", "claude-opus-4-5-20251101",   // or claude-sonnet-4-5 for faster/cheaper
        "-p",
        "--output-format", "json",
        "--dangerously-skip-permissions",        // lets Claude run commands freely
        "{{BodyStripped}}"
      ],
      session: {
        scope: "per-sender",
        resetTriggers: ["/new"],                 // say /new to start fresh
        idleMinutes: 10080,                      // 7 days of context!
        heartbeatIdleMinutes: 10080,
        sessionArgNew: ["--session-id", "{{SessionId}}"],
        sessionArgResume: ["--resume", "{{SessionId}}"],
        sessionArgBeforeBody: true,
        sendSystemOnce: true                     // intro only on first message
      },
      timeoutSeconds: 900                        // 15 min timeout for complex tasks
    }
  }
}
```

### Key Design Decisions

| Setting | Why |
|---------|-----|
| `cwd: ~/clawd` | Give your AI a home! It can store memories, notes, images here |
| `bodyPrefix: "ultrathink "` | Extended thinking = better reasoning on every message |
| `idleMinutes: 10080` | 7 days of context - your AI remembers conversations |
| `sendSystemOnce: true` | Intro prompt only on first message, saves tokens |
| `--dangerously-skip-permissions` | Full autonomy - Claude can run any command |

## Heartbeats: Your Proactive Assistant

This is where warelay gets interesting. Every 10 minutes (configurable), warelay pings Claude with:

```
HEARTBEAT ultrathink
```

Claude is instructed to reply with exactly `HEARTBEAT_OK` if nothing needs attention. That response is **suppressed** - you don't see it. But if Claude notices something worth mentioning, it sends a real message.

### What Can Heartbeats Do?

Clawd uses heartbeats to:
- 🔋 **Monitor battery** - warns when laptop is low
- ⏰ **Wake-up alarms** - checks the time and triggers alarms (voice + music!)
- 📅 **Calendar reminders** - surfaces upcoming events
- 🌤️ **Contextual updates** - weather, travel info, whatever's relevant
- 💡 **Surprise check-ins** - occasionally just says hi with something fun

The key insight: heartbeats let your AI be **proactive**, not just reactive.

### Heartbeat Config

```json5
{
  inbound: {
    reply: {
      heartbeatMinutes: 10,  // how often to ping (default 10 for command mode)
      // ... rest of config
    }
  }
}
```

Set to `0` to disable heartbeats entirely.

### Manual Heartbeat

Test it anytime:
```sh
warelay heartbeat --provider web --to +1234567890 --verbose
```

## How Messages Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  WhatsApp   │────▶│   warelay   │────▶│   Claude    │────▶│  Your Mac   │
│  (phone)    │◀────│   relay     │◀────│   CLI       │◀────│  (commands) │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

1. **Inbound**: WhatsApp message arrives via Baileys (WhatsApp Web protocol)
2. **Queue**: warelay queues it (one Claude run at a time)
3. **Typing**: "composing" indicator shows while Claude thinks
4. **Execute**: Claude runs with full shell access in your `cwd`
5. **Parse**: warelay extracts text + any `MEDIA:` paths from output
6. **Reply**: Response sent back to WhatsApp

## Media: Images, Voice, Documents

### Receiving Media
Inbound images/audio/video are downloaded and available as `{{MediaPath}}`. Voice notes can be auto-transcribed:

```json5
{
  inbound: {
    transcribeAudio: {
      command: "openai api audio.transcriptions.create -m whisper-1 -f {{MediaPath}} --response-format text"
    }
  }
}
```

### Sending Media
Include `MEDIA:/path/to/file.png` in Claude's output to attach images. warelay handles resizing and format conversion automatically.

## Starting the Relay

```sh
# Foreground (see all logs)
warelay relay --provider web --verbose

# Background in tmux (recommended)
warelay relay:tmux

# With immediate heartbeat on startup
warelay relay:heartbeat:tmux
```

## Tips for a Great Personal Assistant

1. **Give it a home** - A dedicated folder (`~/clawd`) lets your AI build persistent memory
2. **Use extended thinking** - `bodyPrefix: "ultrathink "` dramatically improves reasoning
3. **Long sessions** - 7-day `idleMinutes` means rich context across conversations
4. **Let it surprise you** - Configure heartbeats to occasionally share something fun
5. **Trust but verify** - Start with `--dangerously-skip-permissions` off, add it once comfortable

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No reply | Check `claude login` was run in same environment |
| Timeout | Increase `timeoutSeconds` or simplify the task |
| Media fails | Ensure file exists and is under size limits |
| Heartbeat spam | Tune `heartbeatMinutes` or set to 0 |
| Session lost | Check `idleMinutes` hasn't expired; use `/new` to reset |

## Minimal Config (Just Chat)

Don't need the fancy stuff? Here's the simplest setup:

```json5
{
  inbound: {
    reply: {
      mode: "command",
      command: ["claude", "{{Body}}"],
      claudeOutputFormat: "text"
    }
  }
}
```

Still gets you: message queue, typing indicators, auto-reconnect. Just no sessions or heartbeats.

## Recommended MCPs

MCP (Model Context Protocol) servers supercharge your assistant by giving Claude access to external services. Here are the ones Clawd uses daily:

### Essential for Personal Assistant Use

| MCP | What It Does | Install |
|-----|--------------|---------|
| **Google Calendar** | Read/create events, check availability, set reminders | `npx @cocal/google-calendar-mcp` |
| **Gmail** | Search, read, send emails with attachments | `npx @gongrzhe/server-gmail-autoauth-mcp` |
| **Obsidian** | Read/write notes in your Obsidian vault | `npx obsidian-mcp-server@latest` |

### Power User Add-ons

| MCP | What It Does | Install |
|-----|--------------|---------|
| **GitHub** | Manage repos, issues, PRs, code search | `npx @anthropic/mcp-server-github` |
| **Linear** | Project management, create/update issues | Via [mcporter](https://github.com/steipete/mcporter) |
| **Chrome DevTools** | Control browser, take screenshots, debug | `npx chrome-devtools-mcp@latest` |
| **iTerm** | Run commands in visible terminal window | [iterm-mcp](https://github.com/pashpashpash/iterm-mcp) |
| **Firecrawl** | Scrape and parse web pages | Via API key |

### Recommended CLI Tools

These aren't MCPs but work great alongside your assistant:

| Tool | What It Does | Link |
|------|--------------|------|
| **[Peekaboo](https://github.com/steipete/peekaboo)** | macOS screenshots, UI automation, AI vision analysis, click/type anywhere | `brew install steipete/tap/peekaboo` |
| **[mcporter](https://github.com/steipete/mcporter)** | Manage MCPs across AI clients, OAuth flows, health checks | `npm install -g mcporter` |

**Peekaboo** is especially powerful - it lets Claude:
- 📸 Take screenshots of any app or screen
- 🖱️ Click buttons, type text, scroll - full GUI automation
- 👁️ Analyze images with AI vision (GPT-4, Claude, Grok)
- 📋 Extract menu bar items and keyboard shortcuts
- 🪟 List and manage windows across displays

Example: "Take a screenshot of Safari and tell me what's on the page" or "Click the Submit button in the frontmost app"

### Adding MCPs to Claude Code

```bash
# Add an MCP server (run from your cwd folder)
claude mcp add google-calendar -- npx @cocal/google-calendar-mcp

# With environment variables
claude mcp add gmail -e GMAIL_OAUTH_PATH=~/.gmail-mcp -- npx @gongrzhe/server-gmail-autoauth-mcp

# List configured servers
claude mcp list

# Check health
claude mcp list  # shows status for each
```

### MCP Manager: mcporter

For managing multiple MCPs across different AI clients, check out [mcporter](https://github.com/steipete/mcporter):

```bash
# Install
npm install -g mcporter

# List all servers with health status
mcporter list

# Sync config to all AI clients
mcporter sync
```

mcporter handles OAuth flows for services like Linear and Notion, and keeps your MCP configs in sync across Claude Code, Cursor, and other clients.

### Pro Tips

1. **Calendar + Heartbeats** = Your AI reminds you of upcoming meetings
2. **Gmail + Obsidian** = AI can search emails and save summaries to notes
3. **GitHub + Linear** = AI manages your dev workflow end-to-end
4. **Chrome DevTools** = AI can see and interact with web pages

The combination of warelay (WhatsApp) + MCPs (services) + Claude Code (execution) creates a surprisingly capable personal assistant.

---

*Built by [@steipete](https://twitter.com/steipete). PRs welcome!*
