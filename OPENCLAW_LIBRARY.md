# OpenClaw

OpenClaw is a multi-channel AI gateway and personal assistant platform that runs on your own devices. It provides a unified control plane for connecting AI agents to messaging channels including WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Microsoft Teams, Matrix, and many others. The Gateway acts as a WebSocket-based control plane that manages sessions, routes messages, executes tools, schedules automation tasks, and coordinates browser control. All configuration is managed through a JSON5 config file at `~/.openclaw/openclaw.json` with extensive support for environment variables, secrets management, and multi-agent routing.

The platform is built around the concept of skills (AgentSkills-compatible folders) that teach the agent how to use various tools, from browser automation to messaging actions. OpenClaw supports companion apps for macOS, iOS, and Android that can act as nodes providing device-specific capabilities like camera access, screen recording, and location services. The Gateway maintains long-lived connections to all messaging surfaces and exposes a typed WebSocket API for clients, making it suitable for always-on personal assistant deployments.

## Installation and Onboarding

Install OpenClaw globally and run the interactive onboarding wizard to configure your gateway, workspace, and channels.

```bash
# Install OpenClaw globally (requires Node >= 22)
npm install -g openclaw@latest
# or: pnpm add -g openclaw@latest

# Run the onboarding wizard with daemon installation
openclaw onboard --install-daemon

# Non-interactive installation with specific provider
openclaw onboard --non-interactive \
  --auth-choice anthropic-api-key \
  --anthropic-api-key "sk-ant-..." \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon
```

## Gateway Management

The Gateway is the central WebSocket control plane that manages all messaging channels, sessions, and tool execution. It can be run in foreground mode for development or installed as a system service for production.

```bash
# Start gateway in foreground with verbose logging
openclaw gateway --port 18789 --verbose

# Force-start gateway (kills existing listener on port)
openclaw gateway --force

# Install gateway as system service (launchd/systemd)
openclaw gateway install --port 18789 --runtime node

# Service management commands
openclaw gateway status        # Check gateway health and RPC probe
openclaw gateway status --deep # Include system-level service scans
openclaw gateway restart       # Restart the service
openclaw gateway stop          # Stop the service

# View gateway logs
openclaw logs --follow         # Tail logs in real-time
openclaw logs --limit 200      # Show last 200 lines
openclaw logs --json           # Output as JSON for scripting
```

## Configuration Management

OpenClaw uses JSON5 configuration with support for environment variable substitution, secret refs, and file includes. Configuration changes are hot-reloaded by default.

```bash
# Get a config value
openclaw config get agents.defaults.workspace

# Set config values
openclaw config set agents.defaults.model.primary "anthropic/claude-sonnet-4-5"
openclaw config set agents.defaults.heartbeat.every "30m"

# Unset a config value
openclaw config unset tools.web.search.apiKey

# Validate config without starting gateway
openclaw config validate --json

# Interactive configuration wizard
openclaw configure

# Apply config changes via Gateway RPC
openclaw gateway call config.patch --params '{
  "raw": "{ channels: { telegram: { groups: { \"*\": { requireMention: false } } } } }",
  "baseHash": "<hash-from-config.get>"
}'
```

Example configuration file (`~/.openclaw/openclaw.json`):

```json5
{
  // Agent configuration
  agents: {
    defaults: {
      workspace: "~/.openclaw/workspace",
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["openai/gpt-5.2"],
      },
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
  },

  // Channel access control
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      allowFrom: ["+15551234567"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      enabled: true,
      botToken: "${TELEGRAM_BOT_TOKEN}",
      dmPolicy: "allowlist",
      allowFrom: ["tg:123456789"],
    },
  },

  // Session management
  session: {
    dmScope: "per-channel-peer", // Isolate DM sessions per user
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
  },

  // Gateway server settings
  gateway: {
    port: 18789,
    bind: "loopback",
    auth: {
      token: "${OPENCLAW_GATEWAY_TOKEN}",
    },
    reload: { mode: "hybrid" },
  },

  // Browser control
  browser: {
    enabled: true,
    defaultProfile: "openclaw",
    color: "#FF4500",
  },
}
```

## Channel Management

Manage messaging channel connections, authentication, and health across WhatsApp, Telegram, Discord, Slack, and other platforms.

