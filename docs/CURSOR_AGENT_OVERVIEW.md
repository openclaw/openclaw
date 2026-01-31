# Cursor Agent Integration for OpenClaw

## What is This?

This project integrates **Cursor's Background Agents API** with **OpenClaw**, enabling you to send coding tasks to Cursor's AI from any messaging platform (WhatsApp, Telegram, Slack, Discord, etc.) and receive the results back.

```
┌─────────────────┐                      ┌─────────────────┐
│   You (User)    │                      │  Cursor Agent   │
│                 │                      │  (AI Coder)     │
│  "Fix the bug   │                      │                 │
│   in utils.ts"  │                      │  - Clones repo  │
│                 │                      │  - Writes code  │
└────────┬────────┘                      │  - Creates PR   │
         │                               └────────▲────────┘
         │ WhatsApp/Telegram/Slack/etc.           │
         ▼                                        │
┌─────────────────┐      Launch Task      ┌──────┴────────┐
│    OpenClaw     │ ──────────────────▶  │  Cursor API   │
│    Gateway      │                       │               │
│                 │ ◀────────────────────│  (Webhook)    │
└─────────────────┘      Results + PR     └───────────────┘
         │
         │ "✅ Done! PR: github.com/..."
         ▼
┌─────────────────┐
│   You (User)    │
└─────────────────┘
```

## Why?

- **Code from anywhere**: Send coding tasks from your phone while commuting
- **Async workflow**: Start a task, get notified when it's done
- **Multi-channel**: Use whatever messaging app you prefer
- **PR automation**: Cursor creates branches and pull requests automatically

## Key Components

### 1. OpenClaw

An open-source personal AI assistant that connects to messaging platforms. Think of it as a bridge between you and AI services.

- GitHub: https://github.com/openclaw/openclaw
- Supports: WhatsApp, Telegram, Slack, Discord, Signal, iMessage, and more

### 2. Cursor Background Agents

Cursor's cloud-based AI coding agents that can:

- Clone repositories
- Understand codebases
- Write and modify code
- Create branches and pull requests

- Docs: https://cursor.com/docs/agent/overview
- API: https://cursor.com/docs/background-agent/api/

### 3. This Integration

A channel plugin for OpenClaw that:

- Receives messages from any OpenClaw channel
- Sends them to Cursor's Background Agents API
- Receives webhook notifications when tasks complete
- Routes results back to the original conversation

## How It Works

### 1. You Send a Message

From WhatsApp, Telegram, or any connected channel:

```
Fix the authentication bug in src/auth/login.ts
@repo:https://github.com/mycompany/webapp
@branch:main
```

### 2. OpenClaw Processes It

The Cursor Agent channel plugin:

- Extracts the repository URL and branch
- Formats the instructions
- Calls Cursor's API to launch an agent

### 3. Cursor Agent Works

Cursor's cloud agent:

- Clones your repository
- Analyzes the codebase
- Makes the requested changes
- Creates a new branch
- Opens a pull request

### 4. You Get Results

Back in your chat:

```
✅ Cursor Agent Task Completed

Summary: Fixed null check in authentication flow

Pull Request: https://github.com/mycompany/webapp/pull/42
Branch: cursor/fix-auth-bug-abc123

View in Cursor
```

## Project Structure

```
cursor-agent-openclaw/
├── extensions/cursor-agent/     # The integration plugin
│   ├── src/
│   │   ├── api.ts              # Cursor API client
│   │   ├── plugin.ts           # OpenClaw channel plugin
│   │   ├── monitor.ts          # Webhook handler
│   │   ├── outbound.ts         # Message sending
│   │   └── ...
│   ├── scripts/
│   │   ├── test-api.ts         # CLI test tool
│   │   └── mock-cursor-api.ts  # Mock server for testing
│   └── README.md
├── dev/                         # Local dev environment
│   ├── config/                 # Isolated config
│   ├── data/                   # Isolated data
│   └── *.sh                    # Dev scripts
└── docs/                        # Documentation
```

## Quick Start

### 1. Setup Dev Environment

```bash
./dev/setup.sh
```

### 2. Start Mock Server (for testing without API key)

```bash
./dev/mock-cursor.sh
```

### 3. Start Gateway

```bash
CURSOR_API_BASE_URL=http://localhost:3456 ./dev/start.sh
```

### 4. Test

```bash
./dev/test-cursor.sh launch "Add a README" https://github.com/test/repo
```

## Next Steps

- [Architecture Deep Dive](./ARCHITECTURE.md)
- [Development Guide](./DEVELOPMENT.md)
- [API Reference](./API_REFERENCE.md)
