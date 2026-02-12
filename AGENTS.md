# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**OpenClaw** (branded as O.R.I.O.N. in user-facing contexts) is a personal AI assistant framework that runs locally on user devices. It provides multi-channel messaging support (WhatsApp, Telegram, Slack, Discord, iMessage, etc.) with built-in browser automation, agent orchestration, and extensible skills.

## Token Governance Rules

### READ POLICY

Read files automatically ONLY when they are direct dependencies of the task at hand.

### PRE-READ CHECK

Before a large-scale read (more than 3 files), STOP and summarize why those files are needed.

### COMPACTION

Remind the user to run `/compact` when context usage hits 60%.

### SPECIFICITY

Always prioritize direct file paths (@filename) over broad directory searches.

## Technology Stack

- **Runtime**: Node.js ≥22
- **Language**: TypeScript (compiled with tsdown)
- **Package Manager**: pnpm (preferred), npm, or bun
- **Testing**: vitest (unit, e2e, integration, live tests)
- **Browser Automation**: Playwright + Chrome DevTools Protocol (CDP)
- **Build Output**: ESM modules in `dist/`

## Architecture

### Core Components

1. **Gateway** (`src/gateway/`)
   - WebSocket server for agent communication
   - Default port: 18789 (dev), 18788 (prod)
   - Handles agent requests, message routing, and session management

2. **Browser Control** (`src/browser/`)
   - Playwright-based automation (`pw-*.ts` files)
   - CDP integration for Chrome/Chromium control
   - Chrome extension relay (`assets/chrome-extension/`)
   - Profile management and multi-tab support

3. **Channels** (`src/channels/`, `extensions/`)
   - Multi-platform messaging integrations
   - Each channel has its own extension (e.g., `extensions/whatsapp/`, `extensions/telegram/`)
   - Webhook handlers and message delivery systems

4. **Agent System** (`src/agents/`)
   - Agent orchestration and execution
   - Model routing and failover
   - Tool/function calling integration

5. **CLI** (`src/cli/`, `openclaw.mjs`)
   - Main entry point: `openclaw.mjs`
   - Command structure: `openclaw <command> [subcommand] [options]`

6. **Canvas UI** (`src/canvas-host/`, `ui/`)
   - Web-based control interface
   - Served at `/__openclaw__/canvas/` path

### Custom Extensions (Python Brain)

Located in project root (not in `src/`):

- `core/` - **Immutable kernel** (memory, security, identity)
  - `core/memory.py` - ChromaDB-based vector memory (The Hippocampus)
  - `core/kernel_guard.py` - Security verification for self-updates

- `modules/` - **Mutable skills** (can be updated by Evolution Engine)
  - `modules/dream.py` - Log processing and learning
  - `modules/scout.py` - GitHub release monitoring

- `evolve.py` - Self-improvement orchestrator
- `brain_data/` - Persistent vector database storage

**Security Model**: Core files are protected from updates. Only `modules/` can evolve.

## Development Workflow

### Build and Run

```bash
# Install dependencies
pnpm install

# Build UI (first time or after UI changes)
pnpm ui:build

# Build TypeScript
pnpm build

# Run gateway in dev mode
pnpm dev
# or directly:
node openclaw.mjs gateway run --dev

# Run with auto-reload
pnpm gateway:watch
```

### Testing

```bash
# Run all tests
pnpm test

# Run specific test suites
pnpm test:unit          # Unit tests only
pnpm test:e2e           # End-to-end tests
pnpm test:live          # Live integration tests (requires auth)
pnpm test:extensions    # Extension tests

# Run a single test file
pnpm vitest run path/to/test.test.ts

# Watch mode
pnpm vitest watch
```

### Linting and Formatting

```bash
# Check code quality
pnpm check              # Runs type-check, lint, and format checks

# Type checking
pnpm tsgo

# Linting
pnpm lint

# Format checking
pnpm format

# Auto-fix formatting
pnpm format:fix
```

### CLI Commands (Commonly Used)

```bash
# Gateway control
openclaw gateway run                    # Start gateway (foreground)
openclaw gateway status                 # Check status
openclaw gateway h
```