```bash
# List configured channels and auth profiles
openclaw channels list --json

# Check channel health with probe
openclaw channels status --probe

# View channel logs
openclaw channels logs --channel telegram --lines 100

# Add a new channel account (non-interactive)
openclaw channels add --channel telegram \
  --account alerts \
  --name "Alerts Bot" \
  --token "$TELEGRAM_BOT_TOKEN"

openclaw channels add --channel discord \
  --account work \
  --name "Work Bot" \
  --token "$DISCORD_BOT_TOKEN"

# Remove a channel account
openclaw channels remove --channel discord --account work --delete

# WhatsApp QR login
openclaw channels login --channel whatsapp
openclaw channels login --channel whatsapp --account work

# Logout from a channel
openclaw channels logout --channel whatsapp
```

## Agent Communication

Send messages and run agent turns through the Gateway. The agent command executes a single turn with optional delivery back to messaging channels.

```bash
# Send a message to a recipient
openclaw message send --target "+15551234567" --message "Hello from OpenClaw"

# Create a poll on Discord
openclaw message poll --channel discord \
  --target "channel:123456789" \
  --poll-question "What's for lunch?" \
  --poll-option Pizza \
  --poll-option Sushi

# Run an agent turn via Gateway
openclaw agent --message "Summarize my calendar for today" \
  --thinking high \
  --verbose on \
  --json

# Run agent with delivery to specific channel
openclaw agent --message "Send weather update" \
  --to "+15551234567" \
  --channel whatsapp \
  --deliver

# Local agent turn (embedded, no Gateway)
openclaw agent --message "Quick calculation: 15% of 340" --local
```

## Multi-Agent Management

OpenClaw supports multiple isolated agents with separate workspaces, models, and routing bindings for different use cases.

```bash
# List configured agents
openclaw agents list --bindings --json

# Add a new agent with workspace
openclaw agents add home \
  --workspace ~/.openclaw/workspace-home \
  --model "anthropic/claude-sonnet-4-5" \
  --bind "whatsapp:personal"

openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model "openai/gpt-5.2" \
  --bind "slack:work" \
  --bind "discord:work"

# Manage routing bindings
openclaw agents bind --agent home --bind "telegram:personal"
openclaw agents unbind --agent work --bind "discord:work"

# Delete an agent
openclaw agents delete home --force
```

Multi-agent configuration example:

```json5
{
  agents: {
    list: [
      { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },
      { id: "work", workspace: "~/.openclaw/workspace-work" },
    ],
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "slack", accountId: "work" } },
  ],
}
```

## Model Configuration

Configure AI models, authentication profiles, fallbacks, and aliases for flexible model selection.

```bash
# Check model status and auth profiles
openclaw models status --probe
openclaw models status --json

# List available models
openclaw models list --all --provider anthropic

# Set primary model
openclaw models set "anthropic/claude-sonnet-4-5"

# Set image model
openclaw models set-image "openai/dall-e-3"

# Manage model aliases
openclaw models aliases list
openclaw models aliases add sonnet "anthropic/claude-sonnet-4-5"
openclaw models aliases remove sonnet

# Manage fallback models
openclaw models fallbacks add "openai/gpt-5.2"
openclaw models fallbacks list
openclaw models fallbacks clear

# Authenticate with providers
openclaw models auth add
openclaw models auth setup-token --provider anthropic
openclaw models auth paste-token --provider openai \
  --profile-id "openai:manual" \
  --expires-in "365d"

# Scan for available models
openclaw models scan --provider anthropic --set-default
```

## DM Pairing and Access Control

Manage DM pairing requests for unknown senders and configure access policies per channel.

```bash
# List pending pairing requests
openclaw pairing list whatsapp
openclaw pairing list --channel telegram --json

# Approve a pairing request
openclaw pairing approve whatsapp ABC123
openclaw pairing approve --channel telegram --account alerts XYZ789 --notify

# Device pairing management
openclaw devices list --json
openclaw devices approve --latest
openclaw devices reject <requestId>
openclaw devices remove <deviceId>
openclaw devices rotate --device <id> --role admin --scope config
```

Access control configuration:

```json5
{
  channels: {
    whatsapp: {
      // DM access policy: pairing | allowlist | open | disabled
      dmPolicy: "pairing",
      allowFrom: ["+15551234567"],

      // Group access policy
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
}
```

## Cron Jobs and Scheduled Tasks

