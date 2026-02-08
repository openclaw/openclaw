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

## Contributing to OpenClaw

This section documents the complete workflow for contributing changes to the OpenClaw repository, including authentication setup, fork workflow, and pull request creation.

### Git Authentication Setup

**1. Configure Git Credential Storage**

Enable credential storage to avoid re-entering credentials:
```bash
git config --global credential.helper store
```

**2. Store GitHub Personal Access Token**

Create `~/.git-credentials` with your GitHub username and token:
```
https://your-username:ghp_your_token_here@github.com
```

Set proper permissions:
```bash
chmod 600 ~/.git-credentials
```

**3. Create Personal Access Token**

Generate a token at https://github.com/settings/tokens with these scopes:
- `repo` (full control of private repositories)
- `workflow` (update GitHub Action workflows)

### Fork and Pull Request Workflow

External contributors without write access to `openclaw/openclaw` should use the fork workflow:

**1. Fork the Repository**

Fork https://github.com/openclaw/openclaw to your account via GitHub's web interface.

**2. Add Fork as Remote**

```bash
cd /path/to/openclaw
git remote add fork https://github.com/your-username/openclaw.git
```

**3. Push Changes to Fork**

```bash
# Push to your fork (not origin)
git push fork main

# If fork contains conflicting work, force push
git push fork main --force
```

**4. Verify Remotes**

```bash
git remote -v
# Should show:
# origin  https://github.com/openclaw/openclaw.git (fetch)
# origin  https://github.com/openclaw/openclaw.git (push)
# fork    https://github.com/your-username/openclaw.git (fetch)
# fork    https://github.com/your-username/openclaw.git (push)
```

### Installing GitHub CLI Without Sudo

For environments without sudo access, install pre-built `gh` binary:

```bash
# Download latest release
cd /tmp
curl -L -o gh.tar.gz https://github.com/cli/cli/releases/download/v2.42.1/gh_2.42.1_linux_amd64.tar.gz

# Extract and install
tar -xzf gh.tar.gz
mkdir -p ~/.local/bin
mv gh_2.42.1_linux_amd64/bin/gh ~/.local/bin/gh
chmod +x ~/.local/bin/gh

# Verify installation
~/.local/bin/gh version
```

Ensure `~/.local/bin` is in your PATH:
```bash
export PATH="$HOME/.local/bin:$PATH"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

### Creating Pull Requests with GitHub CLI

**1. Authenticate with GitHub**

```bash
gh auth login --with-token < ~/.git-credentials
# Or use interactive mode:
gh auth login
```

**2. Create Pull Request from Fork**

```bash
gh pr create \
  --repo openclaw/openclaw \
  --head your-username:main \
  --title "feat: your feature title" \
  --body "## Summary

- Change 1
- Change 2

## Testing

Tested with...

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

**3. View Pull Request**

