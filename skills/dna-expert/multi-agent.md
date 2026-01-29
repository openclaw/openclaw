# Multi-Agent Architecture

## Overview

Running multiple businesses requires isolated agents—each with separate workspaces, credentials, sessions, and personalities. DNA routes messages deterministically based on channel, account, or contact.

## Configuration

```json
{
  "agents": {
    "list": [
      {
        "id": "store1",
        "name": "Fashion Store",
        "workspace": "~/clawd-fashion",
        "model": { "primary": "anthropic/claude-sonnet-4-5" }
      },
      {
        "id": "store2",
        "name": "Electronics Store",
        "workspace": "~/clawd-electronics",
        "model": { "primary": "anthropic/claude-opus-4-5" }
      },
      {
        "id": "personal",
        "default": true,
        "name": "Personal",
        "workspace": "~/clawd-personal"
      }
    ]
  },
  "bindings": [
    { "agentId": "store1", "match": { "channel": "whatsapp", "accountId": "fashion-biz" } },
    { "agentId": "store2", "match": { "channel": "whatsapp", "accountId": "electronics-biz" } },
    { "agentId": "personal", "match": { "channel": "whatsapp", "accountId": "personal" } }
  ]
}
```

## Routing Priority (Most-Specific Wins)

1. Exact peer match (DM/group ID)
2. Guild ID (Discord)
3. Team ID (Slack)
4. Account ID match
5. Channel-level match
6. Default agent fallback

## Binding Match Options

```json
{
  "match": {
    "channel": "whatsapp",       // Channel name
    "accountId": "business-1",   // WhatsApp Business account
    "peerId": "123456789@c.us",  // Specific contact/group
    "guildId": "discord-server", // Discord server
    "teamId": "slack-workspace"  // Slack workspace
  }
}
```

## E-Commerce Best Practices

### Dedicated Agents Per Business

Each business gets:
- Isolated workspace directory
- Unique SOUL.md for brand personality
- Separate auth profiles
- Independent session history

### Workspace Structure Per Agent

```
~/clawd-fashion/
├── AGENTS.md        # Fashion-specific capabilities
├── SOUL.md          # Brand voice: "I'm your fashion assistant..."
├── USER.md          # Store owner preferences
├── MEMORY.md        # Product knowledge, customer history
└── skills/          # Store-specific skills
    └── inventory/
```

### Security Per Agent

```json
{
  "agents": {
    "list": [
      {
        "id": "store1",
        "sandbox": { "mode": "all" }  // Sandboxed for group chats
      }
    ]
  }
}
```

### Route Different WhatsApp Business Accounts

Each WhatsApp Business account routes to a different agent:

```json
{
  "bindings": [
    { "agentId": "fashion", "match": { "accountId": "fashion-account-id" } },
    { "agentId": "electronics", "match": { "accountId": "electronics-account-id" } }
  ]
}
```

## Model Selection Per Agent

Different agents can use different models based on needs:

| Agent Type | Recommended Model | Reason |
|------------|-------------------|--------|
| Customer-facing | Claude Opus 4.5 | Security, quality |
| Internal ops | Claude Sonnet 4.5 | Cost-effective |
| Simple tasks | Free tier | Budget |

## Session Isolation

Each agent maintains independent sessions:
- No cross-contamination of context
- Separate memory files
- Independent cron jobs

```bash
# Check sessions per agent
ls ~/.dna/agents/*/sessions/
```