Schedule automated agent runs, reminders, and recurring tasks using the built-in cron system.

```bash
# Add a one-shot reminder
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the docs" \
  --wake now \
  --delete-after-run

# Add a recurring job with delivery
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates" \
  --model "opus" \
  --thinking high \
  --announce \
  --channel slack \
  --to "channel:C1234567890"

# Add a relative-time reminder (20 minutes from now)
openclaw cron add \
  --name "Quick reminder" \
  --at "20m" \
  --session main \
  --system-event "Check battery status" \
  --wake now

# List and manage jobs
openclaw cron list --all --json
openclaw cron status
openclaw cron runs --id <job-id> --limit 50

# Edit a job
openclaw cron edit <job-id> --message "Updated prompt" --model opus

# Manual job execution
openclaw cron run <job-id>
openclaw cron run <job-id> --force

# Enable/disable jobs
openclaw cron enable <job-id>
openclaw cron disable <job-id>

# Remove a job
openclaw cron rm <job-id>
```

Cron tool call example (JSON):

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates.",
    "lightContext": true
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

## Webhook Integration

Enable HTTP webhook endpoints for external triggers to wake the agent or run isolated tasks.

```bash
# Wake the agent with a system event
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'

# Run an isolated agent task
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{
    "message": "Summarize inbox",
    "name": "Email",
    "deliver": true,
    "channel": "whatsapp",
    "to": "+15551234567",
    "model": "openai/gpt-5.2-mini",
    "timeoutSeconds": 120
  }'

# Gmail webhook setup
openclaw webhooks gmail setup \
  --account user@gmail.com \
  --project my-gcp-project \
  --hook-url "https://example.com/hooks/gmail" \
  --hook-token "$GMAIL_HOOK_TOKEN"
```

Webhook configuration:

```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    path: "/hooks",
    defaultSessionKey: "hook:ingress",
    allowRequestSessionKey: false,
    allowedSessionKeyPrefixes: ["hook:"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        agentId: "main",
        deliver: true,
      },
    ],
  },
}
```

## Browser Control

OpenClaw includes a dedicated browser automation system using an isolated Chrome/Brave/Edge profile for agent-controlled web interactions.

```bash
# Browser status and lifecycle
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw stop

# Tab management
openclaw browser tabs
openclaw browser open https://example.com
openclaw browser focus <targetId>
openclaw browser close <targetId>

# Page inspection
openclaw browser screenshot
openclaw browser screenshot --full-page --ref 12
openclaw browser snapshot --format ai
openclaw browser snapshot --interactive --compact --depth 6
openclaw browser snapshot --efficient --labels
openclaw browser console --level error
openclaw browser pdf

# Page actions using refs from snapshot
openclaw browser navigate https://example.com
openclaw browser click 12 --double
openclaw browser type 23 "hello world" --submit
openclaw browser press Enter
openclaw browser hover 44
openclaw browser drag 10 11
openclaw browser select 9 OptionA OptionB

# Form filling
openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'

# File operations
openclaw browser upload /tmp/openclaw/uploads/file.pdf
openclaw browser download e12 report.pdf

# Wait operations
openclaw browser wait --text "Done"
openclaw browser wait "#main" --url "**/dash" --load networkidle

# State management
openclaw browser cookies
openclaw browser cookies set session abc123 --url "https://example.com"
openclaw browser set offline on
openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"
openclaw browser set media dark
openclaw browser set device "iPhone 14"

# Debugging
openclaw browser highlight e12
openclaw browser trace start
openclaw browser trace stop
openclaw browser errors --clear
```

Browser configuration:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "openclaw",
    color: "#FF4500",
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: true,
    },
  },
}
```

## Node Management

Manage connected device nodes (macOS, iOS, Android, headless) that provide device-specific capabilities like camera, screen recording, and system commands.

```bash
# Node status and listing
openclaw nodes status --connected
openclaw nodes list --connected --last-connected "24h"
openclaw nodes describe --node <id|name|ip>

# Approve/reject pending nodes
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes rename --node <id> --name "My MacBook"

# Run commands on nodes
openclaw nodes run --node <id> --cwd /tmp "ls -la"
openclaw nodes notify --node <id> --title "Alert" --body "Task completed"

# Camera operations
openclaw nodes camera list --node <id>
openclaw nodes camera snap --node <id> --facing back --quality 0.8
openclaw nodes camera clip --node <id> --duration 10s

