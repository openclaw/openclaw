# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**OpenClaw** is a personal AI assistant framework that connects to multiple messaging platforms (WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, Teams, etc.) through a unified Gateway control plane. The assistant uses Pi agent runtime for AI capabilities and supports multi-channel routing, voice interaction, browser control, and a visual Canvas workspace.

**Repository**: https://github.com/openclaw/openclaw

## Development Commands

### Prerequisites
- **Node.js**: v22+ required
- **Package manager**: `pnpm` (preferred), `npm`, or `bun`

### Essential Commands

```bash
# Install dependencies
pnpm install

# Build (TypeScript compilation)
pnpm build

# Run CLI in development
pnpm openclaw <command>
pnpm dev

# Lint and format
pnpm lint              # oxlint with type-aware checking
pnpm format            # oxfmt format check
pnpm format:fix        # auto-fix formatting issues

# Tests
pnpm test              # run all unit tests
pnpm test:coverage     # with coverage reports
pnpm test:e2e          # end-to-end tests
pnpm test:live         # live tests (requires API keys)

# Gateway development
pnpm gateway:watch     # auto-reload on changes
pnpm gateway:dev       # dev mode (skips channels)

# UI development
pnpm ui:build          # build Control UI
pnpm ui:dev            # dev server for UI
```

### Platform-Specific Commands

```bash
# macOS app
pnpm mac:package       # package macOS app
pnpm mac:restart       # restart macOS app

# iOS app
pnpm ios:build         # build iOS app
pnpm ios:run           # build and run in simulator

# Android app
pnpm android:assemble  # assemble debug APK
pnpm android:run       # install and run
```

## Architecture Overview

### Core System Design

```
Messaging Channels (WhatsApp, Telegram, Slack, Discord, etc.)
               |
               v
        +--------------+
        |   Gateway    |  (WebSocket control plane)
        |  :18789      |
        +------+-------+
               |
               +-- Pi agent (RPC runtime)
               +-- CLI tools
               +-- WebChat UI
               +-- macOS/iOS/Android apps (nodes)
               +-- Browser control
```

### Key Subsystems

1. **Gateway** (`src/gateway/`) - WebSocket control plane at `ws://127.0.0.1:18789`. Manages sessions, presence, config, cron jobs, webhooks. Serves Control UI and WebChat.

2. **Pi Agent Runtime** (`src/agents/`) - RPC-based agent with tool/block streaming. Session model: `main` for direct chats, isolated group sessions. Workspace: `~/.openclaw/workspace/`. Prompt files: `AGENTS.md`, `SOUL.md`, `TOOLS.md`.

3. **Channels** (`src/channels/`, `src/whatsapp/`, `src/telegram/`, `src/discord/`, `src/slack/`, etc.) - Built-in + extension channels (`extensions/`). Multi-channel routing with mention gating, reply tags, per-channel chunking. DM pairing for security.

4. **Nodes** (`src/node-host/`) - Device-local action execution (macOS/iOS/Android). Camera, screen recording, notifications, system commands via `node.invoke`.

5. **Browser Control** (`src/browser/`) - Managed Chrome/Chromium with CDP. Snapshots, actions, uploads, profile management.

6. **Canvas + A2UI** (`src/canvas-host/`) - Agent-driven visual workspace with Agent-to-UI rendering protocol.

7. **Tools & Automation** - Skills platform (`skills/`), cron jobs/webhooks (`src/cron/`), session tools.

## Code Organization

### Directory Structure

- `src/` - All TypeScript source code
  - `cli/` - CLI command wiring
  - `commands/` - Command implementations
  - `gateway/` - Gateway WebSocket server
  - `agents/` - Pi agent integration
  - `channels/` - Channel abstraction layer
  - `whatsapp/`, `telegram/`, `discord/`, `slack/`, etc. - Built-in channel implementations
  - `browser/` - Browser control
  - `canvas-host/` - Canvas A2UI host
  - `node-host/` - Node action execution
  - `media/` - Media pipeline (images/audio/video)
  - `web/` - Control UI and WebChat
  - `config/` - Configuration management
  - `infra/` - Infrastructure utilities
- `extensions/` - Plugin/extension packages (workspace packages)
- `apps/` - Native apps (macOS, iOS, Android)
- `docs/` - Documentation (Mintlify hosted at docs.openclaw.ai)
- `dist/` - Build output
- `ui/` - Control UI frontend

### Important Files

- `openclaw.mjs` - CLI entry point
- `src/entry.ts` - Main entry
- `src/index.ts` - Public API exports
- `package.json` - Dependencies and scripts
- `tsconfig.json` - TypeScript configuration

## Development Patterns

