# Moltbot Mini

A minimal, secure email assistant demonstrating core Moltbot architectural patterns in ~800 lines of code.

## Features

- **Gmail Integration**: Read, search, send, archive, and organize emails
- **OpenAI-Powered**: Natural language interface with function calling
- **Secure by Default**: File permissions (0o600), atomic writes, credential isolation
- **CLI-First**: Simple command-line interface

## Architecture Overview

```
moltbot-mini/
├── src/
│   ├── index.ts           # CLI entry point (Commander.js)
│   ├── cli/
│   │   └── commands.ts    # Command implementations
│   ├── config/
│   │   ├── index.ts       # Config loading/saving
│   │   └── schema.ts      # Zod validation schemas
│   ├── gmail/
│   │   ├── auth.ts        # OAuth2 authentication
│   │   ├── client.ts      # Gmail API operations
│   │   └── types.ts       # Type definitions
│   ├── agent/
│   │   ├── index.ts       # OpenAI chat orchestrator
│   │   └── tools.ts       # Email tool definitions
│   └── security/
│       └── credentials.ts # Secure credential storage
└── package.json
```

## Design Patterns from Moltbot

| Pattern | Implementation | Location |
|---------|---------------|----------|
| Secure Storage | 0o600 permissions, atomic writes | `security/credentials.ts` |
| Schema Validation | Zod schemas with defaults | `config/schema.ts` |
| Tool System | OpenAI function calling | `agent/tools.ts` |
| Adapter Pattern | Gmail client abstraction | `gmail/client.ts` |
| Separation of Concerns | CLI/Config/Gmail/Agent layers | Directory structure |

## Quick Start

### Prerequisites

- Node.js 20+
- OpenAI API key
- Google Cloud project with Gmail API enabled

### Installation

```bash
cd moltbot-mini
npm install
npm run build
```

### Setup

```bash
# Interactive setup
npm run dev -- setup

# Or configure individually
npm run dev -- config set-openai-key sk-your-key
npm run dev -- gmail auth
```

### Usage

```bash
# Interactive chat
npm run dev -- chat

# Single question
npm run dev -- ask "What unread emails do I have?"

# List recent emails
npm run dev -- gmail list -n 5

# Check status
npm run dev -- status

# Security audit
npm run dev -- security
```

## Gmail OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a new project or select existing
3. Enable the Gmail API
4. Create OAuth 2.0 credentials (Desktop app type)
5. Note your Client ID and Client Secret
6. Run `npm run dev -- setup` and enter the credentials

## Security Features

### Credential Storage

All credentials stored in `~/.moltbot-mini/credentials/` with:
- File permissions: `0o600` (owner read/write only)
- Directory permissions: `0o700` (owner only)
- Atomic writes prevent corruption

### Security Audit

```bash
npm run dev -- security
```

Checks for:
- World/group readable credential files
- Insecure directory permissions
- Symlinks to credential files

## Configuration

Configuration stored in `~/.moltbot-mini/config.json`:

```json
{
  "gmail": {
    "enabled": true,
    "maxResults": 20,
    "autoReply": {
      "enabled": false,
      "allowFrom": []
    }
  },
  "openai": {
    "model": "gpt-4o",
    "maxTokens": 4096,
    "temperature": 0.7,
    "systemPrompt": "You are a helpful email assistant..."
  },
  "agent": {
    "name": "Email Assistant",
    "maxHistoryLength": 20
  }
}
```

## Available Tools

The AI assistant can use these tools:

| Tool | Description |
|------|-------------|
| `list_emails` | List/search emails |
| `read_email` | Read full email content |
| `send_email` | Send new email or reply |
| `archive_email` | Archive (remove from inbox) |
| `trash_email` | Move to trash |
| `mark_read` | Mark as read |
| `mark_unread` | Mark as unread |
| `get_unread_count` | Count unread emails |

## Example Conversations

```
You: Show me my unread emails from today
  [Tool: list_emails]
Assistant: You have 3 unread emails today:
1. From: boss@company.com - "Q4 Planning Meeting"
2. From: team@slack.com - "New message in #general"
3. From: news@newsletter.com - "Weekly Digest"

You: Read the email from my boss
  [Tool: read_email]
Assistant: Here's the email from boss@company.com:

Subject: Q4 Planning Meeting
Date: Today at 2:30 PM

Hi team, let's meet tomorrow at 10am to discuss Q4 priorities...

You: Draft a reply confirming I'll attend
  [Tool: send_email]
Assistant: I've sent your reply confirming attendance.
```

## Development

```bash
# Run in development mode
npm run dev -- <command>

# Type check
npm run lint

# Build
npm run build

# Run built version
npm start -- <command>
```

## Comparison with Full Moltbot

| Feature | Moltbot Mini | Full Moltbot |
|---------|--------------|--------------|
| Channels | Gmail only | 10+ (Telegram, Discord, Slack...) |
| LLM Providers | OpenAI only | 6+ (Anthropic, Bedrock, Ollama...) |
| Plugin System | None | Full extension architecture |
| Gateway | None | WebSocket RPC server |
| Mobile Apps | None | iOS, Android, macOS |
| Lines of Code | ~800 | ~100,000+ |

## Learning Path

After understanding this codebase, explore the full Moltbot:

1. **Channel Plugins**: `src/channels/plugins/` - Adapter pattern
2. **Gateway**: `src/gateway/` - RPC orchestration
3. **Agent Tools**: `src/agents/tools/` - Extended tool system
4. **Security**: `src/security/` - Comprehensive audit system

## License

MIT
