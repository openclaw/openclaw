# TOOLS.md - Clawdbot Development Tools

## Build & Run

```bash
cd /Users/dgarson/clawd/clawdbot
pnpm install          # Install dependencies
pnpm build            # Build TypeScript
pnpm test             # Run tests
pnpm start            # Start the bot
pnpm dev              # Dev mode with hot reload
```

## Key Technologies

- **Discord.js**: Discord API client library
- **TypeScript**: Strict mode
- **Node.js**: Runtime
- **WebSocket**: Discord Gateway connection

## Bot Architecture

- Message handlers: Process incoming Discord messages
- Command system: Slash commands and text commands
- Event handlers: Join, leave, reaction, thread events
- OpenClaw integration: Forward messages to gateway for AI responses

## Discord API Notes

- Rate limits: 50 requests/second per route
- Message length: 2000 chars max (use embeds for longer)
- Gateway intents: Must be enabled in Discord developer portal
- Bot token: Stored securely, never commit to git

## Deployment

- The bot runs as a long-running Node.js process
- Must handle reconnections gracefully (Discord disconnects periodically)
- Log errors but don't crash — use try/catch around event handlers