### Testing
- Framework: **Vitest** with V8 coverage (70% threshold)
- Test files: colocated `*.test.ts`
- E2E tests: `*.e2e.test.ts`
- Run `pnpm test` before pushing changes

### Coding Style
- Language: TypeScript (ESM, strict mode)
- Formatting: **oxfmt**
- Linting: **oxlint** (type-aware)
- Keep files under ~500-700 LOC
- Add brief comments for complex logic
- Avoid `any`, prefer strict typing

### Configuration
- Config file: `~/.openclaw/openclaw.json`
- Credentials: `~/.openclaw/credentials/`
- Sessions: `~/.openclaw/sessions/`
- Workspace: `~/.openclaw/workspace/`

### Channels & Extensions
- Built-in channels: `src/whatsapp/`, `src/telegram/`, etc.
- Extension channels: `extensions/msteams/`, `extensions/matrix/`, etc.
- When modifying channel logic, consider all channels (built-in + extensions)
- Extension dependencies belong in extension `package.json`, not root

### Security
- DM pairing enabled by default (`dmPolicy="pairing"`)
- Allowlists: `channels.<channel>.allowFrom` or `channels.<channel>.dm.allowFrom`
- Sandbox mode: `agents.defaults.sandbox.mode: "non-main"` for group/channel sessions
- Run `openclaw doctor` to check security issues

### Commits & PRs
- Use action-oriented commit messages (e.g., "CLI: add verbose flag to send")
- Group related changes, avoid bundling unrelated refactors
- Add changelog entries with PR # and contributor thanks
- Full gate before merge: `pnpm lint && pnpm build && pnpm test`

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution guide and [AGENTS.md](./AGENTS.md) for detailed PR workflow, commit guidelines, and multi-agent safety protocols.

For fork-based workflow: add your fork as a remote (`git remote add fork <url>`), push to fork, create PR via `gh pr create --repo openclaw/openclaw --head your-username:branch`.

## Platform Notes

### macOS
- App location: `dist/OpenClaw.app`
- Menu bar control for Gateway and health
- Voice Wake, push-to-talk, WebChat, debug tools
- Logs: use `./scripts/clawlog.sh` for unified logs

### iOS/Android
- Apps act as "nodes" paired via Bridge
- Capabilities: Canvas, camera, screen recording, notifications
- Control via `openclaw nodes ...`

### Remote Gateway
- Can run on Linux with clients connecting via Tailscale or SSH tunnels
- Gateway runs exec tool; device nodes run device-local actions
- Tailscale modes: `off`, `serve` (tailnet-only), `funnel` (public)

## Common Workflows

### Running the Gateway
```bash
# Production
openclaw gateway --port 18789 --verbose

# Development (auto-reload)
pnpm gateway:watch
```

### Sending Messages
```bash
openclaw message send --to +1234567890 --message "Hello"
openclaw agent --message "Your question" --thinking high
```

### Managing Channels
```bash
openclaw channels login
openclaw channels status --probe
```

### Diagnostics
```bash
openclaw doctor
openclaw config get <key>
openclaw config set <key> <value>
```

## Important Conventions

1. **Naming**: Use "OpenClaw" for product/docs, `openclaw` for CLI/paths/config
2. **Agent workspace**: `~/.openclaw/workspace/` with `AGENTS.md`, `SOUL.md`, `TOOLS.md`
3. **Skills**: Located in `~/.openclaw/workspace/skills/<skill>/SKILL.md`
4. **Session model**: `main` for direct chats, isolated sessions for groups
5. **Multi-agent safety**: Avoid stashing/switching branches unless explicitly requested
6. **Extensions**: Keep plugin-only deps in extension `package.json`

## Release Channels

- **stable**: Tagged releases (`vYYYY.M.D`), npm tag `latest`
- **beta**: Prerelease (`vYYYY.M.D-beta.N`), npm tag `beta`
- **dev**: Moving head on `main`

## CLI Backend Configuration

See [docs/cli-backend.md](docs/cli-backend.md) for Claude Code CLI backend setup, model naming conventions, session mode, and debugging.

## DJ Profile Pack

See [docs/dj/claude-context.md](docs/dj/claude-context.md) for DJ-specific setup, skills, budget system, web operator, Notion integration, and troubleshooting.

## Further Reading

- [AGENTS.md](./AGENTS.md) - PR workflow, commit guidelines, security, multi-agent safety, NPM publishing
- [CONTRIBUTING.md](./CONTRIBUTING.md) - Contribution guide for external contributors
- [docs/cli-backend.md](docs/cli-backend.md) - CLI backend configuration reference
- [docs/dj/claude-context.md](docs/dj/claude-context.md) - DJ profile pack context
- [docs/dj/runbook.md](docs/dj/runbook.md) - Complete DJ setup guide
