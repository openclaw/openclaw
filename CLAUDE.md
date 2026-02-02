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
               │
               ▼
        ┌─────────────┐
        │   Gateway   │  (WebSocket control plane)
        │  :18789     │
        └──────┬──────┘
               │
               ├─ Pi agent (RPC runtime)
               ├─ CLI tools
               ├─ WebChat UI
               ├─ macOS/iOS/Android apps (nodes)
               └─ Browser control
```

### Key Subsystems

1. **Gateway** (`src/gateway/`)
   - WebSocket control plane at `ws://127.0.0.1:18789`
   - Manages sessions, presence, config, cron jobs, webhooks
   - Coordinates all channels, tools, and clients
   - Serves Control UI and WebChat

2. **Pi Agent Runtime** (`src/agents/`)
   - RPC-based agent with tool streaming and block streaming
   - Session model: `main` for direct chats, isolated group sessions
   - Agent workspace: `~/.openclaw/workspace/`
   - Prompt files: `AGENTS.md`, `SOUL.md`, `TOOLS.md`

3. **Channels** (`src/channels/`, `src/whatsapp/`, `src/telegram/`, `src/discord/`, `src/slack/`, etc.)
   - Built-in channels in `src/`: WhatsApp (Baileys), Telegram (grammY), Discord, Slack, Signal, iMessage
   - Extension channels in `extensions/`: BlueBubbles, Teams, Matrix, Zalo, Google Chat, etc.
   - Multi-channel routing with mention gating, reply tags, and per-channel chunking
   - DM pairing system for security (default: `dmPolicy="pairing"`)

4. **Nodes** (`src/node-host/`)
   - Device-local action execution (macOS/iOS/Android)
   - Capabilities: camera, screen recording, notifications, system commands
   - Communicated via `node.invoke` over Gateway WebSocket

5. **Browser Control** (`src/browser/`)
   - Managed Chrome/Chromium with CDP (Chrome DevTools Protocol)
   - Snapshots, actions, uploads, profile management

6. **Canvas + A2UI** (`src/canvas-host/`)
   - Agent-driven visual workspace
   - A2UI: Agent-to-UI rendering protocol
   - Supports macOS/iOS/Android apps

7. **Tools & Automation**
   - Skills platform (`skills/`): bundled, managed, workspace skills
   - Cron jobs and webhooks (`src/cron/`)
   - Session tools: `sessions_list`, `sessions_history`, `sessions_send`

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
# Send a message
openclaw message send --to +1234567890 --message "Hello"

# Talk to agent
openclaw agent --message "Your question" --thinking high
```

### Managing Channels
```bash
# Login to a channel
openclaw channels login

# Check channel status
openclaw channels status --probe
```

### Diagnostics
```bash
# Run health checks and migrations
openclaw doctor

# View configuration
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

## CLI Backend Configuration (Claude Code)

OpenClaw can use Claude Code CLI as a backend for agent responses. This section documents the working configuration and common pitfalls.

### Working Configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "claude-cli/sonnet"
      },
      "cliBackends": {
        "claude-cli": {
          "command": "claude",
          "args": ["-p", "--output-format", "json"],
          "output": "json",
          "input": "arg",
          "modelArg": "--model",
          "sessionMode": "none"
        }
      }
    }
  }
}
```

### Windows-Specific Setup

Claude Code CLI requires git-bash on Windows. **Critical**: Set the path via shell environment variable, not JSON config.

**Start the gateway with:**
```bash
CLAUDE_CODE_GIT_BASH_PATH='C:\Users\<username>\Documents\Git\bin\bash.exe' node openclaw.mjs gateway run --port 18789 --verbose
```

**Why not JSON config?** Backslashes in JSON (`\\`) get interpreted as escape sequences when passed through the config system. For example, `\b` becomes a backspace character, corrupting paths like `C:\Users\...\bin\bash.exe` into `C:Users...inash.exe`.

### Common Issues and Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `Claude Code was unable to find CLAUDE_CODE_GIT_BASH_PATH` | Path escaping issue or wrong path | Set via shell env var with single quotes and backslashes |
| `No conversation found with session ID` | CLI trying to resume non-existent session | Add `"sessionMode": "none"` to config |
| Response is raw JSON/gibberish | Wrong output format parsing | Use `"output": "json"` with `"--output-format", "json"` (not `stream-json`/`jsonl`) |
| `When using --print, --output-format=stream-json requires --verbose` | Missing flag | Add `--verbose` if using stream-json (but prefer json format) |

### Output Format Notes

- **Use `json` format** (single JSON object with `result` field) - parser extracts text correctly
- **Avoid `stream-json`/`jsonl`** - the JSONL parser expects `item.text` structure which doesn't match Claude CLI's format
- Parser code: `src/agents/cli-runner/helpers.ts` (`parseCliJson`, `parseCliJsonl`)

### Debugging

Enable verbose CLI output logging:
```bash
OPENCLAW_CLAUDE_CLI_LOG_OUTPUT=1 node openclaw.mjs gateway run --verbose
```

Check logs at: `\tmp\openclaw\openclaw-<date>.log`

## Further Reading

For detailed information, see [AGENTS.md](./AGENTS.md) which contains:
- Detailed PR workflow and commit guidelines
- Security and configuration tips
- Multi-agent safety protocols
- Tool schema guardrails
- NPM publishing workflow
- Platform-specific notes and troubleshooting