The command returns the PR URL (e.g., https://github.com/openclaw/openclaw/pull/10674)

### Common Issues and Solutions

#### Permission Denied on Git Push

**Symptom:**
```
remote: Permission to openclaw/openclaw.git denied to your-username.
fatal: unable to access 'https://github.com/openclaw/openclaw.git/': The requested URL returned error: 403
```

**Root Cause:** You don't have write access to the main repository

**Solution:** Use fork workflow (see above)

#### Repository Not Found When Pushing to Fork

**Symptom:**
```
remote: Repository not found.
fatal: repository 'https://github.com/your-username/openclaw.git/' not found
```

**Root Cause:** Fork doesn't exist yet

**Solution:** Fork the repository on GitHub first, then add remote

#### Updates Rejected - Remote Contains Work

**Symptom:**
```
! [rejected]            main -> main (fetch first)
error: failed to push some refs to 'https://github.com/your-username/openclaw.git'
hint: Updates were rejected because the remote contains work that you do not have locally
```

**Root Cause:** Fork was created with original repository content different from local commits

**Solution:** Force push to overwrite fork (safe for personal forks):
```bash
git push fork main --force
```

**Warning:** Only force push to your personal fork, never to shared/upstream repositories.

### Pull Request Best Practices

1. **Descriptive Titles**: Use conventional commits format:
   - `feat:` - New features
   - `fix:` - Bug fixes
   - `docs:` - Documentation changes
   - `refactor:` - Code restructuring
   - `test:` - Test additions/changes

2. **Detailed Body**: Include:
   - Summary of changes (bullet points)
   - Testing performed
   - Related issues/PRs
   - Breaking changes (if any)

3. **Small, Focused PRs**: Keep PRs focused on single feature/fix

4. **Pass Full Gate**: Ensure `pnpm lint && pnpm build && pnpm test` passes before creating PR

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
          "sessionMode": "always",
          "sessionArg": "--session-id"
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

### Session Mode Configuration

**Purpose:** Controls how Claude CLI manages conversation memory across messages.

**Valid Options:**
- `"always"` - **Recommended**: Creates/uses persistent sessions for conversation memory. Bot remembers context between messages.
- `"existing"` - Only resumes existing sessions, doesn't create new ones
- `"none"` - No session management. Each message starts fresh with no memory of previous messages.

**sessionArg:** When using `"always"` or `"existing"`, set `"sessionArg": "--session-id"` to specify the CLI argument for passing session IDs.

**Why sessionMode matters for Telegram/messaging bots:**
- Without session mode (`"none"`), the bot forgets context between messages, requiring users to repeat information
- With `"always"`, the bot maintains conversation history, making interactions more natural
- The gateway automatically hot-reloads when you change sessionMode in the config

**Schema Reference:** Valid values defined in `src/config/zod-schema.core.ts:253`

### Common Issues and Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| Bot forgets context between messages | Session mode disabled | Set `"sessionMode": "always"` and `"sessionArg": "--session-id"` in config |
| `Unknown model: anthropic/claude-opus-4.5` | Model version uses dots instead of dashes | Change `4.5` to `4-5` (use dashes not dots) |
| `Claude Code was unable to find CLAUDE_CODE_GIT_BASH_PATH` | Path escaping issue or wrong path | Set via shell env var with single quotes and backslashes |
| `No conversation found with session ID` | CLI trying to resume non-existent session | Check sessionMode is `"always"` not `"existing"` |
| Response is raw JSON/gibberish | Wrong output format parsing | Use `"output": "json"` with `"--output-format", "json"` (not `stream-json`/`jsonl`) |
| `When using --print, --output-format=stream-json requires --verbose` | Missing flag | Add `--verbose` if using stream-json (but prefer json format) |

### Output Format Notes

- **Use `json` format** (single JSON object with `result` field) - parser extracts text correctly
- **Avoid `stream-json`/`jsonl`** - the JSONL parser expects `item.text` structure which doesn't match Claude CLI's format
- Parser code: `src/agents/cli-runner/helpers.ts` (`parseCliJson`, `parseCliJsonl`)

### Critical: Model Naming Convention

**IMPORTANT**: There are THREE naming layers — don't confuse them:

| Layer | Example | Where Used |
|-------|---------|------------|
| **Marketing name** | "Opus 4.6" (dots) | Conversation, docs, Anthropic blog posts |
| **API model ID** | `claude-opus-4-6` (dashes) | What the API actually returns in responses |
| **OpenClaw catalog name** | `anthropic/claude-opus-4-5` (dashes) | `openclaw.json`, `src/config/defaults.ts` |
| **OpenClaw alias** | `opus` | Short form in config, maps to catalog name |

**Key rules:**
1. **Always dashes, never dots** in any model identifier (`4-5` not `4.5`, `4-6` not `4.6`)
2. The OpenClaw catalog name `anthropic/claude-opus-4-5` maps to the **latest** Opus — currently API model `claude-opus-4-6`. The `-4-5` is the catalog family, not the exact version.
3. For CLI backend, use `claude-cli/opus` — this passes `--model opus` to the CLI which resolves to the latest Opus.

| ❌ Wrong | ✅ Correct | Why |
|---------|-----------|-----|
| `claude-opus-4.5` | `claude-opus-4-5` | Dots not allowed |
| `anthropic/claude-sonnet-4.5` | `anthropic/claude-sonnet-4-5` | Dots not allowed |
| `anthropic/claude-opus-4-6` | `anthropic/claude-opus-4-5` or `claude-cli/opus` | `4-6` not in OpenClaw catalog |
| `anthropic/claude-opus-4-20260205` | `anthropic/claude-opus-4-5` or `claude-cli/opus` | Date IDs not in catalog |

**Reference**: See `src/config/defaults.ts` for canonical catalog names:
```typescript
opus: "anthropic/claude-opus-4-5",   // resolves to latest Opus (currently claude-opus-4-6)
sonnet: "anthropic/claude-sonnet-4-5", // resolves to latest Sonnet
```

### Testing Best Practices

**Before configuring CLI backend**, test with direct Anthropic API first:

1. **Start with Anthropic API** to verify Telegram/channel setup:
   ```json
   {
     "agents": {
       "defaults": {
         "model": {
           "primary": "anthropic/claude-opus-4-5"
         }
       }
     }
   }
   ```

2. **Test bot connectivity** - send a message and verify response

3. **Then switch to CLI backend**:
   ```json
   {
     "agents": {
       "defaults": {
         "model": {
           "primary": "claude-cli/opus"
         },
         "cliBackends": {
           "claude-cli": {
             "command": "claude",
             "args": ["-p", "--output-format", "json"],
             "output": "json",
             "input": "arg",
             "modelArg": "--model",
             "sessionMode": "always",
             "sessionArg": "--session-id"
           }
         }
       }
     }
   }
   ```

4. **Windows**: Kill gateway and restart with `CLAUDE_CODE_GIT_BASH_PATH` env var:
   ```bash
   cmd.exe /c "set ANTHROPIC_API_KEY=your-key && set OPENCLAW_GATEWAY_TOKEN=local-dev-token && set CLAUDE_CODE_GIT_BASH_PATH=C:\Users\<username>\Documents\Git\bin\bash.exe && node openclaw.mjs gateway run --port 18789 --verbose"
   ```

This isolates issues: first verify channels work, then add CLI backend complexity.

### Debugging

Enable verbose CLI output logging:
```bash
OPENCLAW_CLAUDE_CLI_LOG_OUTPUT=1 node openclaw.mjs gateway run --verbose
```

Check logs at: `\tmp\openclaw\openclaw-<date>.log`

## DJ Profile Pack

The DJ profile pack is a personal assistant configuration with Telegram integration, Notion task management, and Google Calendar support. Documentation lives in `docs/dj/`.

### DJ Skills Workspace Setup

**Critical:** DJ skills in the repository (`skills/dj-*`) are for development only. OpenClaw loads skills from the workspace directory.

**Symptom:** Bot doesn't recognize calendar/Notion commands, responds with "I don't have access to your calendar. I'm a software engineering assistant..."

**Root Cause:** DJ skills not present in `~/.openclaw/workspace/skills/`

**Solution:**
```bash
# Copy all DJ skills to workspace
mkdir -p ~/.openclaw/workspace/skills
cp -r skills/dj-* ~/.openclaw/workspace/skills/

# Verify skills are present
ls ~/.openclaw/workspace/skills/
# Should show: dj-agenda, dj-budget, dj-calendars, dj-capture, dj-findslot,
#              dj-improve, dj-mode, dj-podcast, dj-research, dj-rlm, dj-site,
#              dj-timeblock, dj-web
```

**What this fixes:**
- `/agenda` - Calendar + tasks view now works
- `/capture` - Notion task capture now works
- `/findslot` - Calendar slot finding now works
- All other DJ skills become available

**Note:** The gateway automatically picks up skills from the workspace directory without restart. However, if skills weren't present at startup, you may need to restart the gateway once after copying them.

### DJ Setup: Common Pitfalls and Solutions

This section documents common issues encountered during initial DJ setup and their solutions.

#### 1. Notion Integration: 404 Database Not Found

**Symptom:**
```json
{
  "object": "error",
  "status": 404,
  "code": "object_not_found",
  "message": "Could not find database with ID: 2ff7c385-b5d2-803f-b9b8-f85a8f65e6e2. Make sure the relevant pages and databases are shared with your integration."
}
```

**Root Cause:** Notion databases not shared with the integration

**Solution:**
1. Go to each Notion database (Tasks, Projects, Research Radar)
2. Click "Share" → "Invite"
3. Select your integration from the list
4. Test with curl:
   ```bash
   curl -H "Authorization: Bearer $NOTION_API_KEY" \
        -H "Notion-Version: 2022-06-28" \
        "https://api.notion.com/v1/databases/{database_id}/query"
   ```

#### 2. Google Calendar (gog): Installation Without sudo

**Symptom:**
```
/bin/bash: line 1: go: command not found
```

**Root Cause:** Go language not installed, and installing Go requires sudo

**Solution:** Use pre-built gog binary instead of `go install`:
```bash
cd /tmp
curl -L -o gog.tar.gz https://github.com/steipete/gogcli/releases/download/v0.9.0/gogcli_0.9.0_linux_amd64.tar.gz
tar -xzf gog.tar.gz
mkdir -p ~/.local/bin
mv gog ~/.local/bin/gog
chmod +x ~/.local/bin/gog
gog version
```

#### 3. Google Calendar (gog): OAuth 403 Access Denied

**Symptom:**
```
Error 403: access_denied
```

**Root Cause:** OAuth app in "Testing" mode, but user account can't be added as test user (e.g., workspace restrictions or ineligible accounts)

**Solution:** Use manual authentication mode:
```bash
gog auth add --manual
```

This provides a browserless flow where you:
1. Visit the authorization URL manually
2. Approve in browser
3. Copy the redirect URL (localhost with code parameter)
4. Paste it back to the gog prompt

**Important:** Each `gog auth add` generates a new state parameter. Don't reuse authorization codes from previous attempts - run the full flow each time.

#### 4. Google Calendar (gog): State Mismatch

**Symptom:**
```
state mismatch
```

**Root Cause:** Authorization code from a previous authentication attempt used with a new state parameter

**Solution:** Run the authentication flow interactively in your terminal:
1. Run `gog auth add --manual` directly in your shell
2. Complete the OAuth flow immediately without switching terminals
3. The state parameter must match between the auth request and callback

**Note:** Each authentication attempt generates a fresh state token for security. Authorization codes from previous attempts cannot be reused.

#### 5. Google Calendar (gog): Keyring Password Setup

After successful authentication, gog stores credentials in an encrypted keyring. Set environment variables for automated access:

```bash
# Add to ~/.bashrc or equivalent
export GOG_KEYRING_PASSWORD="your-password"
export GOG_ACCOUNT="your-email@gmail.com"

# Test access
gog auth list
```

#### 6. Model Configuration: Valid Model Names

**Symptom:** `Unknown model: anthropic/claude-opus-4-20260205` or `Unknown model: anthropic/claude-sonnet-4`

**Root Cause:** OpenClaw validates model names against its internal catalog. Only registered aliases and full catalog names work. Date-based model IDs and incomplete version numbers are rejected.

**Valid model names** (from `src/config/defaults.ts`):

| Alias | Catalog Name | Resolves To (API) |
|-------|-----------|-------|
| `opus` | `anthropic/claude-opus-4-5` | `claude-opus-4-6` (latest Opus) |
| `sonnet` | `anthropic/claude-sonnet-4-5` | `claude-sonnet-4-5-20250929` (latest Sonnet) |

**For CLI backend**, prefix with the backend name:
```json
{
  "model": {
    "primary": "claude-cli/opus"
  }
}
```

**Common mistakes:**
- `anthropic/claude-sonnet-4` - Missing minor version (`-5`)
- `anthropic/claude-opus-4-20260205` - Date-based IDs not in catalog
- `claude-opus-4.5` - Dots instead of dashes

#### 7. Telegram Bot Token: `file:` Protocol Not Supported

**Symptom:**
```
[telegram] channel exited: Call to 'getMe' failed! (404: Not Found)
```

**Root Cause:** Using `"botToken": "file:~/.openclaw/credentials/telegram-bot-token.txt"` in config. The `botToken` field is used as a **literal string** — there is no `file:` protocol resolver. The gateway sends `file:~/.openclaw/credentials/...` as the token to Telegram's API, producing a 404.

**Solution:** Use `tokenFile` instead of `botToken` for file-based tokens:
```json
{
  "channels": {
    "telegram": {
      "tokenFile": "~/.openclaw/credentials/telegram-bot-token.txt"
    }
  }
}
```

**Also check:** The token file must NOT have a trailing newline. Verify with:
```bash
xxd ~/.openclaw/credentials/telegram-bot-token.txt | tail -1
# Last byte should NOT be 0a (newline)
# Fix: printf '%s' "YOUR_TOKEN" > ~/.openclaw/credentials/telegram-bot-token.txt
```

**Reference:** Token resolution logic in `src/telegram/token.ts` — priority order:
1. Per-account `tokenFile` → 2. Per-account `botToken` → 3. Global `tokenFile` → 4. Global `botToken` → 5. `TELEGRAM_BOT_TOKEN` env var

#### 8. Google Calendar (gog): Insufficient Authentication Scopes (403)

**Symptom:**
```
Google API error (403 insufficientPermissions): Request had insufficient authentication scopes.
```

**Root Cause:** The Google Cloud project used for OAuth credentials does not have the Calendar API enabled, or the OAuth token was issued without the `calendar` scope.

**Solution:**
1. Enable Calendar API in Google Cloud Console:
   `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=YOUR_PROJECT_ID`
2. Re-authenticate with `--force-consent` to get a fresh token with correct scopes:
   ```bash
   gog auth add YOUR_EMAIL --services calendar,gmail,drive --force-consent --manual
   ```
3. Verify:
   ```bash
   gog calendar list --json | head -c 200
   # Should return JSON array of calendars, not a 403
   ```

**Note:** The project ID can be found in `~/.openclaw/credentials/google_client_secret.json` under the `project_id` field.

#### 9. Google Drive (gog): API Not Enabled (403)

**Symptom:**
```
Google API error (403 accessNotConfigured): Google Drive API has not been used in project XXXXXXXXX before or it is disabled.
```

**Root Cause:** OAuth token has Drive scope, but the Google Cloud project hasn't enabled the Drive API.

**Solution:**
1. Enable Drive API in Google Cloud Console:
   `https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=YOUR_PROJECT_ID`
2. If Drive scope is also missing from the token, re-authenticate with Drive added:
   ```bash
   gog auth add YOUR_EMAIL --services calendar,gmail,drive --force-consent --manual
   ```
3. Verify:
   ```bash
   gog auth list
   # Should show: calendar,drive,gmail
   gog drive search "test" --max 1 --json
   # Should return file results, not a 403
   ```

**Note:** Adding a new scope (e.g., Drive) to an existing account requires `--force-consent` to trigger a fresh consent screen. Without it, the existing token keeps its old scopes. The project ID can be found in `~/.openclaw/credentials/google_client_secret.json` under the `project_id` field.

#### 10. CLI Backend Skills Prompt Gap (Code Fix Required)

**Symptom:** Bot responds to `/agenda` with generic "I don't have access to your calendar" even though skills are loaded and `gog`/`NOTION_API_KEY` are available.

**Root Cause:** The CLI runner (`src/agents/cli-runner/helpers.ts`) did NOT pass `skillsPrompt` to `buildAgentSystemPrompt()`. When a skill command like `/agenda` was matched, the gateway rewrote the message to "Use the dj-agenda skill", but the CLI agent had no skills section in its system prompt and didn't know what "dj-agenda" was.

**Fix applied in 3 files:**
- `src/agents/cli-runner/helpers.ts` — Added `skillsPrompt` parameter to `buildSystemPrompt()`, passes it to `buildAgentSystemPrompt()`
- `src/agents/cli-runner.ts` — Added `skillsPrompt` parameter to `runCliAgent()`, passes it to `buildSystemPrompt()`
- `src/auto-reply/reply/agent-runner-execution.ts` — Passes `params.followupRun.run.skillsSnapshot?.prompt` to `runCliAgent()`

**Comparison:** The embedded Pi runner at `src/agents/pi-embedded-runner/system-prompt.ts:57` already passed `skillsPrompt` correctly. This was only broken on the CLI backend path.

#### 11. NOTION_API_KEY Not Persisted Across Sessions

**Symptom:** Notion integration works in one terminal session but fails after restarting the terminal or gateway.

**Root Cause:** `NOTION_API_KEY` was set with `export` in a terminal session but never saved to disk.

**Solution:** Save the key to a credentials file and load it from bashrc:
```bash
# Save key
echo -n "YOUR_NOTION_KEY" > ~/.openclaw/credentials/notion-api-key.txt
chmod 600 ~/.openclaw/credentials/notion-api-key.txt

# Add to bashrc
echo 'export NOTION_API_KEY="$(cat ~/.openclaw/credentials/notion-api-key.txt)"' >> ~/.bashrc
```

#### 12. Context Overflow: Prompt Too Large

**Symptom:**
```
Context overflow: prompt too large for the model. Try again with less input or a larger-context model.
```

**Root Cause:** The session conversation history + system prompt + skills prompt exceeded the model's context window (200K tokens for Opus). Happens during intensive multi-turn tasks.

**Immediate Fix:** Send `/new` in Telegram to start a fresh session. This command is processed before the agent, so it works even when context is full.

**Prevention:**
- Use `/compact` proactively during long conversations to compress context
- Compaction mode `"safeguard"` (default) auto-compacts when context fills, but can't recover once the overflow error is hit
- For intensive tasks, break work into multiple sessions

**Available Telegram Session Commands:**

| Command | Description |
|---------|-------------|
| `/new` | Start fresh session (clears all context) |
| `/reset` | Reset current session |
| `/compact` | Compress context to free space (use proactively) |
| `/stop` | Stop the current run |
| `/model` | Show/switch model (`/model codex`, `/model opus`) |
| `/think` | Set thinking level (off/low/medium/high/xhigh) |
| `/help` | Show available commands |
| `/status` | Show current status and model info |
| `/restart` | Restart the gateway (requires `commands.restart: true`) |

**Enabling `/restart`:** Add `"restart": true` to the `commands` section in `openclaw.json`:
```json
{
  "commands": {
    "native": "auto",
    "nativeSkills": "auto",
    "restart": true
  }
}
```

#### 13. USER.md Setup

**No issues encountered.** The USER.md file creation worked smoothly using direct file write with heredoc.

**Location:** `~/.openclaw/workspace/USER.md`

**Content:** Full DJ profile JSON with portfolio structure, operating modes, and project details.

#### Setup Checklist

Use this checklist to verify complete DJ setup:

- [ ] **DJ Skills**: All skills copied to `~/.openclaw/workspace/skills/` (13 skills total)
- [ ] **Telegram Bot**:
  - [ ] Bot token saved to `~/.openclaw/credentials/telegram-bot-token.txt` (no trailing newline!)
  - [ ] Config uses `"tokenFile"` (NOT `"botToken": "file:..."`)
  - [ ] User ID in `allowFrom` list
- [ ] **Notion Integration**:
  - [ ] Integration created at notion.so/my-integrations (bot name: "Open Claw")
  - [ ] API key saved to `~/.openclaw/credentials/notion-api-key.txt`
  - [ ] `NOTION_API_KEY` loaded in `~/.bashrc`
  - [ ] Tasks database shared with integration
  - [ ] Projects database shared with integration
  - [ ] Research database shared with integration
- [ ] **Google Workspace (gog)**:
  - [ ] Calendar API enabled in Google Cloud Console for OAuth project
  - [ ] Drive API enabled in Google Cloud Console for OAuth project
  - [ ] OAuth client credentials saved to `~/.openclaw/credentials/google_client_secret.json`
  - [ ] gog binary installed at `~/.local/bin/gog`
  - [ ] Authentication completed with all scopes: `gog auth list` shows `calendar,drive,gmail`
  - [ ] `gog calendar list --json` returns data (not 403)
  - [ ] `gog drive search "test" --max 1 --json` returns data (not 403)
  - [ ] `GOG_KEYRING_PASSWORD` set in `~/.bashrc`
  - [ ] `GOG_ACCOUNT` set in `~/.bashrc`
- [ ] **USER.md**: Profile created at `~/.openclaw/workspace/USER.md`
- [ ] **Model Configuration**: `anthropic/claude-opus-4-5` (primary) with `codex-cli/gpt-5-codex` (fallback)
- [ ] **Gateway Restart**: Restarted with all environment variables

**Working openclaw.json reference (dual-model + Telegram):**
```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-5",
        "fallbacks": ["codex-cli/gpt-5-codex"]
      },
      "cliBackends": {
        "claude-cli": {
          "command": "claude",
          "args": ["-p", "--output-format", "json", "--dangerously-skip-permissions"],
          "output": "json",
          "input": "arg",
          "modelArg": "--model",
          "sessionMode": "always",
          "sessionArg": "--session-id"
        },
        "codex-cli": {
          "command": "codex",
          "args": ["exec", "--json", "--color", "never", "--sandbox", "read-only", "--skip-git-repo-check"],
          "output": "jsonl",
          "input": "arg",
          "modelArg": "--model",
          "sessionMode": "existing",
          "serialize": true
        }
      }
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing",
      "tokenFile": "~/.openclaw/credentials/telegram-bot-token.txt",
      "allowFrom": [8487794139],
      "groupPolicy": "allowlist",
      "streamMode": "partial"
    }
  }
}
```

**Dual-model usage in Telegram:**
- Default messages use Opus via direct Anthropic API (no CLI subprocess)
- `/model codex` switches session to GPT-5-Codex via Codex CLI
- `/model opus` switches back to Claude Opus
- If Opus rate-limits or fails, auto-fallback to Codex
- `claude-cli/*` backend hangs when an interactive Claude Code session is running (per-user concurrency limit) — use `anthropic/*` as primary to avoid this

**Gateway startup (WSL2):**
```bash
source ~/.bashrc
export NOTION_API_KEY="$(cat ~/.openclaw/credentials/notion-api-key.txt)"
export ANTHROPIC_API_KEY="$(cat ~/.openclaw/credentials/anthropic-api-key.txt)"
export OPENCLAW_GATEWAY_TOKEN="local-dev-token"
cd /mnt/d/Dev/Clawdbot/openclaw
node openclaw.mjs gateway run --port 18789 --verbose
```

**Verification sequence in Telegram:**
1. `/budget` — Basic skill dispatch (no deps)
2. `/calendars` — Google Calendar connectivity
3. `/agenda` — Calendar + Notion integration
4. `/capture test note` — Notion write
5. Ask "search my Drive for test" — Google Drive connectivity
6. `/model codex` then ask a coding question — Codex CLI backend
7. `/model opus` — Switch back to Opus

### Budget System (`src/budget/`)

Resource governance for agent workflows with tiered limits:

| Profile | Tool Calls | Tokens | Runtime | Cost | Use Case |
|---------|------------|--------|---------|------|----------|
| **cheap** | 10 | 50K | 1 min | $0.10 | Quick questions |
| **normal** | 50 | 200K | 5 min | $1.00 | Task management |
| **deep** | 200 | 1M | 30 min | $10.00 | Deep research |

**Key files:**
- `src/budget/governor.ts` - BudgetGovernor class with limit enforcement
- `src/budget/profiles.ts` - Profile definitions (CHEAP_LIMITS, NORMAL_LIMITS, DEEP_LIMITS)
- `src/budget/types.ts` - Type definitions and event types
- `src/budget/config.ts` - Configuration resolution
- `docs/dj/budget.md` - Full documentation

**Features:**
- Per-workflow caps (tool calls, LLM calls, tokens, cost, runtime)
- Error loop detection (3 repeated errors triggers stop)
- Deep mode with auto-revert (timeout or one-run)
- Event subscription for monitoring (usage_update, limit_warning, limit_exceeded)
- Telegram commands: `/budget`, `/usage`

**Usage:**
```typescript
import { createBudgetGovernor, createDeepGovernor } from "openclaw/budget";

const governor = createBudgetGovernor({ profileId: "normal" });
const result = governor.recordToolCall("web_search");
if (!result.allowed) {
  console.log(`Limit exceeded: ${result.exceededLimit}`);
}
```

### Work Busy Calendar Integration (`src/utils/busy-block.ts`)

Sync Outlook work calendar to Google Calendar for DJ visibility without exposing meeting details.

**Key files:**
- `src/utils/busy-block.ts` - Privacy stripping and merge utilities
- `src/utils/busy-block.test.ts` - 52 unit tests (includes DST, multi-day, overlap trust tests)
- `docs/dj/work-busy-ics.md` - Setup guide
- `skills/dj-calendars/SKILL.md` - `/calendars` helper command

**Privacy stripping removes:**
- Meeting titles → replaced with "Busy (work)"
- Description, location, attendees, organizer
- Conference links (Meet/Hangout), htmlLink

**Key functions:**
```typescript
import {
  sanitizeWorkBusyEvent,    // Strip identifying info from work events
  prepareWorkBusyEvents,    // Filter, sanitize, expand all-day events
  mergeCalendarEvents,      // Merge primary + work busy calendars
  findTimeGaps,             // Find available slots excluding busy blocks
  expandAllDayToWorkingHours, // Convert all-day to working hours range
  filterRecurrenceMasters,  // Remove recurring event masters
} from "./utils/busy-block.js";
```

**Configuration:**
```json
{
  "dj": {
    "calendarId": "primary",
    "workBusyCalendarId": "abc123@group.calendar.google.com",
    "workBusyLabel": "Busy (work)",
    "workBusyEmoji": "🔒"
  }
}
```

**Skills updated for Work Busy support:**
- `/agenda` - Shows work busy blocks with 🔒 emoji
- `/findslot` - Excludes work busy blocks from available slots
- `/timeblock` - Avoids work busy blocks when proposing time blocks

### DJ Skills (`skills/dj-*`)

| Skill | Command | Description |
|-------|---------|-------------|
| dj-agenda | `/agenda` | Calendar + Notion tasks view |
| dj-findslot | `/findslot` | Find available calendar slots |
| dj-timeblock | `/timeblock` | Propose calendar blocks for tasks |
| dj-capture | `/capture` | Quick task capture to Notion |
| dj-mode | `/mode` | Switch between personal/worksafe modes |
| dj-budget | `/budget` | View/change budget profile |
| dj-calendars | `/calendars` | List available Google Calendars |
| dj-research | `/research` | Web research with budget-controlled depth (M4) |
| dj-web | `/web` | Browser automation with policy controls (M4) |
| dj-site | `/site` | Squarespace draft-first publishing (M4) |

### Web Operator (M4) (`src/dj/`)

Operator-grade "internet on my behalf" layer with policy-enforced safety controls.

**Key files:**
- `src/dj/web-policy.ts` - Allowlists, deny rules, action classification (101 tests)
- `src/dj/web-operator.ts` - Plan/do/approve workflow orchestration
- `src/dj/web-autosubmit-state.ts` - Daily/workflow cap persistence
- `src/dj/web-logging.ts` - Structured logging + Notion audit trail
- `docs/dj/web-operator.md` - Full documentation

**Action Classification:**

| Class | Approval | Description |
|-------|----------|-------------|
| READ_ONLY | Never | Navigation, viewing |
| DRAFT | Never | Save drafts (not publish) |
| SUBMIT_LOW_RISK | If allowlisted | Contact forms, newsletters |
| PUBLISH | Always | Making content public |
| PAYMENT | Always | Financial transactions |
| SECURITY | Always | Auth settings changes |
| DESTRUCTIVE | Always | Delete, cancel actions |
| AUTH | Always | Login, registration |
| UPLOAD | Always | File uploads |

**Default Allowlist (Allowlist C):**
- `stataipodcast.com` - /contact, /newsletter, /subscribe, /join
- `forms.gle` - Navigation only (redirect)
- `docs.google.com` - /forms/d/e/.../viewform, /forms/d/e/.../formResponse

**Deny Rules (trigger approval even if allowlisted):**
- Password/auth fields, payment fields, file upload, CAPTCHA
- Sensitive keywords (medical, SSN, etc.), >2 free-text fields

**Auto-Submit Caps:**
- Per workflow: 1 (default)
- Per day: 3 (default)
- Persists across restarts

**Profile Requirements:**
- cheap: Browser disabled (switch to normal/deep)
- normal: Browser allowed, bounded
- deep: Extended limits, self-expiring

**Cron Safety:** Tasks NEVER inherit deep mode.

### Notion Integration (M4.5) (`src/dj/notion/`)

Notion as canonical database for DJ workflows with raw HTTP client (no SDK).

**Key files:**
- `src/dj/notion/notion-client.ts` - HTTP client with retries and rate limiting (22 tests)
- `src/dj/notion/notion-service.ts` - Higher-level helpers for DJ operations (27 tests)
- `src/dj/notion/types.ts` - Type definitions and error classes
- `src/dj/research-service.ts` - Research caching and Notion save (29 tests)
- `src/dj/site-service.ts` - Squarespace sync with idempotent ContentHash (20 tests)

**Features:**
- Raw fetch HTTP client (no @notionhq/client SDK dependency)
- Notion API version: `2025-09-03` (matches docs/skills curl examples)
- Exponential backoff with jitter for 429/5xx retries (max 3)
- Privacy-preserving WebOps logging (domains only, no field values)
- Content hashing (SHA-256) for idempotent sync
- Blocks-to-markdown conversion for content fetch
- Non-fatal write errors (log locally and continue)

**Services:**

| Service | Purpose | Notion Database |
|---------|---------|-----------------|
| WebOps Logging | Audit trail for browser actions | WebOps Log |
| Research Save | Cache research with deduplication | Research Radar |
| Site Sync | Squarespace draft/publish tracking | Posts |

**Configuration:**
```json
{
  "dj": {
    "notion": {
      "webOpsDbId": "your-webops-database-id",
      "researchDbId": "your-research-database-id",
      "postsDbId": "your-posts-database-id"
    }
  }
}
```

**Environment Variables:**

| Variable | Description |
|----------|-------------|
| `NOTION_API_KEY` | Notion integration token (secret_xxx) |
| `DJ_NOTION_WEBOPS_DB_ID` | WebOps Log database ID |
| `DJ_NOTION_RESEARCH_DB_ID` | Research Radar database ID |
| `DJ_NOTION_POSTS_DB_ID` | Posts database ID |

**Usage:**
```typescript
import { createNotionClient, NotionService } from "openclaw/dj/notion";

// Create client with retries
const client = createNotionClient({ apiKey: process.env.NOTION_API_KEY });

// Higher-level service
const service = new NotionService(client, {
  webOpsDbId: "...",
  researchDbId: "...",
  postsDbId: "...",
});

// Log WebOps action (privacy-preserving)
await service.createWebOpsLogEntry({
  workflowId: "wf-123",
  task: "Fill contact form",
  domainsVisited: ["example.com"],
  actionsCount: 5,
  // Note: No field values logged
});

// Save research with deduplication
const result = await service.saveResearchEntry({
  title: "AI Ethics Research",
  query: "AI ethics regulations",
  cacheKey: "abc123...",
  summary: ["Finding 1", "Finding 2"],
  citations: [{ title: "Source", url: "https://..." }],
});
```

**Idempotent Sync (Site Service):**
```typescript
import { SiteService, computeContentHash } from "openclaw/dj";

const site = new SiteService({ notionService: service });

// Check if content changed before browser automation
const { changed, newHash } = await site.checkContentChanged(pageId, content);
if (!changed) {
  console.log("Content unchanged, skipping browser update");
  return;
}

// After successful browser update
await site.recordSyncSuccess(pageId, newHash);
```

### DJ Documentation (`docs/dj/`)

- `runbook.md` - Complete setup guide (Telegram, Notion, gog, LM Studio)
- `budget.md` - Budget system documentation
- `work-busy-ics.md` - Outlook ICS integration guide
- `notion-schema.md` - Notion database schemas
- `cron-jobs.md` - Scheduled tasks (daily brief, weekly review, ops digest)
- `web-operator.md` - Web Operator policy and usage (M4)
- `squarespace.md` - Squarespace integration guide (M4)
- `research.md` - Research skill documentation (M4)

## Further Reading

For detailed information, see [AGENTS.md](./AGENTS.md) which contains:
- Detailed PR workflow and commit guidelines
- Security and configuration tips
- Multi-agent safety protocols
- Tool schema guardrails
- NPM publishing workflow
- Platform-specific notes and troubleshooting