# Canvas and screen operations
openclaw nodes canvas snapshot --node <id> --format png
openclaw nodes canvas present --node <id> --target "https://example.com"
openclaw nodes canvas eval "document.title" --node <id>
openclaw nodes screen record --node <id> --duration 30s --fps 30

# Location
openclaw nodes location get --node <id> --accuracy precise

# Invoke custom commands
openclaw nodes invoke --node <id> --command "system.run" \
  --params '{"command":"uname -a"}'
```

## Skills Management

Skills are AgentSkills-compatible folders that teach the agent how to use tools. They support gating rules based on environment, binaries, and configuration.

```bash
# List available skills
openclaw skills list
openclaw skills list --eligible --json

# Get skill details
openclaw skills info <skill-name>

# Check skill requirements
openclaw skills check

# Install skills via ClawHub
npx clawhub install <skill-slug>
npx clawhub update --all
npx clawhub sync --all
```

Skills configuration:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "${GEMINI_API_KEY}",
        env: {
          GEMINI_API_KEY: "${GEMINI_API_KEY}",
        },
        config: {
          endpoint: "https://api.example.com",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
    load: {
      watch: true,
      watchDebounceMs: 250,
      extraDirs: ["~/.shared-skills"],
    },
  },
}
```

## Session Management

Sessions control conversation continuity and isolation. Configure DM scoping, reset policies, and maintenance rules for session state.

```bash
# View session status
openclaw status --all
openclaw sessions --json --active 60

# Session cleanup
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --enforce

# Chat commands for session control
# /status    - Show session diagnostics
# /new       - Reset session
# /compact   - Summarize and compress context
# /stop      - Abort current run
# /context list - Show system prompt contents
```

Session configuration:

```json5
{
  session: {
    dmScope: "per-channel-peer", // main | per-peer | per-channel-peer | per-account-channel-peer
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      direct: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    maintenance: {
      mode: "enforce",
      pruneAfter: "30d",
      maxEntries: 500,
      rotateBytes: "10mb",
    },
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
      ],
      default: "allow",
    },
  },
}
```

## Health and Diagnostics

Run health checks, diagnostics, and security audits to ensure proper configuration and operation.

```bash
# Health check
openclaw health --json
openclaw status --deep --verbose

# Doctor diagnostics and fixes
openclaw doctor
openclaw doctor --fix
openclaw doctor --deep --yes

# Security audit
openclaw security audit
openclaw security audit --deep --fix

# Gateway probe
openclaw gateway probe
openclaw gateway discover

# System diagnostics
openclaw system presence --json
openclaw system heartbeat last
openclaw system event --text "Test event" --mode now
```

## Remote Access

Access the Gateway remotely using Tailscale, SSH tunnels, or direct connections with proper authentication.

```bash
# SSH tunnel to remote gateway
ssh -N -L 18789:127.0.0.1:18789 user@remote-host

# Connect CLI to remote gateway
openclaw --profile remote status \
  --url ws://127.0.0.1:18789 \
  --token "$GATEWAY_TOKEN"

# TUI with remote connection
openclaw tui \
  --url ws://remote-host:18789 \
  --token "$GATEWAY_TOKEN" \
  --session main
```

Tailscale configuration:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: {
      mode: "serve", // off | serve | funnel
      resetOnExit: true,
    },
    auth: {
      mode: "token",
      token: "${OPENCLAW_GATEWAY_TOKEN}",
    },
  },
}
```

OpenClaw is designed for developers and power users who want full control over their AI assistant infrastructure. The primary use cases include personal productivity automation with scheduled tasks and cross-platform messaging integration, home automation through webhook triggers and cron jobs, and team collaboration with multi-agent routing for different workspaces. The platform excels at scenarios requiring always-on availability with graceful session management and context preservation across device reboots.

For integration patterns, OpenClaw works well as a backend for custom chat applications via its WebSocket protocol, as a bridge between external services and messaging platforms via webhooks, and as an automation hub coordinating browser tasks, device commands, and scheduled operations. The plugin architecture allows extending channel support beyond the built-in options, while the skills system enables adding new agent capabilities without modifying core code. Production deployments typically run the Gateway as a supervised service with remote access via Tailscale and secure webhook endpoints for external triggers.
