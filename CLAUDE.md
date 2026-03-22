# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.


 开发环境配置

  ┌────────────┬───────────────────────────────┐
  │    项目    │            路径/值            │
  ├────────────┼───────────────────────────────┤
  │ 配置目录   │ ~/.openclaw-dev/              │
  ├────────────┼───────────────────────────────┤
  │ 配置文件   │ ~/.openclaw-dev/openclaw.json │
  ├────────────┼───────────────────────────────┤
  │ 工作区     │ ~/.openclaw/workspace-dev     │
  ├────────────┼───────────────────────────────┤
  │ 默认 Agent │ dev                           │
  └────────────┴───────────────────────────────┘

❯   pnpm gateway:dev    

llm 集成：
1 只支持openai和ollama
2 简单直接主流


## Build, Test, and Run Commands

```bash
pnpm install              # Install dependencies
pnpm dev                  # Run CLI in dev mode (auto-builds on TS changes)
pnpm openclaw <command>   # Run any CLI command via tsx
pnpm build                # Build to dist/
pnpm check                # Type-check with tsgo
```

### Common CLI Commands

```bash
openclaw gateway --port 3000 --verbose   # Start gateway server
openclaw agent --message "..."           # Send message to agent
openclaw message send --to <number> --message "..."  # Send channel message
openclaw pairing approve <channel> <code>  # Approve paired device
openclaw doctor                          # Health check
openclaw update --channel stable|beta|dev  # Switch release channel
```

### Running Single Test File

No test framework is configured (tests were removed from this codebase).

## High-Level Architecture

**OpenClaw** is a personal AI assistant that runs locally, connecting to multiple messaging channels and AI model providers.

### Core Components

1. **Gateway** (`src/gateway/`) - WebSocket control plane for sessions, channels, tools, and events. Default port: 3000.

2. **Agent Runtime** (`src/agents/`) - Pi agent core with session management, tool execution, model failover.

3. **Channels** (`src/channels/`) - Multi-channel inbox:
   - WhatsApp, Telegram, Slack, Discord, Google Chat, Signal
   - iMessage, BlueBubbles, IRC, Microsoft Teams, Matrix
   - Feishu, LINE, Mattermost, Nextcloud Talk, Nostr
   - Synology Chat, Tlon, Twitch, Zalo

4. **Extensions** (`extensions/`) - Optional plugins:
   - `device-pair` - Device pairing for Feishu pairing mode
   - `copilot-proxy` - GitHub Copilot model provider
   - `acpx` - ACP runtime backend
   - `feishu` - Feishu channel integration

5. **CLI** (`src/cli/`, `src/commands/`) - Command interface built with Commander.

6. **Plugin SDK** (`src/plugin-sdk/`) - Extension development API.

7. **ACP** (`src/acp/`) - Agent Communication Protocol backend with MCP server support.

8. **Node Host** (`src/node-host/`) - Remote node execution (e.g., voicewake, talk mode).

### Data Flow

1. Inbound messages arrive via channel adapters (Telegram bot, Discord webhook, etc.)
2. Gateway routes to appropriate agent session based on channel/account
3. Agent processes message using Pi agent core with tool execution
4. Response sent back via same channel adapter

### Configuration

- **User config**: `~/.openclaw/openclaw.json`
- **Credentials**: `~/.openclaw/credentials/`
- **Sessions**: `~/.openclaw/agents/<agentId>/sessions/`
- **Device identity**: `~/.openclaw/device-identity.json`

### Key Patterns

- **Dependency injection**: `createDefaultDeps()` in `src/cli/deps.ts`
- **Channel abstraction**: All channels implement common interface
- **Session isolation**: Per-channel/account sessions with queue management
- **Plugin system**: Extensions register tools, HTTP routes, UI components

### Security Model

- **DM pairing**: Default mode requires explicit approval for unknown senders
- **Allowlist**: Approved senders stored locally
- **Auth profiles**: OAuth rotation for model providers

## TypeScript Configuration

- **Module system**: NodeNext (ESM)
- **Target**: ES2023
- **Strict mode**: Enabled
- **Paths**: `openclaw/plugin-sdk/*` → `src/plugin-sdk/*`

## Files and Directories

- `src/` - Main source code
- `extensions/` - Optional plugins
- `skills/` - Agent skills
- `scripts/` - Build and utility scripts
- `dist/` - Build output (generated)
- `openclaw.mjs` - CLI entry point
