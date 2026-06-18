# OpenClaw Documentation Map

> Auto-generated documentation map for AI navigation.
> To learn about a topic, an AI agent can fetch the relevant page. For in-depth coverage, fetch pages whose H2 headings match the topic.
> Total pages indexed: 676

## Get started

### Overview

- **index**
- **[Showcase](https://docs.openclaw.ai/start/showcase)**
  - Fresh from Discord
  - Automation and workflows
  - Knowledge and memory
  - Voice and phone
  - Infrastructure and deployment
  - Home and hardware
  - Community projects
  - Submit your project
  - Related

- **[Features](https://docs.openclaw.ai/concepts/features)**
  - Highlights
  - Full list
  - Related

### First steps

- **[Getting started](https://docs.openclaw.ai/start/getting-started)**
  - What you need
  - Quick setup
  - What to do next
  - Related

- **[Onboarding overview](https://docs.openclaw.ai/start/onboarding-overview)**
  - Which path should I use?
  - What onboarding configures
  - CLI onboarding
  - macOS app onboarding
  - Custom or unlisted providers
  - Related

- **[Onboarding (CLI)](https://docs.openclaw.ai/start/wizard)**
  - Locale
  - QuickStart vs Advanced
  - What onboarding configures
  - Add another agent
  - Full reference
  - Related docs

- **[Onboarding (macOS app)](https://docs.openclaw.ai/start/onboarding)**
  - Related

### Guides

- **[Personal assistant setup](https://docs.openclaw.ai/start/openclaw)**
  - ⚠️ Safety first
  - Prerequisites
  - The two-phone setup (recommended)
  - 5-minute quick start
  - Give the agent a workspace (AGENTS)
  - The config that turns it into "an assistant"
  - Sessions and memory
  - Heartbeats (proactive mode)
  - Media in and out
  - Operations checklist
    _... and 2 more headings_

- **[CLI setup reference](https://docs.openclaw.ai/start/wizard-cli-reference)**
  - What the wizard does
  - Local flow details
  - Remote mode details
  - Auth and model options
  - Outputs and internals
  - Related docs

- **[CLI automation](https://docs.openclaw.ai/start/wizard-cli-automation)**
  - Baseline non-interactive example
  - Provider-specific examples
  - Add another agent
  - Related docs

## Install

### Install overview

- **[Install](https://docs.openclaw.ai/install/index)**
  - System requirements
  - Recommended: installer script
  - Alternative install methods
    - Local prefix installer (`install-cli.sh`)
    - npm, pnpm, or bun
    - From source
    - Install from the GitHub main checkout
    - Containers and package managers
  - Verify the install
  - Hosting and deployment
    _... and 2 more headings_

- **[Installer internals](https://docs.openclaw.ai/install/installer)**
  - Quick commands
  - install.sh
    - Flow (install.sh)
    - Source checkout detection
    - Examples (install.sh)
  - install-cli.sh
    - Flow (install-cli.sh)
    - Examples (install-cli.sh)
  - install.ps1
    - Flow (install.ps1)
      _... and 4 more headings_

- **[Node.js](https://docs.openclaw.ai/install/node)**
  - Check your version
  - Install Node
  - Troubleshooting
    - `openclaw: command not found`
    - Permission errors on `npm install -g` (Linux)
  - Related

### Maintenance

#### Migrating

- **[Updating](https://docs.openclaw.ai/install/updating)**
  - Recommended: `openclaw update`
  - Switch between npm and git installs
  - Alternative: re-run the installer
  - Alternative: manual npm, pnpm, or bun
    - Advanced npm install topics
  - Auto-updater
  - After updating
    - Run doctor
    - Restart the gateway
    - Verify
      _... and 5 more headings_

- **[Migration guide](https://docs.openclaw.ai/install/migrating)**
  - Import from another agent system
  - Move OpenClaw to a new machine
    - Migration steps
    - Common pitfalls
    - Verification checklist
  - Upgrade a plugin in place
  - Related

- **[Migrating from Claude](https://docs.openclaw.ai/install/migrating-claude)**
  - Two ways to import
  - What gets imported
  - What stays archive-only
  - Source selection
  - Recommended flow
  - Conflict handling
  - JSON output for automation
  - Troubleshooting
  - Related

- **[Migrating from Hermes](https://docs.openclaw.ai/install/migrating-hermes)**
  - Two ways to import
  - What gets imported
  - What stays archive-only
  - Recommended flow
  - Conflict handling
  - Secrets
  - JSON output for automation
  - Troubleshooting
  - Related

- **[Uninstall](https://docs.openclaw.ai/install/uninstall)**
  - Easy path (CLI still installed)
  - Manual service removal (CLI not installed)
    - macOS (launchd)
    - Linux (systemd user unit)
    - Windows (Scheduled Task)
  - Normal install vs source checkout
    - Normal install (install.sh / npm / pnpm / bun)
    - Source checkout (git clone)
  - Related

- **[Release channels](https://docs.openclaw.ai/install/development-channels)**
  - Switching channels
  - One-off version or tag targeting
  - Dry run
  - Plugins and channels
  - Checking current status
  - Tagging best practices
  - macOS app availability
  - Related

### Containers

- **[Ansible](https://docs.openclaw.ai/install/ansible)**
  - Prerequisites
  - What you get
  - Quick start
  - What gets installed
  - Post-Install Setup
    - Quick commands
  - Security architecture
  - Manual installation
  - Updating
  - Troubleshooting
    _... and 2 more headings_

- **[Bun (experimental)](https://docs.openclaw.ai/install/bun)**
  - Install
  - Lifecycle scripts
  - Caveats
  - Related

- **[ClawDock](https://docs.openclaw.ai/install/clawdock)**
  - Install
  - What you get
    - Basic operations
    - Container access
    - Web UI and pairing
    - Setup and maintenance
    - Utilities
  - First-time flow
  - Config and secrets
  - Related

- **[Docker](https://docs.openclaw.ai/install/docker)**
  - Is Docker right for me?
  - Prerequisites
  - Containerized gateway
    - Manual flow
    - Environment variables
    - Observability
    - Health checks
    - LAN vs loopback
    - Host Local Providers
    - Bonjour / mDNS
      _... and 7 more headings_

- **[Nix](https://docs.openclaw.ai/install/nix)**
  - What you get
  - Quick start
  - Nix-mode runtime behavior
    - What changes in Nix mode
    - Config and state paths
    - Service PATH discovery
  - Related

- **[Podman](https://docs.openclaw.ai/install/podman)**
  - Prerequisites
  - Quick start
  - Podman and Tailscale
  - Systemd (Quadlet, optional)
  - Config, env, and storage
  - Useful commands
  - Troubleshooting
  - Related

### Hosting

- **[Azure](https://docs.openclaw.ai/install/azure)**
  - What you will do
  - What you need
  - Configure deployment
  - Deploy Azure resources
  - Install OpenClaw
  - Cost considerations
  - Cleanup
  - Next steps
  - Related

- **[DigitalOcean](https://docs.openclaw.ai/install/digitalocean)**
  - Prerequisites
  - Setup
  - Persistence and backups
  - 1 GB RAM tips
  - Troubleshooting
  - Next steps
  - Related

- **[Docker VM runtime](https://docs.openclaw.ai/install/docker-vm-runtime)**
  - Bake required binaries into the image
  - Build and launch
  - What persists where
  - Updates
  - Related

- **[exe.dev](https://docs.openclaw.ai/install/exe-dev)**
  - Beginner quick path
  - What you need
  - Automated install with Shelley
  - Manual installation
  - 1. Create the VM
  - 2. Install prerequisites (on the VM)
  - 3. Install OpenClaw
  - 4. Setup nginx to proxy OpenClaw to port 8000
  - 5. Access OpenClaw and grant privileges
  - Remote channel setup
    _... and 3 more headings_

- **[Fly.io](https://docs.openclaw.ai/install/fly)**
  - What you need
  - Beginner quick path
  - Troubleshooting
    - "App is not listening on expected address"
    - Health checks failing / connection refused
    - OOM / Memory Issues
    - Gateway lock issues
    - Config not being read
    - Writing config via SSH
    - State not persisting
      _... and 12 more headings_

- **[GCP](https://docs.openclaw.ai/install/gcp)**
  - What are we doing (simple terms)?
  - Quick path (experienced operators)
  - What you need
  - Troubleshooting
  - Service accounts (security best practice)
  - Next steps
  - Related

- **[Hetzner](https://docs.openclaw.ai/install/hetzner)**
  - Goal
  - What are we doing (simple terms)?
  - Quick path (experienced operators)
  - What you need
  - Infrastructure as Code (Terraform)
  - Next steps
  - Related

- **[Hostinger](https://docs.openclaw.ai/install/hostinger)**
  - Prerequisites
  - Option A: 1-Click OpenClaw
  - Option B: OpenClaw on VPS
  - Verify your setup
  - Troubleshooting
  - Next steps
  - Related

- **[Kubernetes](https://docs.openclaw.ai/install/kubernetes)**
  - Why not Helm?
  - What you need
  - Quick start
  - Local testing with Kind
  - Step by step
    - 1. Deploy
    - 2. Access the gateway
  - What gets deployed
  - Customization
    - Agent instructions
      _... and 10 more headings_

- **[Linux server](https://docs.openclaw.ai/vps)**
  - Pick a provider
  - How cloud setups work
  - Harden admin access first
  - Shared company agent on a VPS
  - Using nodes with a VPS
  - Startup tuning for small VMs and ARM hosts
    - systemd tuning checklist (optional)
  - Related

- **[macOS VMs](https://docs.openclaw.ai/install/macos-vm)**
  - Recommended default (most users)
  - macOS VM options
    - Local VM on your Apple Silicon Mac (Lume)
    - Hosted Mac providers (cloud)
  - Quick path (Lume, experienced users)
  - What you need (Lume)
  - 1. Install Lume
  - 2. Create the macOS VM
  - 3. Complete Setup Assistant
  - 4. Get the VM IP address
       _... and 9 more headings_

- **install/northflank**
- **[Oracle Cloud](https://docs.openclaw.ai/install/oracle)**
  - Prerequisites
  - Setup
  - Verify the security posture
  - ARM notes
  - Persistence and backups
  - Fallback: SSH tunnel
  - Troubleshooting
  - Next steps
  - Related

- **install/railway**
- **[Raspberry Pi](https://docs.openclaw.ai/install/raspberry-pi)**
  - Hardware compatibility
  - Prerequisites
  - Setup
  - Performance tips
  - Recommended model setup
  - ARM binary notes
  - Persistence and backups
  - Troubleshooting
  - Next steps
  - Related

- **install/render**
- **[Upstash Box](https://docs.openclaw.ai/install/upstash)**
  - Prerequisites
  - Create a Box
  - Connect with an SSH tunnel
  - Install OpenClaw
  - Run onboarding
  - Start the Gateway
  - Auto-restart
  - Troubleshooting
  - Related

### Advanced setup

- **[Setup](https://docs.openclaw.ai/start/setup)**
  - TL;DR
  - Prereqs (from source)
  - Tailoring strategy (so updates do not hurt)
  - Run the Gateway from this repo
  - Stable workflow (macOS app first)
  - Bleeding edge workflow (Gateway in a terminal)
    - 0. (Optional) Run the macOS app from source too
    - 1. Start the dev Gateway
    - 2. Point the macOS app at your running Gateway
    - 3. Verify
         _... and 5 more headings_

- **[OpenClaw agent runtime workflow](https://docs.openclaw.ai/openclaw-agent-runtime)**
  - Type checking and linting
  - Running Agent Runtime Tests
  - Manual testing
  - Clean slate reset
  - References
  - Related

## Channels

### Overview

- **[Chat channels](https://docs.openclaw.ai/channels/index)**
  - Delivery notes
  - Supported channels
  - Notes

- **[BlueBubbles removal and the imsg iMessage path](https://docs.openclaw.ai/announcements/bluebubbles-imessage)**
  - What changed
  - What to do
  - Migration notes
  - See also

### Mainstream messaging

- **[Discord](https://docs.openclaw.ai/channels/discord)**
  - Quick setup
  - Recommended: Set up a guild workspace
  - Runtime model
  - Forum channels
  - Interactive components
  - Access control and routing
    - Role-based agent routing
  - Native commands and command auth
  - Feature details
  - Tools and action gates
    _... and 9 more headings_

- **[Slack](https://docs.openclaw.ai/channels/slack)**
  - Choosing Socket Mode or HTTP Request URLs
  - Install
  - Quick setup
  - Socket Mode transport tuning
  - Manifest and scope checklist
    - Additional manifest settings
  - Token model
  - Actions and gates
  - Access control and routing
  - Threading, sessions, and reply tags
    _... and 22 more headings_

- **[Telegram](https://docs.openclaw.ai/channels/telegram)**
  - Quick setup
  - Telegram side settings
  - Access control and activation
    - Group bot identity
  - Runtime behavior
  - Feature reference
  - Error reply controls
  - Troubleshooting
  - Configuration reference
  - Related

- **[WhatsApp](https://docs.openclaw.ai/channels/whatsapp)**
  - Install (on demand)
  - Quick setup
  - Deployment patterns
  - Runtime model
  - Approval prompts
  - Plugin hooks and privacy
  - Access control and activation
  - Configured ACP bindings
  - Personal-number and self-chat behavior
  - Message normalization and context
    _... and 11 more headings_

- **[Signal](https://docs.openclaw.ai/channels/signal)**
  - Prerequisites
  - Quick setup (beginner)
  - What it is
  - Config writes
  - The number model (important)
  - Setup path A: link existing Signal account (QR)
  - Setup path B: register dedicated bot number (SMS, Linux)
  - External daemon mode (httpUrl)
  - Container mode (bbernhard/signal-cli-rest-api)
  - Access control (DMs + groups)
    _... and 10 more headings_

- **[Microsoft Teams](https://docs.openclaw.ai/channels/msteams)**
  - Bundled plugin
  - Quick setup
  - Goals
  - Config writes
  - Access control (DMs + groups)
    - How it works
    - Step 1: Create Azure Bot
    - Step 2: Get Credentials
    - Step 3: Configure Messaging Endpoint
    - Step 4: Enable Teams Channel
      _... and 50 more headings_

- **[Google Chat](https://docs.openclaw.ai/channels/googlechat)**
  - Install
  - Quick setup (beginner)
  - Add to Google Chat
  - Public URL (Webhook-only)
    - Option A: Tailscale Funnel (Recommended)
    - Option B: Reverse Proxy (Caddy)
    - Option C: Cloudflare Tunnel
  - How it works
  - Targets
  - Config highlights
    _... and 4 more headings_

- **[iMessage](https://docs.openclaw.ai/channels/imessage)**
  - Quick setup
  - Requirements and permissions (macOS)
  - Enabling the imsg private API
    - Setup
    - When you can't disable SIP
  - Access control and routing
  - ACP conversation bindings
  - Deployment patterns
  - Media, chunking, and delivery targets
  - Private API actions
    _... and 9 more headings_

- **[Coming from BlueBubbles](https://docs.openclaw.ai/channels/imessage-from-bluebubbles)**
  - Migration checklist
  - When this migration makes sense
  - What imsg does
  - Before you start
  - Config translation
  - Group registry footgun
  - Step-by-step
  - Action parity at a glance
  - Pairing, sessions, and ACP bindings
  - No rollback channel
    _... and 1 more headings_

- **[Matrix](https://docs.openclaw.ai/channels/matrix)**
  - Install
  - Setup
    - Interactive setup
    - Minimal config
    - Auto-join
    - Allowlist target formats
    - Account ID normalization
    - Cached credentials
    - Environment variables
  - Configuration example
    _... and 40 more headings_

- **[Matrix migration](https://docs.openclaw.ai/channels/matrix-migration)**
  - What the migration does automatically
  - What the migration cannot do automatically
  - Recommended upgrade flow
  - How encrypted migration works
  - Common messages and what they mean
    - Upgrade and detection messages
    - Encrypted-state recovery messages
    - Manual recovery messages
    - Custom plugin install messages
  - If encrypted history still does not come back
    _... and 2 more headings_

- **[Matrix presentation metadata](https://docs.openclaw.ai/channels/matrix-presentation)**
  - Event content
  - Fallback behavior
  - Supported blocks
  - Interactions
  - Relationship to approval metadata
  - Media messages

- **[Matrix push rules for quiet previews](https://docs.openclaw.ai/channels/matrix-push-rules)**
  - Prerequisites
  - Steps
  - Multi-bot notes
  - Homeserver notes
  - Related

### Developer and self-hosted

- **[IRC](https://docs.openclaw.ai/channels/irc)**
  - Quick start
  - Security defaults
  - Access control
    - Common gotcha: `allowFrom` is for DMs, not channels
  - Reply triggering (mentions)
  - Security note (recommended for public channels)
    - Same tools for everyone in the channel
    - Different tools per sender (owner gets more power)
  - NickServ
  - Environment variables
    _... and 2 more headings_

- **[Mattermost](https://docs.openclaw.ai/channels/mattermost)**
  - Install
  - Quick setup
  - Native slash commands
  - Environment variables (default account)
  - Chat modes
  - Threading and sessions
  - Access control (DMs)
  - Channels (groups)
  - Targets for outbound delivery
  - DM channel retry
    _... and 8 more headings_

- **[Nextcloud Talk](https://docs.openclaw.ai/channels/nextcloud-talk)**
  - Bundled plugin
  - Quick setup (beginner)
  - Notes
  - Access control (DMs)
  - Rooms (groups)
  - Capabilities
  - Configuration reference (Nextcloud Talk)
  - Related

- **[Nostr](https://docs.openclaw.ai/channels/nostr)**
  - Bundled plugin
    - Older/custom installs
    - Non-interactive setup
  - Quick setup
  - Configuration reference
  - Profile metadata
  - Access control
    - DM policies
    - Allowlist example
  - Key formats
    _... and 12 more headings_

- **[Tlon](https://docs.openclaw.ai/channels/tlon)**
  - Bundled plugin
  - Setup
  - Private/LAN ships
  - Group channels
  - Access control
  - Owner and approval system
  - Auto-accept settings
  - Delivery targets (CLI/cron)
  - Bundled skill
  - Capabilities
    _... and 4 more headings_

- **[Synology Chat](https://docs.openclaw.ai/channels/synology-chat)**
  - Bundled plugin
  - Quick setup
  - Environment variables
  - DM policy and access control
  - Outbound delivery
  - Multi-account
  - Security notes
  - Troubleshooting
  - Related

- **[Twitch](https://docs.openclaw.ai/channels/twitch)**
  - Bundled plugin
  - Quick setup (beginner)
  - What it is
  - Setup (detailed)
    - Generate credentials
    - Configure the bot
    - Access control (recommended)
  - Token refresh (optional)
  - Multi-account support
  - Access control
    _... and 8 more headings_

### Regional platforms

- **[LINE](https://docs.openclaw.ai/channels/line)**
  - Install
  - Setup
  - Configure
  - Access control
  - Message behavior
  - Channel data (rich messages)
  - ACP support
  - Outbound media
  - Troubleshooting
  - Related

- **[WeChat](https://docs.openclaw.ai/channels/wechat)**
  - Naming
  - How it works
  - Install
  - Login
  - Access control
  - Compatibility
  - Sidecar process
  - Troubleshooting
  - Related docs

- **[QQ bot](https://docs.openclaw.ai/channels/qqbot)**
  - Install
  - Setup
  - Configure
    - Multi-account setup
    - Group chats
    - Voice (STT / TTS)
  - Target formats
  - Slash commands
  - Engine architecture
  - QR-code onboarding
    _... and 2 more headings_

- **[Feishu](https://docs.openclaw.ai/channels/feishu)**
  - Quick start
  - Access control
    - Direct messages
    - Group chats
  - Group configuration examples
    - Allow all groups, no @mention required
    - Allow all groups, still require @mention
    - Allow specific groups only
    - Restrict senders within a group
  - Get group/user IDs
    _... and 31 more headings_

- **[Yuanbao](https://docs.openclaw.ai/channels/yuanbao)**
  - Quick start
    - Interactive setup (alternative)
  - Access control
    - Direct messages
    - Group chats
  - Configuration examples
    - Basic setup with open DM policy
    - Restrict DMs to specific users
    - Disable @mention requirement in groups
    - Optimize outbound message delivery
      _... and 22 more headings_

- **[Zalo](https://docs.openclaw.ai/channels/zalo)**
  - Bundled plugin
  - Quick setup (beginner)
  - What it is
  - Setup (fast path)
    - 1. Create a bot token (Zalo Bot Platform)
    - 2. Configure the token (env or config)
  - How it works (behavior)
  - Limits
  - Access control (DMs)
    - DM access
      _... and 8 more headings_

- **[Zalo personal](https://docs.openclaw.ai/channels/zalouser)**
  - Bundled plugin
  - Quick setup (beginner)
  - What it is
  - Naming
  - Finding IDs (directory)
  - Limits
  - Access control (DMs)
  - Group access (optional)
    - Group mention gating
  - Multi-account
    _... and 4 more headings_

### Configuration

- **[Pairing](https://docs.openclaw.ai/channels/pairing)**
  - 1. DM pairing (inbound chat access)
    - Approve a sender
    - Reusable sender groups
    - Where the state lives
  - 2. Node device pairing (iOS/Android/macOS/headless nodes)
    - Pair via Telegram (recommended for iOS)
    - Approve a node device
    - Optional trusted-CIDR node auto-approve
    - Node pairing state storage
    - Notes
      _... and 1 more headings_

- **[Access groups](https://docs.openclaw.ai/channels/access-groups)**
  - Static message sender groups
  - Reference groups from allowlists
  - Supported message-channel paths
  - Plugin diagnostics
  - Discord channel audiences
  - Security notes
  - Troubleshooting

- **[WhatsApp group messages](https://docs.openclaw.ai/channels/group-messages)**
  - Behavior
  - Config example (WhatsApp)
    - Activation command (owner-only)
  - How to use
  - Testing / verification
  - Known considerations
  - Related

- **[Groups](https://docs.openclaw.ai/channels/groups)**
  - Beginner intro (2 minutes)
  - Visible replies
  - Context visibility and allowlists
  - Session keys
  - Pattern: personal DMs + public groups (single agent)
  - Display labels
  - Group policy
  - Mention gating (default)
  - Scope configured mention patterns
  - Group/channel tool restrictions (optional)
    _... and 7 more headings_

- **[Ambient room events](https://docs.openclaw.ai/channels/ambient-room-events)**
  - Recommended setup
  - What changes
  - Discord example
  - Slack example
  - Telegram example
  - Agent specific policy
  - Visible reply modes
  - History
  - Troubleshooting
  - Related

- **[Broadcast groups](https://docs.openclaw.ai/channels/broadcast-groups)**
  - Overview
  - Use cases
  - Configuration
    - Basic setup
    - Processing strategy
    - Complete example
  - How it works
    - Message flow
    - Session isolation
    - Example: isolated sessions
      _... and 12 more headings_

- **[Channel routing](https://docs.openclaw.ai/channels/channel-routing)**
  - Key terms
  - Outbound target prefixes
  - Session key shapes (examples)
  - Main DM route pinning
  - Guarded inbound recording
  - Routing rules (how an agent is chosen)
  - Broadcast groups (run multiple agents)
  - Config overview
  - Session storage
  - WebChat behavior
    _... and 2 more headings_

- **[Channel location parsing](https://docs.openclaw.ai/channels/location)**
  - Text formatting
  - Context fields
  - Channel notes
  - Related

- **[Channel troubleshooting](https://docs.openclaw.ai/channels/troubleshooting)**
  - Command ladder
  - After an update
  - WhatsApp
    - WhatsApp failure signatures
  - Telegram
    - Telegram failure signatures
  - Discord
    - Discord failure signatures
  - Slack
    - Slack failure signatures
      _... and 9 more headings_

- **[QA channel](https://docs.openclaw.ai/channels/qa-channel)**
  - What it does
  - Config
  - Runners
  - Related

## Agents

### Fundamentals

- **[Gateway architecture](https://docs.openclaw.ai/concepts/architecture)**
  - Overview
  - Components and flows
    - Gateway (daemon)
    - Clients (mac app / CLI / web admin)
    - Nodes (macOS / iOS / Android / headless)
    - WebChat
  - Connection lifecycle (single client)
  - Wire protocol (summary)
  - Pairing + local trust
  - Protocol typing and codegen
    _... and 4 more headings_

- **[Agent runtime](https://docs.openclaw.ai/concepts/agent)**
  - Workspace (required)
  - Bootstrap files (injected)
  - Built-in tools
  - Skills
  - Runtime boundaries
  - Sessions
  - Steering while streaming
  - Model refs
  - Configuration (minimal)
  - Related

- **[Agent loop](https://docs.openclaw.ai/concepts/agent-loop)**
  - Entry points
  - How it works (high-level)
  - Queueing + concurrency
  - Session + workspace preparation
  - Prompt assembly + system prompt
  - Hook points (where you can intercept)
    - Internal hooks (Gateway hooks)
    - Plugin hooks (agent + gateway lifecycle)
  - Streaming + partial replies
  - Tool execution + messaging tools
    _... and 7 more headings_

- **[Agent runtimes](https://docs.openclaw.ai/concepts/agent-runtimes)**
  - Codex surfaces
  - Runtime ownership
  - Runtime selection
  - GitHub Copilot agent runtime
  - Compatibility contract
  - Status labels
  - Related

- **[System prompt](https://docs.openclaw.ai/concepts/system-prompt)**
  - Structure
  - Prompt modes
  - Prompt snapshots
  - Workspace bootstrap injection
  - Time handling
  - Skills
  - Documentation
  - Related

- **[Context](https://docs.openclaw.ai/concepts/context)**
  - Quick start (inspect context)
  - Example output
    - `/context list`
    - `/context detail`
    - `/context map`
  - What counts toward the context window
  - How OpenClaw builds the system prompt
  - Injected workspace files (Project Context)
  - Skills: injected vs loaded on-demand
  - Tools: there are two costs
    _... and 4 more headings_

- **[Context engine](https://docs.openclaw.ai/concepts/context-engine)**
  - Quick start
  - How it works
    - Subagent lifecycle (optional)
    - System prompt addition
  - The legacy engine
  - Plugin engines
    - The ContextEngine interface
    - Runtime settings
    - Host requirements
    - Failure isolation
      _... and 5 more headings_

- **[Agent workspace](https://docs.openclaw.ai/concepts/agent-workspace)**
  - Default location
  - Extra workspace folders
  - Workspace file map
  - What is NOT in the workspace
  - Git backup (recommended, private)
  - Do not commit secrets
  - Moving the workspace to a new machine
  - Advanced notes
  - Related

- **[SOUL.md personality guide](https://docs.openclaw.ai/concepts/soul)**
  - What belongs in SOUL.md
  - Why this works
  - The Molty prompt
  - What good looks like
  - One warning
  - Related

- **[OAuth](https://docs.openclaw.ai/concepts/oauth)**
  - The token sink (why it exists)
  - Storage (where tokens live)
  - Anthropic legacy token compatibility
  - Anthropic Claude CLI migration
  - OAuth exchange (how login works)
    - Anthropic setup-token
    - OpenAI Codex (ChatGPT OAuth)
  - Refresh + expiry
  - Multiple accounts (profiles) + routing
    - 1. Preferred: separate agents
         _... and 2 more headings_

- **[Agent bootstrapping](https://docs.openclaw.ai/start/bootstrapping)**
  - What bootstrapping does
  - Skipping bootstrapping
  - Where it runs
  - Related docs

- **[Experimental features](https://docs.openclaw.ai/concepts/experimental-features)**
  - Currently documented flags
  - Local model lean mode
    - Why these three tools
    - When to turn it on
    - When to leave it off
    - Enable
  - Experimental does not mean hidden
  - Related

- **[QA overview](https://docs.openclaw.ai/concepts/qa-e2e-automation)**
  - Command surface
  - Operator flow
  - Live transport coverage
  - Telegram, Discord, Slack, and WhatsApp QA reference
    - Shared CLI flags
    - Telegram QA
    - Discord QA
    - Slack QA
      - Setting up the Slack workspace
    - WhatsApp QA
      _... and 8 more headings_

- **[Personal agent benchmark pack](https://docs.openclaw.ai/concepts/personal-agent-benchmark-pack)**
  - Scenarios
  - Privacy Model
  - Extending The Pack

- **[Matrix QA](https://docs.openclaw.ai/concepts/qa-matrix)**
  - Quick start
  - What the lane does
  - CLI
    - Common flags
    - Provider flags
  - Profiles
  - Scenarios
  - Environment variables
  - Output artifacts
  - Triage tips
    _... and 2 more headings_

### Sessions and memory

#### Memory

- **[Session management](https://docs.openclaw.ai/concepts/session)**
  - How messages are routed
  - DM isolation
    - Dock linked channels
  - Session lifecycle
  - Where state lives
  - Session maintenance
  - Inspecting sessions
  - Further reading
  - Related

- **[Channel docking](https://docs.openclaw.ai/concepts/channel-docking)**
  - Example
  - Why use it
  - Required config
  - Commands
  - What changes
  - What does not change
  - Troubleshooting

- **[Session pruning](https://docs.openclaw.ai/concepts/session-pruning)**
  - Why it matters
  - How it works
  - Legacy image cleanup
  - Smart defaults
  - Enable or disable
  - Pruning vs compaction
  - Further reading
  - Related

- **[Session tools](https://docs.openclaw.ai/concepts/session-tool)**
  - Available tools
  - Listing and reading sessions
  - Sending cross-session messages
  - Status and orchestration helpers
  - Spawning sub-agents
  - Visibility
  - Further reading
  - Related

- **[Memory overview](https://docs.openclaw.ai/concepts/memory)**
  - How it works
  - What goes where
  - Action-sensitive memories
  - Inferred commitments
  - Memory tools
  - Memory Wiki companion plugin
  - Memory search
  - Memory backends
  - Knowledge wiki layer
  - Automatic memory flush
    _... and 5 more headings_

- **[Builtin memory engine](https://docs.openclaw.ai/concepts/memory-builtin)**
  - What it provides
  - Getting started
  - Supported embedding providers
  - How indexing works
  - When to use
  - Troubleshooting
  - Configuration
  - Related

- **[QMD memory engine](https://docs.openclaw.ai/concepts/memory-qmd)**
  - What it adds over builtin
  - Getting started
    - Prerequisites
    - Enable
  - How the sidecar works
  - Search performance and compatibility
  - Model overrides
  - Indexing extra paths
  - Indexing session transcripts
  - Search scope
    _... and 5 more headings_

- **[Honcho memory](https://docs.openclaw.ai/concepts/memory-honcho)**
  - What it provides
  - Available tools
  - Getting started
  - Configuration
  - Migrating existing memory
  - How it works
  - Honcho vs builtin memory
  - CLI commands
  - Further reading
  - Related

- **[Memory search](https://docs.openclaw.ai/concepts/memory-search)**
  - Quick start
  - Supported providers
  - How search works
  - Improving search quality
    - Temporal decay
    - MMR (diversity)
    - Enable both
  - Multimodal memory
  - Session memory search
  - Troubleshooting
    _... and 2 more headings_

- **[Active memory](https://docs.openclaw.ai/concepts/active-memory)**
  - Quick start
  - Speed recommendations
    - Cerebras setup
  - How to see it
  - Session toggle
  - When it runs
  - Session types
  - Where it runs
  - Why use it
  - How it works
    _... and 15 more headings_

- **[Inferred commitments](https://docs.openclaw.ai/concepts/commitments)**
  - Enable commitments
  - How it works
  - Scope
  - Commitments vs reminders
  - Manage commitments
  - Privacy and cost
  - Troubleshooting
  - Related

- **[Dreaming](https://docs.openclaw.ai/concepts/dreaming)**
  - What dreaming writes
  - Phase model
  - Session transcript ingestion
  - Dream Diary
  - Deep ranking signals
  - QA shadow trial report coverage
  - Scheduling
  - Quick start
  - Slash command
  - CLI workflow
    _... and 4 more headings_

- **[Compaction](https://docs.openclaw.ai/concepts/compaction)**
  - How it works
  - Auto-compaction
  - Manual compaction
  - Configuration
    - Using a different model
    - Identifier preservation
    - Active transcript byte guard
    - Successor transcripts
    - Compaction notices
    - Memory flush
      _... and 4 more headings_

### Multi-agent

- **[Multi-agent routing](https://docs.openclaw.ai/concepts/multi-agent)**
  - What is "one agent"?
  - Paths (quick map)
    - Single-agent mode (default)
  - Agent helper
  - Quick start
  - Multiple agents = multiple people, multiple personalities
  - Cross-agent QMD memory search
  - One WhatsApp number, multiple people (DM split)
  - Routing rules (how messages pick an agent)
  - Multiple accounts / phone numbers
    _... and 5 more headings_

- **[Parallel specialist lanes](https://docs.openclaw.ai/concepts/parallel-specialist-lanes)**
  - First principles
  - Recommended rollout
    - Phase 1: lane contracts + background heavy work
    - Phase 2: priority and concurrency controls
    - Phase 3: coordinator / traffic controller
  - Minimal lane contract template
  - Owns
  - Does not own
  - Chat budget
  - Handoff
    _... and 2 more headings_

- **[Presence](https://docs.openclaw.ai/concepts/presence)**
  - Presence fields (what shows up)
  - Producers (where presence comes from)
    - 1. Gateway self entry
    - 2. WebSocket connect
      - Why one-off CLI commands do not show up
    - 3. `system-event` beacons
    - 4. Node connects (role: node)
  - Merge + dedupe rules (why `instanceId` matters)
  - TTL and bounded size
  - Remote/tunnel caveat (loopback IPs)
    _... and 4 more headings_

- **[Delegate architecture](https://docs.openclaw.ai/concepts/delegate-architecture)**
  - What is a delegate?
  - Why delegates?
  - Capability tiers
    - Tier 1: Read-Only + Draft
    - Tier 2: Send on Behalf
    - Tier 3: Proactive
  - Prerequisites: isolation and hardening
    - Hard blocks (non-negotiable)
    - Tool restrictions
    - Sandbox isolation
      _... and 11 more headings_

### Messages and delivery

- **[Messages](https://docs.openclaw.ai/concepts/messages)**
  - Message flow (high level)
  - Inbound dedupe
  - Inbound debouncing
  - Sessions and devices
  - Tool result metadata
  - Inbound bodies and history context
  - Queueing and followups
  - Channel run ownership
  - Streaming, chunking, and batching
  - Reasoning visibility and tokens
    _... and 3 more headings_

- **[Message lifecycle refactor](https://docs.openclaw.ai/concepts/message-lifecycle-refactor)**
  - Problems
  - Goals
  - Non goals
  - Reference model
  - Core model
  - Message terms
    - Message
    - Target
    - Relation
    - Origin
      _... and 24 more headings_

- **[Streaming and chunking](https://docs.openclaw.ai/concepts/streaming)**
  - Block streaming (channel messages)
    - Media delivery with block streaming
  - Chunking algorithm (low/high bounds)
  - Coalescing (merge streamed blocks)
  - Human-like pacing between blocks
  - "Stream chunks or everything"
  - Preview streaming modes
    - Channel mapping
    - Runtime behavior
    - Tool-progress preview updates
      _... and 1 more headings_

- **[Progress drafts](https://docs.openclaw.ai/concepts/progress-drafts)**
  - Quick start
  - What users see
  - Choose a mode
  - Configure labels
  - Control progress lines
  - Channel behavior
  - Finalization
  - Troubleshooting
  - Related

- **[Retry policy](https://docs.openclaw.ai/concepts/retry)**
  - Goals
  - Defaults
  - Behavior
    - Model providers
    - Discord
    - Telegram
  - Configuration
  - Notes
  - Related

- **[Command queue](https://docs.openclaw.ai/concepts/queue)**
  - Why
  - How it works
  - Defaults
  - Queue modes
  - Queue options
  - Steer and streaming
  - Precedence
  - Per-session overrides
  - Scope and guarantees
  - Troubleshooting
    _... and 1 more headings_

- **[Steering queue](https://docs.openclaw.ai/concepts/queue-steering)**
  - Runtime boundary
  - Modes
  - Burst example
  - Scope
  - Debounce
  - Related

## Capabilities

### Overview

- **[Overview](https://docs.openclaw.ai/tools/index)**
  - Start here
  - Choose tools, skills, or plugins
  - Built-in tool categories
  - Plugin-provided tools
  - Configure access and approvals
  - Extend capabilities
  - Troubleshoot missing tools
  - Related

### Plugins

- **[Plugins](https://docs.openclaw.ai/tools/plugin)**
  - Requirements
  - Quick start
  - Configuration
    - Choose an install source
    - Operator install policy
    - Configure plugin policy
  - Understand plugin formats
  - Plugin hooks
  - Verify the active Gateway
  - Troubleshooting
    _... and 3 more headings_

- **[Manage plugins](https://docs.openclaw.ai/plugins/manage-plugins)**
  - List and search plugins
  - Install plugins
  - Restart and inspect
  - Update plugins
  - Uninstall plugins
  - Choose a source
  - Publish plugins
  - Related

- **[Community plugins](https://docs.openclaw.ai/plugins/community)**
  - Find plugins
  - Publish plugins
  - Related

- **[Plugin bundles](https://docs.openclaw.ai/plugins/bundles)**
  - Why bundles exist
  - Install a bundle
  - What OpenClaw maps from bundles
    - Supported now
      - Skill content
      - Hook packs
      - MCP for embedded OpenClaw
      - Embedded OpenClaw settings
      - Embedded OpenClaw LSP
    - Detected but not executed
      _... and 6 more headings_

### Bundled plugin guides

- **[Codex harness](https://docs.openclaw.ai/plugins/codex-harness)**
  - Requirements
  - Quickstart
  - Configuration
  - Verify Codex runtime
  - Routing and model selection
  - Deployment patterns
    - Basic Codex deployment
    - Mixed provider deployment
    - Fail-closed Codex deployment
  - App-server policy
    _... and 7 more headings_

- **[Native Codex plugins](https://docs.openclaw.ai/plugins/codex-native-plugins)**
  - Requirements
  - Quickstart
  - Manage plugins from chat
  - How native plugin setup works
  - V1 support boundary
  - App inventory and ownership
  - Thread app config
  - Destructive action policy
  - Troubleshooting
  - Related

- **[Codex Computer Use](https://docs.openclaw.ai/plugins/codex-computer-use)**
  - OpenClaw.app and Peekaboo
  - iOS app
  - Direct cua-driver MCP
  - Quick setup
  - Commands
  - Marketplace choices
  - Bundled macOS marketplace
  - Remote catalog limit
  - Configuration reference
  - What OpenClaw checks
    _... and 3 more headings_

- **[Google Meet plugin](https://docs.openclaw.ai/plugins/google-meet)**
  - Quick start
    - Local gateway + Parallels Chrome
  - Install notes
  - Transports
    - Chrome
    - Twilio
  - OAuth and preflight
    - Create Google credentials
    - Mint the refresh token
    - Verify OAuth with doctor
      _... and 14 more headings_

- **[Workboard plugin](https://docs.openclaw.ai/plugins/workboard)**
  - Default state
  - What cards contain
  - Card executions and tasks
  - Agent coordination
    - Dispatch worker selection
    - Worker prompt and lifecycle
    - Dispatch entry points
  - CLI and slash command
  - Session lifecycle sync
  - Dashboard workflow
    _... and 8 more headings_

- **[Webhooks plugin](https://docs.openclaw.ai/plugins/webhooks)**
  - Where it runs
  - Configure routes
  - Security model
  - Request format
  - Supported actions
    - `create_flow`
    - `run_task`
  - Response shape
  - Related docs

- **[Admin HTTP RPC plugin](https://docs.openclaw.ai/plugins/admin-http-rpc)**
  - Before you enable it
  - Enable
  - Verify the route
  - Authentication
  - Security model
  - Request
  - Response
  - Allowed methods
  - WebSocket comparison
  - Troubleshooting
    _... and 1 more headings_

- **[Voice call plugin](https://docs.openclaw.ai/plugins/voice-call)**
  - Quick start
  - Configuration
  - Session scope
  - Realtime voice conversations
    - Tool policy
    - Agent voice context
    - Realtime provider examples
  - Streaming transcription
    - Streaming provider examples
  - TTS for calls
    _... and 19 more headings_

- **[Memory wiki](https://docs.openclaw.ai/plugins/memory-wiki)**
  - What it adds
  - How it fits with memory
  - Recommended hybrid pattern
  - Vault modes
    - `isolated`
    - `bridge`
    - `unsafe-local`
  - Vault layout
  - Open Knowledge Format imports
  - Structured claims and evidence
    _... and 12 more headings_

- **[llama.cpp Provider](https://docs.openclaw.ai/plugins/llama-cpp)**
  - Configuration
  - Native Runtime

- **[Memory LanceDB](https://docs.openclaw.ai/plugins/memory-lancedb)**
  - Installation
  - Quick start
  - Provider-backed embeddings
  - Ollama embeddings
  - OpenAI-compatible providers
  - Recall and capture limits
  - Commands
  - Storage
  - Runtime dependencies
  - Troubleshooting
    _... and 4 more headings_

- **[OC Path plugin](https://docs.openclaw.ai/plugins/oc-path)**
  - Why enable it
  - Where it runs
  - Enable
  - Dependencies
  - What it provides
  - Relationship to other plugins
  - Safety
  - Related

- **[Zalo personal plugin](https://docs.openclaw.ai/plugins/zalouser)**
  - Naming
  - Where it runs
  - Install
    - Option A: install from npm
    - Option B: install from a local folder (dev)
  - Config
  - CLI
  - Agent tool
  - Related

### Building plugins

- **[Building plugins](https://docs.openclaw.ai/plugins/building-plugins)**
  - Requirements
  - Choose the plugin shape
  - Quickstart
  - Registering tools
  - Import conventions
  - Pre-submission checklist
  - Test against beta releases
  - Next steps
  - Related

- **[Tool plugins](https://docs.openclaw.ai/plugins/tool-plugins)**
  - Requirements
  - Quickstart
  - Write a tool
  - Optional and factory tools
  - Return values
  - Configuration
  - Generated metadata
  - Package metadata
  - Validate in CI
  - Install and inspect locally
    _... and 9 more headings_

- **[Building channel plugins](https://docs.openclaw.ai/plugins/sdk-channel-plugins)**
  - How channel plugins work
  - Approvals and channel capabilities
  - Inbound mention policy
  - Walkthrough
  - File structure
  - Advanced topics
  - Next steps
  - Related

- **[Building provider plugins](https://docs.openclaw.ai/plugins/sdk-provider-plugins)**
  - Walkthrough
  - Publish to ClawHub
  - File structure
  - Catalog order reference
  - Next steps
  - Related

- **[Building CLI backend plugins](https://docs.openclaw.ai/plugins/cli-backend-plugins)**
  - What the plugin owns
  - Minimal backend plugin
  - Config shape
  - Advanced backend hooks
    - `ownsNativeCompaction`: opting out of OpenClaw compaction
  - MCP tool bridge
  - User configuration
  - Verification
  - Checklist
  - Related

- **[Plugin hooks](https://docs.openclaw.ai/plugins/hooks)**
  - Quick start
  - Hook catalog
  - Debug runtime hooks
  - Tool call policy
    - Exec environment hook
    - Tool result persistence
  - Prompt and model hooks
    - Session extensions and next-turn injections
  - Message hooks
  - Install hooks
    _... and 3 more headings_

- **[Plugin permission requests](https://docs.openclaw.ai/plugins/plugin-permission-requests)**
  - Choose the right gate
  - Request approval before a tool call
  - Decision behavior
  - Route approval prompts
  - Codex native permissions
  - Troubleshooting
  - Related

- **[Adding capabilities (contributor guide)](https://docs.openclaw.ai/plugins/adding-capabilities)**
  - When to create a capability
  - The standard sequence
  - What goes where
  - Provider and harness seams
  - File checklist
  - Worked example: image generation
  - Embedding providers
  - Review checklist
  - Related

### Skills

- **[Skills](https://docs.openclaw.ai/tools/skills)**
  - Loading order
  - Per-agent vs shared skills
  - Agent allowlists
  - Plugins and skills
  - Skill Workshop
  - Installing from ClawHub
  - Security
  - SKILL.md format
    - Optional frontmatter keys
  - Gating
    _... and 6 more headings_

- **[Skill Workshop](https://docs.openclaw.ai/tools/skill-workshop)**
  - How it works
  - Lifecycle
  - Chat
  - CLI
  - Proposal content
  - Support files
  - Agent tool
  - Approval and autonomy
  - Gateway methods
  - Storage
    _... and 3 more headings_

- **[Creating skills](https://docs.openclaw.ai/tools/creating-skills)**
  - Create your first skill
  - SKILL.md reference
    - Required fields
    - Optional frontmatter keys
    - Using `{baseDir}`
  - Adding conditional activation
  - Propose via Skill Workshop
  - Publishing to ClawHub
  - Best practices
  - Related

- **[Skills config](https://docs.openclaw.ai/tools/skills-config)**
  - Loading (`skills.load`)
  - Install (`skills.install`)
  - Operator Install Policy (`security.installPolicy`)
  - Bundled skill allowlist
  - Per-skill entries (`skills.entries`)
  - Agent allowlists (`agents`)
  - Workshop (`skills.workshop`)
  - Symlinked skill roots
  - Sandboxed skills and env vars
  - Loading order reminder
    _... and 1 more headings_

- **[Slash commands](https://docs.openclaw.ai/tools/slash-commands)**
  - Three command types
  - Configuration
  - Command list
    - Core commands
    - Dock commands
    - Bundled plugin commands
    - Skill commands
  - `/tools` — what the agent can use now
  - `/model` — model selection
  - `/config` — on-disk config writes
    _... and 8 more headings_

- **[OpenProse](https://docs.openclaw.ai/prose)**
  - Install
  - Slash command
  - What it can do
  - Example: parallel research and synthesis
  - OpenClaw runtime mapping
  - File locations
  - State backends
  - Security
  - Related

### Automation

- **[Automation](https://docs.openclaw.ai/automation/index)**
  - Quick decision guide
    - Scheduled Tasks (Cron) vs Heartbeat
  - Core concepts
    - Scheduled tasks (cron)
    - Tasks
    - Inferred commitments
    - Task Flow
    - Standing orders
    - Hooks
    - Heartbeat
      _... and 2 more headings_

- **[Scheduled tasks](https://docs.openclaw.ai/automation/cron-jobs)**
  - Quick start
  - How cron works
  - Schedule types
    - Day-of-month and day-of-week use OR logic
  - Execution styles
    - Command payloads
    - Payload options for isolated jobs
  - Delivery and output
  - Output language
  - CLI examples
    _... and 12 more headings_

- **[Background tasks](https://docs.openclaw.ai/automation/tasks)**
  - TL;DR
  - Quick start
  - What creates a task
  - Task lifecycle
  - Delivery and notifications
    - Notification policies
  - CLI reference
  - Chat task board (`/tasks`)
  - Status integration (task pressure)
  - Storage and maintenance
    _... and 4 more headings_

- **[Task flow](https://docs.openclaw.ai/automation/taskflow)**
  - When to use Task Flow
  - Reliable scheduled workflow pattern
  - Sync modes
    - Managed mode
    - Mirrored mode
  - Durable state and revision tracking
  - Cancel behavior
  - CLI commands
  - How flows relate to tasks
  - Related

- **[Standing orders](https://docs.openclaw.ai/automation/standing-orders)**
  - Why standing orders
  - How they work
  - Anatomy of a standing order
  - Program: Weekly Status Report
    - Execution steps
    - What NOT to do
  - Standing orders plus cron jobs
  - Examples
    - Example 1: content and social media (weekly cycle)
  - Program: Content & Social Media
    _... and 21 more headings_

- **[Hooks](https://docs.openclaw.ai/automation/hooks)**
  - Choose the right surface
  - Quick start
  - Event types
  - Writing hooks
    - Hook structure
    - HOOK.md format
    - Handler implementation
    - Event context highlights
  - Hook discovery
    - Hook packs
      _... and 15 more headings_

### Tools

#### Web browser

#### Web tools

- **[apply_patch tool](https://docs.openclaw.ai/tools/apply-patch)**
  - Parameters
  - Notes
  - Example
  - Related

- **[BTW side questions](https://docs.openclaw.ai/tools/btw)**
  - What it does
  - What it does not do
  - How context works
  - Delivery model
  - Surface behavior
    - TUI
    - External channels
    - Control UI / web
  - When to use BTW
  - When not to use BTW
    _... and 1 more headings_

- **[Code execution](https://docs.openclaw.ai/tools/code-execution)**
  - Setup
  - How to use it
  - Errors
  - Limits
  - Related

- **[Diffs](https://docs.openclaw.ai/tools/diffs)**
  - Quick start
  - Disable built-in system guidance
  - Typical agent workflow
  - Input examples
  - Tool input reference
  - Syntax highlighting
  - Output details contract
  - Collapsed unchanged sections
  - Plugin defaults
    - Persistent viewer URL config
      _... and 8 more headings_

- **[Elevated mode](https://docs.openclaw.ai/tools/elevated)**
  - Directives
  - How it works
  - Resolution order
  - Availability and allowlists
  - What elevated does not control
  - Related

- **[Permission modes](https://docs.openclaw.ai/tools/permission-modes)**
  - Recommended default
  - OpenClaw host exec modes
  - Codex Guardian mapping
  - ACPX harness permissions
  - Choosing a mode
  - Related

- **[Exec approvals](https://docs.openclaw.ai/tools/exec-approvals)**
  - Inspecting the effective policy
  - Where it applies
    - Trust model
    - macOS split
  - Settings and storage
  - Policy knobs
    - `tools.exec.mode`
    - `exec.security`
    - `exec.ask`
    - `askFallback`
      _... and 17 more headings_

- **[Exec approvals — advanced](https://docs.openclaw.ai/tools/exec-approvals-advanced)**
  - Safe bins (stdin-only)
    - Argv validation and denied flags
    - Trusted binary directories
    - Shell chaining, wrappers, and multiplexers
    - Safe bins versus allowlist
  - Interpreter/runtime commands
    - Followup delivery behavior
  - Approval forwarding to chat channels
    - Plugin approval forwarding
    - Same-chat approvals on any channel
      _... and 6 more headings_

- **[Exec tool](https://docs.openclaw.ai/tools/exec)**
  - Parameters
  - Config
    - PATH handling
  - Session overrides (`/exec`)
  - Authorization model
  - Exec approvals (companion app / node host)
  - Allowlist + safe bins
  - Examples
  - apply_patch
  - Related

- **[Image generation](https://docs.openclaw.ai/tools/image-generation)**
  - Quick start
  - Common routes
  - Supported providers
  - Provider capabilities
  - Tool parameters
  - Configuration
    - Model selection
    - Provider selection order
    - Image editing
  - Provider deep dives
    _... and 2 more headings_

- **[LLM task](https://docs.openclaw.ai/tools/llm-task)**
  - Enable the plugin
  - Config (optional)
  - Tool parameters
  - Output
  - Example: Lobster workflow step
    - Important limitation
  - Safety notes
  - Related

- **[Lobster](https://docs.openclaw.ai/tools/lobster)**
  - Hook
  - Why
  - Why a DSL instead of plain programs?
  - How it works
  - Pattern: small CLI + JSON pipes + approvals
  - JSON-only LLM steps (llm-task)
    - Important limitation: embedded Lobster vs `openclaw.invoke`
  - Workflow files (.lobster)
  - Install Lobster
  - Enable the tool
    _... and 13 more headings_

- **[Media overview](https://docs.openclaw.ai/tools/media-overview)**
  - Capabilities
  - Provider capability matrix
  - Async vs synchronous
  - Speech-to-text and Voice Call
  - Provider mappings (how vendors split across surfaces)
  - Related

- **[Music generation](https://docs.openclaw.ai/tools/music-generation)**
  - Quick start
  - Supported providers
    - Capability matrix
  - Tool parameters
  - Async behavior
    - Task lifecycle
  - Configuration
    - Model selection
    - Provider selection order
  - Provider notes
    _... and 4 more headings_

- **[PDF tool](https://docs.openclaw.ai/tools/pdf)**
  - Availability
  - Input reference
  - Supported PDF references
  - Execution modes
    - Native provider mode
    - Extraction fallback mode
  - Config
  - Output details
  - Error behavior
  - Examples
    _... and 1 more headings_

- **[Reactions](https://docs.openclaw.ai/tools/reactions)**
  - How it works
  - Channel behavior
  - Reaction level
  - Related

- **[Thinking levels](https://docs.openclaw.ai/tools/thinking)**
  - What it does
  - Resolution order
  - Setting a session default
  - Application by agent
  - Fast mode (/fast)
  - Verbose directives (/verbose or /v)
  - Plugin trace directives (/trace)
  - Reasoning visibility (/reasoning)
  - Related
  - Heartbeats
    _... and 2 more headings_

- **[Tokenjuice](https://docs.openclaw.ai/tools/tokenjuice)**
  - Enable the plugin
  - What tokenjuice changes
  - Verify it is working
  - Disable the plugin
  - Related

- **[Tool Search](https://docs.openclaw.ai/tools/tool-search)**
  - How a turn runs
  - Modes
  - Why this exists
  - API
  - Runtime boundary
  - Config
  - Prompt and telemetry
  - E2E validation
  - Failure behavior
  - Related

- **[Tool-loop detection](https://docs.openclaw.ai/tools/loop-detection)**
  - Why this exists
  - Configuration block
    - Field behavior
  - Recommended setup
  - Post-compaction guard
  - Logs and expected behavior
  - Related

- **[Trajectory bundles](https://docs.openclaw.ai/tools/trajectory)**
  - Quick start
  - Access
  - What gets recorded
  - Bundle files
  - Capture location
  - Disable capture
  - Tune flush timeout
  - Privacy and limits
  - Troubleshooting
  - Related

- **[Text-to-speech](https://docs.openclaw.ai/tools/tts)**
  - Quick start
  - Supported providers
  - Configuration
    - Per-agent voice overrides
  - Personas
    - Minimal persona
    - Full persona (provider-neutral prompt)
    - Persona resolution
    - How providers use persona prompts
    - Fallback policy
      _... and 11 more headings_

- **[Video generation](https://docs.openclaw.ai/tools/video-generation)**
  - Quick start
  - How async generation works
    - Task lifecycle
  - Supported providers
    - Capability matrix
  - Tool parameters
    - Required
    - Content inputs
    - Style controls
    - Advanced
      _... and 8 more headings_

- **[Browser (OpenClaw-managed)](https://docs.openclaw.ai/tools/browser)**
  - What you get
  - Quick start
  - Plugin control
  - Agent guidance
  - Missing browser command or tool
  - Profiles: `openclaw` vs `user`
  - Configuration
    - Screenshot vision (text-only model support)
  - Use Brave or another Chromium-based browser
  - Local vs remote control
    _... and 17 more headings_

- **[Browser control API](https://docs.openclaw.ai/tools/browser-control)**
  - Control API (optional)
    - `/act` error contract
    - Playwright requirement
      - Docker Playwright install
  - How it works (internal)
  - CLI quick reference
  - Snapshots and refs
  - Wait power-ups
  - Debug workflows
  - JSON output
    _... and 3 more headings_

- **[Browser login](https://docs.openclaw.ai/tools/browser-login)**
  - Manual login (recommended)
  - Which Chrome profile is used?
  - X/Twitter: recommended flow
  - Sandboxing + host browser access
  - Related

- **[Browser troubleshooting](https://docs.openclaw.ai/tools/browser-linux-troubleshooting)**
  - Problem: "Failed to start Chrome CDP on port 18800"
    - Root cause
    - Solution 1: Install Google Chrome (Recommended)
    - Solution 2: Use Snap Chromium with Attach-Only Mode
    - Verifying the Browser Works
    - Config reference
    - Problem: "No Chrome tabs found for profile=\"user\""
  - Related

- **[WSL2 + Windows + remote Chrome CDP troubleshooting](https://docs.openclaw.ai/tools/browser-wsl2-windows-remote-cdp-troubleshooting)**
  - Choose the right browser mode first
    - Option 1: Raw remote CDP from WSL2 to Windows
    - Option 2: Host-local Chrome MCP
  - Working architecture
  - Why this setup is confusing
  - Critical rule for the Control UI
  - Validate in layers
    - Layer 1: Verify Chrome is serving CDP on Windows
    - Layer 2: Verify WSL2 can reach that Windows endpoint
    - Layer 3: Configure the correct browser profile
      _... and 6 more headings_

- **[Web fetch](https://docs.openclaw.ai/tools/web-fetch)**
  - Quick start
  - Tool parameters
  - How it works
  - Progress updates
  - Config
  - Firecrawl fallback
  - Trusted env proxy
  - Limits and safety
  - Tool profiles
  - Related

- **[Web search](https://docs.openclaw.ai/tools/web)**
  - Quick start
  - Choosing a provider
    - Provider comparison
  - Auto-detection
  - Native OpenAI web search
  - Native Codex web search
  - Network safety
  - Setting up web search
  - Config
    - Storing API keys
      _... and 8 more headings_

- **[Brave search](https://docs.openclaw.ai/tools/brave-search)**
  - Get an API key
  - Config example
  - Tool parameters
  - Notes
  - Related

- **[DuckDuckGo search](https://docs.openclaw.ai/tools/duckduckgo-search)**
  - Setup
  - Config
  - Tool parameters
  - Notes
  - Related

- **[Exa search](https://docs.openclaw.ai/tools/exa-search)**
  - Get an API key
  - Config
  - Base URL override
  - Tool parameters
    - Content extraction
    - Search modes
  - Notes
  - Related

- **[Firecrawl](https://docs.openclaw.ai/tools/firecrawl)**
  - Get an API key
  - Configure Firecrawl search
  - Configure Firecrawl scrape + web_fetch fallback
    - Self-hosted Firecrawl
  - Firecrawl plugin tools
    - `firecrawl_search`
    - `firecrawl_scrape`
  - Stealth / bot circumvention
  - How `web_fetch` uses Firecrawl
  - Related

- **[Gemini search](https://docs.openclaw.ai/tools/gemini-search)**
  - Get an API key
  - Config
  - How it works
  - Supported parameters
  - Model selection
  - Base URL overrides
  - Related

- **[Grok search](https://docs.openclaw.ai/tools/grok-search)**
  - Onboarding and configure
  - Sign in or get an API key
  - Config
  - How it works
  - Supported parameters
  - Base URL overrides
  - Related

- **[Kimi search](https://docs.openclaw.ai/tools/kimi-search)**
  - Get an API key
  - Config
  - How it works
  - Supported parameters
  - Related

- **[MiniMax search](https://docs.openclaw.ai/tools/minimax-search)**
  - Get a Token Plan credential
  - Config
  - Region selection
  - Supported parameters
  - Related

- **[Ollama web search](https://docs.openclaw.ai/tools/ollama-search)**
  - Setup
  - Config
  - Notes
  - Related

- **[Parallel search](https://docs.openclaw.ai/tools/parallel-search)**
  - API key (paid provider)
  - Config
  - Base URL override
  - Tool parameters
  - Notes
  - Related

- **[Perplexity search](https://docs.openclaw.ai/tools/perplexity-search)**
  - Getting a Perplexity API key
  - OpenRouter compatibility
  - Config examples
    - Native Perplexity Search API
    - OpenRouter / Sonar compatibility
  - Where to set the key
  - Tool parameters
    - Domain filter rules
  - Notes
  - Related

- **[SearXNG search](https://docs.openclaw.ai/tools/searxng-search)**
  - Setup
  - Config
  - Environment variable
  - Plugin config reference
  - Notes
  - Related

- **[Tavily](https://docs.openclaw.ai/tools/tavily)**
  - Getting started
  - Tool reference
    - `tavily_search`
    - `tavily_extract`
  - Choosing the right tool
  - Advanced configuration
  - Related

### Agent coordination

- **[Agent send](https://docs.openclaw.ai/tools/agent-send)**
  - Quick start
  - Flags
  - Behavior
  - Examples
  - Related

- **[Goal](https://docs.openclaw.ai/tools/goal)**
  - Quick start
  - What goals are for
  - Command reference
  - Statuses
  - Token budgets
  - Model tools
  - TUI
  - Channel behavior
  - Troubleshooting
  - Related

- **[Steer](https://docs.openclaw.ai/tools/steer)**
  - Current session
  - Steer vs queue
  - Sub-agents
  - ACP sessions
  - Related

- **[Sub-agents](https://docs.openclaw.ai/tools/subagents)**
  - Slash command
    - Thread binding controls
    - Spawn behavior
  - Context modes
  - Tool: `sessions_spawn`
    - Delegation prompt mode
    - Tool parameters
    - Task names and targeting
  - Tool: `sessions_yield`
  - Tool: `subagents`
    _... and 26 more headings_

- **[ACP agents](https://docs.openclaw.ai/tools/acp-agents)**
  - Which page do I want?
  - Does this work out of the box?
  - Supported harness targets
  - Operator runbook
  - ACP versus sub-agents
  - How ACP runs Claude Code
  - Bound sessions
    - Mental model
    - Current-conversation binds
  - Persistent channel bindings
    _... and 15 more headings_

- **[ACP agents — setup](https://docs.openclaw.ai/tools/acp-agents-setup)**
  - acpx harness support (current)
  - Required config
  - Plugin setup for acpx backend
    - acpx command and version configuration
    - Automatic dependency install
    - Plugin tools MCP bridge
    - OpenClaw tools MCP bridge
    - Runtime operation timeout configuration
    - Health probe agent configuration
  - Permission configuration
    _... and 4 more headings_

- **[Multi-agent sandbox and tools](https://docs.openclaw.ai/tools/multi-agent-sandbox-tools)**
  - Configuration examples
  - Configuration precedence
    - Sandbox config
    - Tool restrictions
  - Migration from single agent
  - Tool restriction examples
  - Common pitfall: "non-main"
  - Testing
  - Troubleshooting
  - Related

## ClawHub

### Overview

- **clawhub/index**
- **clawhub/quickstart**
- **clawhub/how-it-works**

### Using ClawHub

- **[ClawHub CLI](https://docs.openclaw.ai/clawhub/cli)**
  - Discover and install
  - Publish and maintain
  - Related

- **[Publishing on ClawHub](https://docs.openclaw.ai/clawhub/publishing)**
  - Owners
  - Skills
  - Plugins
  - Release Flow
  - FAQ
    - Package scope must match selected owner

- **clawhub/skill-format**
- **clawhub/auth**
- **clawhub/telemetry**
- **clawhub/troubleshooting**

### API and trust

- **clawhub/api**
- **clawhub/http-api**
- **clawhub/acceptable-usage**
- **clawhub/moderation**
- **clawhub/namespace-claims**
- **clawhub/security**
- **clawhub/security-audits**
- **clawhub/content-rights**
- **clawhub/plugin-validation-fixes**

## Models

### Overview

- **[Provider directory](https://docs.openclaw.ai/providers/index)**
  - Quick start
  - Provider docs
  - Shared overview pages
  - Transcription providers
  - Community tools

- **[Model provider quickstart](https://docs.openclaw.ai/providers/models)**
  - Quick start (two steps)
  - Supported providers (starter set)
  - Additional provider variants
  - Related

### Concepts and configuration

- **[Models CLI](https://docs.openclaw.ai/concepts/models)**
  - How model selection works
  - Selection source and fallback behavior
  - Quick model policy
  - Onboarding (recommended)
  - Config keys (overview)
    - Safe allowlist edits
  - "Model is not allowed" (and why replies stop)
  - Switching models in chat (`/model`)
  - CLI commands
    - `models list`
      _... and 4 more headings_

- **[Model providers](https://docs.openclaw.ai/concepts/model-providers)**
  - Quick rules
  - Plugin-owned provider behavior
  - API key rotation
  - Official provider plugins
    - OpenAI
    - Anthropic
    - OpenAI ChatGPT/Codex OAuth
    - Other subscription-style hosted options
    - OpenCode
    - Google Gemini (API key)
      _... and 20 more headings_

- **[Model failover](https://docs.openclaw.ai/concepts/model-failover)**
  - Runtime flow
  - Selection source policy
  - Auth failure skip cache
  - User-visible fallback notices
  - Auth storage (keys + OAuth)
  - Profile IDs
  - Rotation order
    - Session stickiness (cache-friendly)
    - OpenAI Codex subscription plus API-key backup
  - Cooldowns
    _... and 8 more headings_

### Providers

- **[Alibaba Model Studio](https://docs.openclaw.ai/providers/alibaba)**
  - Getting started
  - Built-in Wan models
  - Capabilities and limits
  - Advanced configuration
  - Related

- **[Amazon Bedrock](https://docs.openclaw.ai/providers/bedrock)**
  - Getting started
  - Automatic model discovery
  - Quick setup (AWS path)
  - Advanced configuration
  - Related

- **[Amazon Bedrock Mantle](https://docs.openclaw.ai/providers/bedrock-mantle)**
  - Getting started
  - Automatic model discovery
    - Supported regions
  - Manual configuration
  - Advanced configuration
  - Related

- **[Anthropic](https://docs.openclaw.ai/providers/anthropic)**
  - Getting started
  - Thinking defaults (Claude Fable 5, 4.8, and 4.6)
  - Prompt caching
  - Advanced configuration
  - Troubleshooting
  - Related

- **[Arcee AI](https://docs.openclaw.ai/providers/arcee)**
  - Getting started
  - Non-interactive setup
  - Built-in catalog
  - Supported features
  - Related

- **[Azure Speech](https://docs.openclaw.ai/providers/azure-speech)**
  - Getting started
  - Configuration options
  - Notes
  - Related

- **[Cerebras](https://docs.openclaw.ai/providers/cerebras)**
  - Getting started
  - Non-interactive setup
  - Built-in catalog
  - Manual config
  - Related

- **[Chutes](https://docs.openclaw.ai/providers/chutes)**
  - Getting started
  - Discovery behavior
  - Default aliases
  - Built-in starter catalog
  - Config example
  - Related

- **[Cohere](https://docs.openclaw.ai/providers/cohere)**
  - Get started
  - Environment-only setup
  - Related

- **[Claude Max API proxy](https://docs.openclaw.ai/providers/claude-max-api-proxy)**
  - Why use this?
  - How it works
  - Getting started
  - Built-in catalog
  - Advanced configuration
  - Notes
  - Related

- **[Cloudflare AI gateway](https://docs.openclaw.ai/providers/cloudflare-ai-gateway)**
  - Getting started
  - Non-interactive example
  - Advanced configuration
  - Related

- **[ComfyUI](https://docs.openclaw.ai/providers/comfy)**
  - What it supports
  - Getting started
  - Configuration
    - Shared keys
    - Per-capability keys
  - Workflow details
  - Related

- **[Deepgram](https://docs.openclaw.ai/providers/deepgram)**
  - Getting started
  - Configuration options
  - Voice Call streaming STT
  - Notes
  - Related

- **[DeepInfra](https://docs.openclaw.ai/providers/deepinfra)**
  - Getting an API key
  - CLI setup
  - Config snippet
  - Supported OpenClaw surfaces
  - Available models
  - Notes
  - Related

- **[DeepSeek](https://docs.openclaw.ai/providers/deepseek)**
  - Getting started
  - Built-in catalog
  - Thinking and tools
  - Live testing
  - Config example
  - Related

- **[ds4](https://docs.openclaw.ai/providers/ds4)**
  - Requirements
  - Quickstart
  - Full config
  - On-demand startup
  - Think Max
  - Test
  - Troubleshooting
  - Related

- **[ElevenLabs](https://docs.openclaw.ai/providers/elevenlabs)**
  - Authentication
  - Text-to-speech
  - Speech-to-text
  - Streaming STT
  - Related

- **[Fal](https://docs.openclaw.ai/providers/fal)**
  - Getting started
  - Image generation
  - Video generation
  - Music generation
  - Related

- **[Fireworks](https://docs.openclaw.ai/providers/fireworks)**
  - Getting started
  - Non-interactive setup
  - Built-in catalog
  - Custom Fireworks model ids
  - Related

- **[GitHub Copilot](https://docs.openclaw.ai/providers/github-copilot)**
  - Three ways to use Copilot in OpenClaw
  - Optional flags
  - Non-interactive onboarding
  - Memory search embeddings
    - Config
    - How it works
  - Related

- **[GMI Cloud](https://docs.openclaw.ai/providers/gmi)**
  - Setup
  - Defaults
  - When to choose GMI
  - Models
  - Troubleshooting
  - Related

- **[Google (Gemini)](https://docs.openclaw.ai/providers/google)**
  - Getting started
  - Capabilities
  - Web search
  - Image generation
  - Video generation
  - Music generation
  - Text-to-speech
  - Realtime voice
  - Advanced configuration
  - Related

- **[Gradium](https://docs.openclaw.ai/providers/gradium)**
  - Setup
  - Config
  - Voices
    - Per-message voice override
  - Output
  - Auto-select order
  - Related

- **[Groq](https://docs.openclaw.ai/providers/groq)**
  - Getting started
    - Config file example
  - Built-in catalog
  - Reasoning models
  - Audio transcription
  - Related

- **[Hugging Face (inference)](https://docs.openclaw.ai/providers/huggingface)**
  - Getting started
    - Non-interactive setup
  - Model IDs
  - Advanced configuration
  - Related

- **[Inferrs](https://docs.openclaw.ai/providers/inferrs)**
  - Getting started
  - Full config example
  - On-demand startup
  - Advanced configuration
  - Troubleshooting
  - Related

- **[Inworld](https://docs.openclaw.ai/providers/inworld)**
  - Getting started
  - Configuration options
  - Notes
  - Related

- **[Kilo Gateway](https://docs.openclaw.ai/providers/kilocode)**
  - Getting started
  - Default model
  - Built-in catalog
  - Config example
  - Related

- **[LiteLLM](https://docs.openclaw.ai/providers/litellm)**
  - Quick start
  - Configuration
    - Environment variables
    - Config file
  - Advanced configuration
    - Image generation
  - Related

- **[LM Studio](https://docs.openclaw.ai/providers/lmstudio)**
  - Quick start
  - Non-interactive onboarding
  - Configuration
    - Streaming usage compatibility
    - Thinking compatibility
    - Explicit configuration
  - Troubleshooting
    - LM Studio not detected
    - Authentication errors (HTTP 401)
    - Just-in-time model loading
      _... and 2 more headings_

- **[MiniMax](https://docs.openclaw.ai/providers/minimax)**
  - Built-in catalog
  - Getting started
  - Configure via `openclaw configure`
  - Capabilities
    - Image generation
    - Text-to-speech
    - Music generation
    - Video generation
    - Image understanding
    - Web search
      _... and 4 more headings_

- **[Mistral](https://docs.openclaw.ai/providers/mistral)**
  - Getting started
  - Built-in LLM catalog
  - Audio transcription (Voxtral)
  - Voice Call streaming STT
  - Advanced configuration
  - Related

- **[Moonshot AI](https://docs.openclaw.ai/providers/moonshot)**
  - Built-in model catalog
  - Getting started
  - Kimi web search
  - Advanced configuration
  - Related

- **[NovitaAI](https://docs.openclaw.ai/providers/novita)**
  - Setup
  - Defaults
  - When to choose Novita
  - Models
  - Troubleshooting
  - Related

- **[NVIDIA](https://docs.openclaw.ai/providers/nvidia)**
  - Getting started
  - Config example
  - Featured catalog
  - Nemotron 3 Ultra
  - Bundled fallback catalog
  - Advanced configuration
  - Related

- **[Ollama](https://docs.openclaw.ai/providers/ollama)**
  - Auth rules
  - Getting started
  - Cloud models
  - Model discovery (implicit provider)
  - Vision and image description
  - Configuration
  - Common recipes
    - Model selection
    - Quick verification
  - Ollama Web Search
    _... and 3 more headings_

- **[Ollama Cloud](https://docs.openclaw.ai/providers/ollama-cloud)**
  - Setup
  - Defaults
  - When to choose Ollama Cloud
  - Models
  - Live test
  - Troubleshooting
  - Related

- **[OpenAI](https://docs.openclaw.ai/providers/openai)**
  - Quick choice
  - Naming map
  - OpenClaw feature coverage
  - Memory embeddings
  - Getting started
  - Native Codex app-server auth
  - Image generation
  - Video generation
  - GPT-5 prompt contribution
  - Voice and speech
    _... and 8 more headings_

- **[OpenCode](https://docs.openclaw.ai/providers/opencode)**
  - Getting started
  - Config example
  - Built-in catalogs
    - Zen
    - Go
  - Advanced configuration
  - Related

- **[OpenCode Go](https://docs.openclaw.ai/providers/opencode-go)**
  - Built-in catalog
  - Getting started
  - Config example
  - Advanced configuration
  - Related

- **[OpenRouter](https://docs.openclaw.ai/providers/openrouter)**
  - Getting started
  - Config example
  - Model references
  - Image generation
  - Video generation
  - Music generation
  - Text-to-speech
  - Speech-to-text (inbound audio)
  - Fusion router
  - Authentication and headers
    _... and 2 more headings_

- **[Perplexity](https://docs.openclaw.ai/providers/perplexity-provider)**
  - Getting started
  - Search modes
  - Native API filtering
  - Advanced configuration
  - Related

- **[PixVerse](https://docs.openclaw.ai/providers/pixverse)**
  - Getting started
  - Supported modes and models
  - Provider options
  - Configuration
  - Advanced configuration
  - Related

- **[Qianfan](https://docs.openclaw.ai/providers/qianfan)**
  - Getting started
  - Built-in catalog
  - Config example
  - Related

- **[Qwen](https://docs.openclaw.ai/providers/qwen)**
  - Getting started
  - Plan types and endpoints
  - Built-in catalog
  - Thinking Controls
  - Multimodal add-ons
  - Advanced configuration
  - Related

- **[Qwen OAuth / Portal](https://docs.openclaw.ai/providers/qwen-oauth)**
  - Setup
  - Defaults
  - How this differs from Qwen
  - When to choose Qwen OAuth / Portal
  - Models
  - Migration
  - Troubleshooting
  - Related

- **[Runway](https://docs.openclaw.ai/providers/runway)**
  - Getting started
  - Supported modes and models
  - Configuration
  - Advanced configuration
  - Related

- **[SenseAudio](https://docs.openclaw.ai/providers/senseaudio)**
  - Getting started
  - Options
  - Related

- **[SGLang](https://docs.openclaw.ai/providers/sglang)**
  - Getting started
  - Model discovery (implicit provider)
  - Explicit configuration (manual models)
  - Advanced configuration
  - Related

- **[StepFun](https://docs.openclaw.ai/providers/stepfun)**
  - Region and endpoint overview
  - Built-in catalog
  - Getting started
  - Advanced configuration
  - Related

- **[Synthetic](https://docs.openclaw.ai/providers/synthetic)**
  - Getting started
  - Config example
  - Built-in catalog
  - Related

- **[Tencent Cloud (TokenHub)](https://docs.openclaw.ai/providers/tencent)**
  - Quick start
  - Non-interactive setup
  - Built-in catalog
  - Tiered pricing
  - Advanced configuration
  - Related

- **[Together AI](https://docs.openclaw.ai/providers/together)**
  - Getting started
    - Non-interactive example
  - Built-in catalog
  - Video generation
  - Related

- **[Venice AI](https://docs.openclaw.ai/providers/venice)**
  - Why Venice in OpenClaw
  - Privacy modes
  - Features
  - Getting started
  - Model selection
  - DeepSeek V4 replay behavior
  - Built-in catalog (41 total)
  - Model discovery
  - Streaming and tool support
  - Pricing
    _... and 5 more headings_

- **[Vercel AI gateway](https://docs.openclaw.ai/providers/vercel-ai-gateway)**
  - Getting started
  - Non-interactive example
  - Model ID shorthand
  - Advanced configuration
  - Related

- **[vLLM](https://docs.openclaw.ai/providers/vllm)**
  - Getting started
  - Model discovery (implicit provider)
  - Explicit configuration (manual models)
  - Advanced configuration
  - Troubleshooting
  - Related

- **[Volcengine (Doubao)](https://docs.openclaw.ai/providers/volcengine)**
  - Getting started
  - Providers and endpoints
  - Built-in catalog
  - Text-to-speech
  - Advanced configuration
  - Related

- **[Vydra](https://docs.openclaw.ai/providers/vydra)**
  - Setup
  - Capabilities
  - Related

- **[xAI](https://docs.openclaw.ai/providers/xai)**
  - Choose your setup path
  - OAuth troubleshooting
  - Built-in catalog
  - OpenClaw feature coverage
    - Fast-mode mappings
    - Legacy compatibility aliases
  - Features
  - Live testing
  - Related

- **[Xiaomi MiMo](https://docs.openclaw.ai/providers/xiaomi)**
  - Getting started
  - Pay-as-you-go catalog
  - Token Plan catalog
  - Text-to-speech
  - Config example
  - Related

- **[Z.AI](https://docs.openclaw.ai/providers/zai)**
  - GLM models
  - Getting started
  - Config example
  - Built-in catalog
  - Advanced configuration
  - Related

## Platforms

### Platforms overview

- **[Platforms](https://docs.openclaw.ai/platforms/index)**
  - Choose your OS
  - VPS and hosting
  - Common links
  - Gateway service install (CLI)
  - Related

- **[macOS app](https://docs.openclaw.ai/platforms/macos)**
  - What it does
  - Local vs remote mode
  - Launchd control
  - Node capabilities (mac)
  - Exec approvals (system.run)
  - Deep links
    - `openclaw://agent`
  - Onboarding flow (typical)
  - State dir placement (macOS)
  - Build and dev workflow (native)
    _... and 4 more headings_

- **[Linux app](https://docs.openclaw.ai/platforms/linux)**
  - Beginner quick path (VPS)
  - Install
  - Gateway
  - Gateway service install (CLI)
  - System control (systemd user unit)
  - Memory pressure and OOM kills
  - Related

- **[Windows](https://docs.openclaw.ai/platforms/windows)**
  - Recommended: Windows Hub
    - What Windows Hub includes
    - First launch
  - Windows node mode
  - Local MCP mode
  - Native Windows CLI and Gateway
  - WSL2 Gateway
  - Gateway auto-start before Windows login
  - Expose WSL services over LAN
  - Troubleshooting
    _... and 7 more headings_

- **[Android app](https://docs.openclaw.ai/platforms/android)**
  - Support snapshot
  - System control
  - Connection runbook
    - Prerequisites
    - 1. Start the Gateway
    - 2. Verify discovery (optional)
      - Tailnet (Vienna ⇄ London) discovery via unicast DNS-SD
    - 3. Connect from Android
    - Presence alive beacons
    - 4. Approve pairing (CLI)
         _... and 8 more headings_

- **[iOS app](https://docs.openclaw.ai/platforms/ios)**
  - What it does
  - Requirements
  - Quick start (pair + connect)
  - Relay-backed push for official builds
  - Background alive beacons
  - Authentication and trust flow
  - Discovery paths
    - Bonjour (LAN)
    - Tailnet (cross-network)
    - Manual host/port
      _... and 6 more headings_

- **[EasyRunner](https://docs.openclaw.ai/platforms/easyrunner)**
  - Before you begin
  - Compose app
  - Configure OpenClaw
  - Verify
  - Updates and backups
  - Troubleshooting

### macOS companion app

#### Setup

#### Runtime

#### Features

- **[macOS dev setup](https://docs.openclaw.ai/platforms/mac/dev-setup)**
  - Prerequisites
  - 1. Install Dependencies
  - 2. Build and Package the App
  - 3. Install the CLI
  - Troubleshooting
    - Build fails: toolchain or SDK mismatch
    - App crashes on permission grant
    - Gateway "Starting..." indefinitely
  - Related

- **[Menu bar](https://docs.openclaw.ai/platforms/mac/menu-bar)**
  - What is shown
  - State model
  - IconState enum (Swift)
    - ActivityKind → glyph
    - Visual mapping
  - Context submenu
  - Status row text (menu)
  - Event ingestion
  - Debug override
  - Testing checklist
    _... and 1 more headings_

- **[Menu bar icon](https://docs.openclaw.ai/platforms/mac/icon)**
  - Related

- **[macOS permissions](https://docs.openclaw.ai/platforms/mac/permissions)**
  - Requirements for stable permissions
  - Accessibility grants for Node and CLI runtimes
  - Recovery checklist when prompts disappear
  - Files and folders permissions (Desktop/Documents/Downloads)
  - Related

- **[macOS signing](https://docs.openclaw.ai/platforms/mac/signing)**
  - Usage
    - Ad-hoc Signing Note
  - Build metadata for About
  - Why
  - Related

- **[Gateway on macOS](https://docs.openclaw.ai/platforms/mac/bundled-gateway)**
  - Install the CLI (required for local mode)
  - Launchd (Gateway as LaunchAgent)
  - Version compatibility
  - Smoke check
  - Related

- **[Gateway lifecycle on macOS](https://docs.openclaw.ai/platforms/mac/child-process)**
  - Default behavior (launchd)
  - Unsigned dev builds
  - Attach-only mode
  - Remote mode
  - Why we prefer launchd
  - Related

- **[Health checks (macOS)](https://docs.openclaw.ai/platforms/mac/health)**
  - Menu bar
  - Settings
  - How the probe works
  - When in doubt
  - Related

- **[macOS logging](https://docs.openclaw.ai/platforms/mac/logging)**
  - Rolling diagnostics file log (Debug pane)
  - Unified logging private data on macOS
  - Enable for OpenClaw (`ai.openclaw`)
  - Disable after debugging
  - Related

- **[Remote control](https://docs.openclaw.ai/platforms/mac/remote)**
  - Modes
  - Remote transports
  - Prereqs on the remote host
  - macOS app setup
  - Web Chat
  - Permissions
  - Security notes
  - WhatsApp login flow (remote)
  - Troubleshooting
  - Notification sounds
    _... and 1 more headings_

- **[macOS IPC](https://docs.openclaw.ai/platforms/mac/xpc)**
  - Goals
  - How it works
    - Gateway + node transport
    - Node service + app IPC
    - PeekabooBridge (UI automation)
  - Operational flows
  - Hardening notes
  - Related

- **[Voice wake (macOS)](https://docs.openclaw.ai/platforms/mac/voicewake)**
  - Requirements
  - Modes
  - Runtime behavior (wake-word)
  - Lifecycle invariants
  - Sticky overlay failure mode (previous)
  - Push-to-talk specifics
  - User-facing settings
  - Forwarding behavior
  - Forwarding payload
  - Quick verification
    _... and 1 more headings_

- **[Voice overlay](https://docs.openclaw.ai/platforms/mac/voice-overlay)**
  - Current intent
  - Implemented (Dec 9, 2025)
  - Next steps
  - Debugging checklist
  - Migration steps (suggested)
  - Related

- **[WebChat (macOS)](https://docs.openclaw.ai/platforms/mac/webchat)**
  - Launch and debugging
  - How it is wired
  - Security surface
  - Known limitations
  - Related

- **[Canvas](https://docs.openclaw.ai/platforms/mac/canvas)**
  - Where Canvas lives
  - Panel behavior
  - Agent API surface
  - A2UI in Canvas
    - A2UI commands (v0.8)
  - Triggering agent runs from Canvas
  - Security notes
  - Related

- **[Skills (macOS)](https://docs.openclaw.ai/platforms/mac/skills)**
  - Data source
  - Install actions
  - Env/API keys
  - Remote mode
  - Related

- **[Peekaboo bridge](https://docs.openclaw.ai/platforms/mac/peekaboo)**
  - What this is (and is not)
  - Relationship to Computer Use
  - Enable the bridge
  - Client discovery order
  - Security and permissions
  - Snapshot behavior (automation)
  - Troubleshooting
  - Related

## Gateway & Ops

### Gateway

#### Configuration

#### Authentication and secrets

#### Health and diagnostics

#### Scaling and operations

#### Security and sandboxing

#### Protocols and APIs

#### Networking and discovery

- **[Gateway runbook](https://docs.openclaw.ai/gateway/index)**
  - 5-minute local startup
  - Runtime model
  - OpenAI-compatible endpoints
    - Port and bind precedence
    - Hot reload modes
  - Operator command set
  - Multiple gateways (same host)
  - Remote access
  - Supervision and service lifecycle
  - Dev profile quick path
    _... and 8 more headings_

- **[Configuration](https://docs.openclaw.ai/gateway/configuration)**
  - Minimal config
  - Editing config
  - Strict validation
  - Common tasks
  - Config hot reload
    - Reload modes
    - What hot-applies vs what needs a restart
    - Reload planning
  - Config RPC (programmatic updates)
  - Environment variables
    _... and 2 more headings_

- **[Configuration reference](https://docs.openclaw.ai/gateway/configuration-reference)**
  - Channels
  - Agent defaults, multi-agent, sessions, and messages
  - Tools and custom providers
  - Models
  - MCP
  - Skills
  - Plugins
    - Codex harness plugin config
  - Commitments
  - Browser
    _... and 36 more headings_

- **[Configuration — agents](https://docs.openclaw.ai/gateway/config-agents)**
  - Agent defaults
    - `agents.defaults.workspace`
    - `agents.defaults.repoRoot`
    - `agents.defaults.skills`
    - `agents.defaults.skipBootstrap`
    - `agents.defaults.skipOptionalBootstrapFiles`
    - `agents.defaults.contextInjection`
    - `agents.defaults.bootstrapMaxChars`
    - `agents.defaults.bootstrapTotalMaxChars`
    - Per-agent bootstrap profile overrides
      _... and 34 more headings_

- **[Configuration — channels](https://docs.openclaw.ai/gateway/config-channels)**
  - Channels
    - DM and group access
    - Channel model overrides
    - Channel defaults and heartbeat
    - WhatsApp
    - Telegram
    - Discord
    - Google Chat
    - Slack
    - Mattermost
      _... and 12 more headings_

- **[Configuration — tools and custom providers](https://docs.openclaw.ai/gateway/config-tools)**
  - Tools
    - Tool profiles
    - Tool groups
    - MCP and plugin tools inside sandbox tool policy
    - `tools.codeMode`
    - `tools.allow` / `tools.deny`
    - `tools.byProvider`
    - `tools.toolsBySender`
    - `tools.elevated`
    - `tools.exec`
      _... and 12 more headings_

- **[Configuration examples](https://docs.openclaw.ai/gateway/configuration-examples)**
  - Quick start
    - Absolute minimum
    - Recommended starter
  - Expanded example (major options)
    - Symlinked sibling skill repo
  - Common patterns
    - Shared skill baseline with one override
    - Multi-platform setup
    - Trusted node network auto-approval
    - Secure DM mode (shared inbox / multi-user DMs)
      _... and 5 more headings_

- **[Authentication](https://docs.openclaw.ai/gateway/authentication)**
  - Recommended setup (API key, any provider)
  - Anthropic: Claude CLI and token compatibility
  - Anthropic note
  - Checking model auth status
  - API key rotation behavior (gateway)
  - Removing provider auth while the gateway is running
  - Controlling which credential is used
    - OpenAI and legacy `openai-codex` ids
    - During login (CLI)
    - Per-session (chat command)
      _... and 5 more headings_

- **[Auth credential semantics](https://docs.openclaw.ai/auth-credential-semantics)**
  - Stable probe reason codes
  - Token credentials
    - Eligibility rules
    - Resolution rules
  - Agent copy portability
  - Config-only auth routes
  - Explicit auth order filtering
  - Probe target resolution
  - External CLI credential discovery
  - OAuth SecretRef Policy Guard
    _... and 2 more headings_

- **[Secrets management](https://docs.openclaw.ai/gateway/secrets)**
  - Goals and runtime model
  - Agent-access boundary
  - Active-surface filtering
  - Gateway auth surface diagnostics
  - Onboarding reference preflight
  - SecretRef contract
  - Provider config
  - File-backed API keys
  - Exec integration examples
  - MCP server environment variables
    _... and 11 more headings_

- **[Secrets apply plan contract](https://docs.openclaw.ai/gateway/secrets-plan-contract)**
  - Plan file shape
  - Provider upserts and deletes
  - Supported target scope
  - Target type behavior
  - Path validation rules
  - Failure behavior
  - Exec provider consent behavior
  - Runtime and audit scope notes
  - Operator checks
  - Related docs

- **[Trusted proxy auth](https://docs.openclaw.ai/gateway/trusted-proxy-auth)**
  - When to use
  - When NOT to use
  - How it works
  - Control UI pairing behavior
  - Configuration
    - Configuration reference
  - TLS termination and HSTS
    - Rollout guidance
  - Proxy setup examples
  - Mixed token configuration
    _... and 6 more headings_

- **[Health checks](https://docs.openclaw.ai/gateway/health)**
  - Quick checks
  - Deep diagnostics
  - Health monitor config
  - Uptime monitoring
    - Monitoring service setup examples
  - When something fails
  - Dedicated "health" command
  - Related

- **[Heartbeat](https://docs.openclaw.ai/gateway/heartbeat)**
  - Quick start (beginner)
  - Defaults
  - What the heartbeat prompt is for
  - Response contract
  - Config
    - Scope and precedence
    - Per-agent heartbeats
    - Active hours example
    - 24/7 setup
    - Multi-account example
      _... and 14 more headings_

- **[Doctor](https://docs.openclaw.ai/gateway/doctor)**
  - Quick start
    - Headless and automation modes
  - Read-only lint mode
  - What it does (summary)
  - Dreams UI backfill and reset
  - Detailed behavior and rationale
  - Related

- **[Logging](https://docs.openclaw.ai/logging)**
  - Where logs live
  - How to read logs
    - CLI: live tail (recommended)
    - Control UI (web)
    - Channel-only logs
  - Log formats
    - File logs (JSONL)
    - Console output
    - Gateway WebSocket logs
  - Configuring logging
    _... and 9 more headings_

- **[OpenTelemetry export](https://docs.openclaw.ai/gateway/opentelemetry)**
  - How it fits together
  - Quick start
  - Signals exported
  - Configuration reference
    - Environment variables
  - Privacy and content capture
  - Sampling and flushing
  - Exported metrics
    - Model usage
    - Message flow
      _... and 12 more headings_

- **[Prometheus metrics](https://docs.openclaw.ai/gateway/prometheus)**
  - Quick start
  - Metrics exported
  - Label policy
  - PromQL recipes
  - Choosing between Prometheus and OpenTelemetry export
  - Troubleshooting
  - Related

- **[Gateway logging](https://docs.openclaw.ai/gateway/logging)**
  - File-based logger
  - Console capture
  - Redaction
  - Gateway WebSocket logs
    - WS log style
  - Console formatting (subsystem logging)
  - Related

- **[Diagnostics export](https://docs.openclaw.ai/gateway/diagnostics)**
  - Quick start
  - Chat command
  - What the export contains
  - Privacy model
  - Stability recorder
  - Useful options
  - Disable diagnostics
  - Related

- **[Troubleshooting](https://docs.openclaw.ai/gateway/troubleshooting)**
  - Command ladder
  - After an update
  - Split brain installs and newer config guard
  - Protocol mismatch after rollback
  - Skill symlink skipped as path escape
  - Anthropic 429 extra usage required for long context
  - Upstream 403 blocked responses
  - Local OpenAI-compatible backend passes direct probes but agent runs fail
  - No replies
  - Dashboard control UI connectivity
    _... and 12 more headings_

- **[Gateway lock](https://docs.openclaw.ai/gateway/gateway-lock)**
  - Why
  - Mechanism
  - Error surface
  - Operational notes
  - Related

- **[Background exec and process tool](https://docs.openclaw.ai/gateway/background-process)**
  - exec tool
  - Child process bridging
  - process tool
  - Examples
  - Related

- **[Multiple gateways](https://docs.openclaw.ai/gateway/multiple-gateways)**
  - Best recommended setup
  - Rescue-Bot Quickstart
  - Why this works
  - What `--profile rescue onboard` Changes
  - General multi-gateway setup
  - Isolation checklist
  - Port mapping (derived)
  - Browser/CDP notes (common footgun)
  - Manual env example
  - Quick checks
    _... and 1 more headings_

- **[Security](https://docs.openclaw.ai/gateway/security/index)**
  - Scope first: personal assistant security model
  - Quick check: `openclaw security audit`
    - Published package dependency lock
    - Deployment and host trust
    - Secure file operations
    - Shared Slack workspace: real risk
    - Company-shared agent: acceptable pattern
  - Gateway and node trust concept
  - Trust boundary matrix
  - Not vulnerabilities by design
    _... and 61 more headings_

- **[Gateway exposure runbook](https://docs.openclaw.ai/gateway/security/exposure-runbook)**
  - Choose the exposure pattern
  - Pre-flight inventory
  - Baseline checks
  - Minimum safe baseline
  - DM and group exposure
  - Reverse proxy checks
  - Tool and sandbox review
  - Post-change validation
  - Rollback plan
  - Review checklist

- **[Secure file operations](https://docs.openclaw.ai/gateway/security/secure-file-operations)**
  - Default: no Python helper
  - What stays protected without Python
  - What Python adds
  - Plugin and core guidance

- **[npm shrinkwrap](https://docs.openclaw.ai/gateway/security/shrinkwrap)**
  - The easy version
  - Why OpenClaw uses it
  - Technical details

- **[Security audit checks](https://docs.openclaw.ai/gateway/security/audit-checks)**
  - Related

- **[Operator scopes](https://docs.openclaw.ai/gateway/operator-scopes)**
  - Roles
  - Scope levels
  - Method scope is only the first gate
  - Device pairing approvals
  - Node pairing approvals
  - Shared-secret auth

- **[Sandboxing](https://docs.openclaw.ai/gateway/sandboxing)**
  - What gets sandboxed
  - Modes
  - Scope
  - Backend
    - Choosing a backend
    - Docker backend
    - SSH backend
    - OpenShell backend
      - Workspace modes
      - OpenShell lifecycle
        _... and 8 more headings_

- **[OpenShell](https://docs.openclaw.ai/gateway/openshell)**
  - Prerequisites
  - Quick start
  - Workspace modes
    - `mirror`
    - `remote`
    - Choosing a mode
  - Configuration reference
  - Examples
    - Minimal remote setup
    - Mirror mode with GPU
      _... and 7 more headings_

- **[Sandbox vs tool policy vs elevated](https://docs.openclaw.ai/gateway/sandbox-vs-tool-policy-vs-elevated)**
  - Quick debug
  - Sandbox: where tools run
    - Bind mounts (security quick check)
  - Tool policy: which tools exist/are callable
    - Tool groups (shorthands)
  - Elevated: exec-only "run on host"
  - Common "sandbox jail" fixes
    - "Tool X blocked by sandbox tool policy"
    - "I thought this was main, why is it sandboxed?"
  - Related

- **[Gateway protocol](https://docs.openclaw.ai/gateway/protocol)**
  - Transport
  - Handshake (connect)
    - Node example
  - Framing
  - Roles + scopes
    - Roles
    - Scopes (operator)
    - Caps/commands/permissions (node)
  - Presence
    - Node background alive event
      _... and 17 more headings_

- **[Bridge protocol](https://docs.openclaw.ai/gateway/bridge-protocol)**
  - Why it existed
  - Transport
  - Handshake + pairing
  - Frames
  - Exec lifecycle events
  - Historical tailnet usage
  - Versioning
  - Related

- **[OpenAI chat completions](https://docs.openclaw.ai/gateway/openai-http-api)**
  - Authentication
  - Security boundary (important)
  - When to use this endpoint
  - Agent-first model contract
  - Enabling the endpoint
  - Disabling the endpoint
  - Session behavior
  - Why this surface matters
  - Model list and agent routing
  - Streaming (SSE)
    _... and 9 more headings_

- **[OpenResponses API](https://docs.openclaw.ai/gateway/openresponses-http-api)**
  - Authentication, security, and routing
  - Session behavior
  - Request shape (supported)
  - Items (input)
    - `message`
    - `function_call_output` (turn-based tools)
    - `reasoning` and `item_reference`
  - Tools (client-side function tools)
  - Images (`input_image`)
  - Files (`input_file`)
    _... and 6 more headings_

- **[Tools invoke API](https://docs.openclaw.ai/gateway/tools-invoke-http-api)**
  - Authentication
  - Security boundary (important)
  - Request body
  - Policy + routing behavior
  - Responses
  - Example
  - Related

- **[CLI backends](https://docs.openclaw.ai/gateway/cli-backends)**
  - Beginner-friendly quick start
  - Using it as a fallback
  - Configuration overview
    - Example configuration
  - How it works
  - Sessions
  - Fallback prelude from claude-cli sessions
  - Images (pass-through)
  - Inputs / outputs
  - Defaults (plugin-owned)
    _... and 7 more headings_

- **[Local models](https://docs.openclaw.ai/gateway/local-models)**
  - Hardware floor
  - Pick a backend
  - Recommended: LM Studio + large local model (Responses API)
    - Hybrid config: hosted primary, local fallback
    - Local-first with hosted safety net
    - Regional hosting / data routing
  - Other OpenAI-compatible local proxies
  - Smaller or stricter backends
  - Troubleshooting
  - Related

- **[Local model services](https://docs.openclaw.ai/gateway/local-model-services)**
  - How it works
  - Config shape
  - Fields
  - Inferrs example
  - ds4 example
  - Operational notes
  - Related

- **[Network](https://docs.openclaw.ai/network)**
  - Core model
  - Pairing + identity
  - Discovery + transports
  - Nodes + transports
  - Security
  - Related

- **[Gateway-owned pairing](https://docs.openclaw.ai/gateway/pairing)**
  - Concepts
  - How pairing works
  - CLI workflow (headless friendly)
  - API surface (gateway protocol)
  - Node command gating (2026.3.31+)
  - Node event trust boundaries (2026.3.31+)
  - Auto-approval (macOS app)
  - Trusted-CIDR device auto-approval
  - Metadata-upgrade auto-approval
  - QR pairing helpers
    _... and 4 more headings_

- **[Discovery and transports](https://docs.openclaw.ai/gateway/discovery)**
  - Terms
  - Why we keep both direct and SSH
  - Discovery inputs (how clients learn where the gateway is)
    - 1. Bonjour / DNS-SD discovery
      - Service beacon details
    - 2. Tailnet (cross-network)
    - 3. Manual / SSH target
  - Transport selection (client policy)
  - Pairing + auth (direct transport)
  - Responsibilities by component
    _... and 1 more headings_

- **[Bonjour discovery](https://docs.openclaw.ai/gateway/bonjour)**
  - Wide-area Bonjour (Unicast DNS-SD) over Tailscale
    - Gateway config (recommended)
    - One-time DNS server setup (gateway host)
    - Tailscale DNS settings
    - Gateway listener security (recommended)
  - What advertises
  - Service types
  - TXT keys (non-secret hints)
  - Debugging on macOS
  - Debugging in Gateway logs
    _... and 9 more headings_

### Remote access

- **[Remote access](https://docs.openclaw.ai/gateway/remote)**
  - The core idea
  - Common VPN and tailnet setups
    - Always-on Gateway in your tailnet
    - Home desktop runs the Gateway
    - Laptop runs the Gateway
  - Command flow (what runs where)
  - SSH tunnel (CLI + tools)
  - CLI remote defaults
  - Credential precedence
  - Chat UI remote access
    _... and 10 more headings_

- **[Remote gateway setup](https://docs.openclaw.ai/gateway/remote-gateway-readme)**
  - Overview
  - Quick setup
    - Step 1: Add SSH Config
    - Step 2: Copy SSH Key
    - Step 3: Configure Remote Gateway Auth
    - Step 4: Start SSH Tunnel
    - Step 5: Restart OpenClaw.app
  - Auto-Start Tunnel on Login
    - Create the PLIST file
    - Load the Launch Agent
      _... and 3 more headings_

- **[Tailscale](https://docs.openclaw.ai/gateway/tailscale)**
  - Modes
  - Auth
  - Config examples
    - Tailnet-only (Serve)
    - Tailnet-only (bind to Tailnet IP)
    - Public internet (Funnel + shared password)
  - CLI examples
  - Notes
  - Browser control (remote Gateway + local browser)
  - Tailscale prerequisites + limits
    _... and 2 more headings_

### Security

- **[Network proxy](https://docs.openclaw.ai/security/network-proxy)**
  - Why use a proxy
  - How OpenClaw routes traffic
  - Related proxy terms
  - Configuration
    - Gateway Loopback Mode
  - Proxy Requirements
  - Recommended blocked destinations
  - Validation
  - Proxy CA trust
  - Limits

- **[Formal verification (security models)](https://docs.openclaw.ai/security/formal-verification)**
  - Where the models live
  - Important caveats
  - Reproducing results
    - Gateway exposure and open gateway misconfiguration
    - Node exec pipeline (highest-risk capability)
    - Pairing store (DM gating)
    - Ingress gating (mentions + control-command bypass)
    - Routing/session-key isolation
  - v1++: additional bounded models (concurrency, retries, trace correctness)
    - Pairing store concurrency / idempotency
      _... and 3 more headings_

- **[Threat model (MITRE ATLAS)](https://docs.openclaw.ai/security/THREAT-MODEL-ATLAS)**
  - MITRE ATLAS framework
    - Framework attribution
    - Contributing to This Threat Model
  - 1. Introduction
    - 1.1 Purpose
    - 1.2 Scope
    - 1.3 Out of Scope
  - 2. System Architecture
    - 2.1 Trust Boundaries
    - 2.2 Data Flows
      _... and 47 more headings_

- **[Contributing to the threat model](https://docs.openclaw.ai/security/CONTRIBUTING-THREAT-MODEL)**
  - Ways to contribute
    - Add a threat
    - Suggest a mitigation
    - Propose an attack chain
    - Fix or improve existing content
  - What we use
    - MITRE ATLAS framework
    - Threat ids
    - Risk levels
  - Review process
    _... and 4 more headings_

### Nodes and media

#### Media capabilities

#### Node features

- **[Nodes](https://docs.openclaw.ai/nodes/index)**
  - Pairing + status
  - Remote node host (system.run)
    - What runs where
    - Start a node host (foreground)
    - Remote gateway via SSH tunnel (loopback bind)
    - Start a node host (service)
    - Pair + name
    - Allowlist the commands
    - Point exec at the node
  - Invoking commands
    _... and 15 more headings_

- **[Node troubleshooting](https://docs.openclaw.ai/nodes/troubleshooting)**
  - Command ladder
  - Foreground requirements
  - Permissions matrix
  - Pairing versus approvals
  - Common node error codes
  - Fast recovery loop
  - Related

- **[Media understanding](https://docs.openclaw.ai/nodes/media-understanding)**
  - Goals
  - High-level behavior
  - Config overview
    - Model entries
    - Provider credentials (`apiKey`)
  - Defaults and limits
    - Auto-detect media understanding (default)
    - Proxy environment support (provider models)
  - Capabilities (optional)
  - Provider support matrix (OpenClaw integrations)
    _... and 6 more headings_

- **[Image and media support](https://docs.openclaw.ai/nodes/images)**
  - Goals
  - CLI Surface
  - WhatsApp Web channel behavior
  - Auto-Reply Pipeline
  - Inbound Media To Commands
  - Limits and errors
  - Notes for Tests
  - Related

- **[Audio and voice notes](https://docs.openclaw.ai/nodes/audio)**
  - What works
  - Auto-detection (default)
  - Config examples
    - Provider + CLI fallback (OpenAI + Whisper CLI)
    - Provider-only with scope gating
    - Provider-only (Deepgram)
    - Provider-only (Mistral Voxtral)
    - Provider-only (SenseAudio)
    - Echo transcript to chat (opt-in)
  - Notes and limits
    _... and 4 more headings_

- **[Camera capture](https://docs.openclaw.ai/nodes/camera)**
  - iOS node
    - User setting (default on)
    - Commands (via Gateway `node.invoke`)
    - Foreground requirement
    - CLI helper
  - Android node
    - Android user setting (default on)
    - Permissions
    - Android foreground requirement
    - Android commands (via Gateway `node.invoke`)
      _... and 7 more headings_

- **[Text-to-speech](https://docs.openclaw.ai/tools/tts)**
  - Quick start
  - Supported providers
  - Configuration
    - Per-agent voice overrides
  - Personas
    - Minimal persona
    - Full persona (provider-neutral prompt)
    - Persona resolution
    - How providers use persona prompts
    - Fallback policy
      _... and 11 more headings_

- **[Talk mode](https://docs.openclaw.ai/nodes/talk)**
  - Behavior (macOS)
  - Voice directives in replies
  - Config (`~/.openclaw/openclaw.json`)
  - macOS UI
  - Android UI
  - Notes
  - Related

- **[Voice wake](https://docs.openclaw.ai/nodes/voicewake)**
  - Storage (Gateway host)
  - Protocol
    - Methods
    - Routing methods (trigger → target)
    - Events
  - Client behavior
    - macOS app
    - iOS node
    - Android node
  - Related

- **[Location command](https://docs.openclaw.ai/nodes/location-command)**
  - TL;DR
  - Why a selector (not just a switch)
  - Settings model
  - Permissions mapping (node.permissions)
  - Command: `location.get`
  - Background behavior
  - Model/tooling integration
  - UX copy (suggested)
  - Related

### Web interfaces

- **[Web](https://docs.openclaw.ai/web/index)**
  - Webhooks
  - Admin HTTP RPC
  - Config (default-on)
  - Tailscale access
    - Integrated Serve (recommended)
    - Tailnet bind + token
    - Public internet (Funnel)
  - Security notes
  - Building the UI

- **[Control UI](https://docs.openclaw.ai/web/control-ui)**
  - Quick open (local)
  - Device pairing (first connection)
  - Personal identity (browser-local)
  - Runtime config endpoint
  - Language support
  - Appearance themes
  - What it can do (today)
  - MCP page
  - Activity tab
  - Chat behavior
    _... and 12 more headings_

- **[Dashboard](https://docs.openclaw.ai/web/dashboard)**
  - Fast path (recommended)
  - Auth basics (local vs remote)
  - If you see "unauthorized" / 1008
  - Related

- **[WebChat](https://docs.openclaw.ai/web/webchat)**
  - What it is
  - Quick start
  - How it works (behavior)
    - Transcript and delivery model
  - Control UI agents tools panel
  - Remote use
  - Configuration reference (WebChat)
  - Related

- **[TUI](https://docs.openclaw.ai/web/tui)**
  - Quick start
    - Gateway mode
    - Local mode
  - What you see
  - Mental model: agents + sessions
  - Sending + delivery
  - Pickers + overlays
  - Keyboard shortcuts
  - Slash commands
  - Local shell commands
    _... and 9 more headings_

## Reference

### CLI commands

#### Gateway and service

#### Agents and sessions

#### Channels and messaging

#### Tools and execution

#### Configuration

#### Plugins and skills

#### Interfaces

#### Utility

- **[CLI reference](https://docs.openclaw.ai/cli/index)**
  - Command pages
  - Global flags
  - Output modes
  - Command tree
  - Chat slash commands
  - Usage tracking
  - Related

- **[Backup](https://docs.openclaw.ai/cli/backup)**
  - Notes
  - What gets backed up
  - Invalid config behavior
  - Size and performance
  - Related

- **[Crestodian](https://docs.openclaw.ai/cli/crestodian)**
  - What Crestodian shows
  - Examples
  - Safe startup
  - Operations and approval
  - Setup bootstrap
  - Model-Assisted Planner
  - Switching to an agent
  - Message rescue mode
  - Related

- **[Daemon](https://docs.openclaw.ai/cli/daemon)**
  - Usage
  - Subcommands
  - Common options
  - Prefer
  - Related

- **[Doctor](https://docs.openclaw.ai/cli/doctor)**
  - Why Use It
  - Examples
  - Options
  - Lint mode
  - Structured Health Checks
  - Check Selection
  - Post-upgrade mode
  - macOS: `launchctl` env overrides
  - Related

- **[Gateway](https://docs.openclaw.ai/cli/gateway)**
  - Run the Gateway
    - Options
  - Restart the Gateway
    - Gateway profiling
  - Query a running Gateway
    - `gateway health`
    - `gateway usage-cost`
    - `gateway stability`
    - `gateway diagnostics export`
    - `gateway status`
      _... and 8 more headings_

- **[Health](https://docs.openclaw.ai/cli/health)**
  - Options
  - Related

- **[Logs](https://docs.openclaw.ai/cli/logs)**
  - Options
  - Shared Gateway RPC options
  - Examples
  - Notes
  - Related

- **[Migrate](https://docs.openclaw.ai/cli/migrate)**
  - Commands
  - Safety model
  - Claude provider
    - What Claude imports
    - Archive and manual-review state
  - Codex provider
    - What Codex imports
    - Manual-review Codex state
  - Hermes provider
    - What Hermes imports
      _... and 6 more headings_

- **[Onboard](https://docs.openclaw.ai/cli/onboard)**
  - Related guides
  - Examples
  - Locale
    - Non-interactive Z.AI endpoint choices
  - Flow notes
  - Common follow-up commands

- **[Reset](https://docs.openclaw.ai/cli/reset)**
  - Related

- **[Secrets](https://docs.openclaw.ai/cli/secrets)**
  - Reload runtime snapshot
  - Audit
  - Configure (interactive helper)
  - Apply a saved plan
  - Why no rollback backups
  - Example
  - Related

- **[Security](https://docs.openclaw.ai/cli/security)**
  - Audit
  - JSON output
  - What `--fix` changes
  - Related

- **[Setup](https://docs.openclaw.ai/cli/setup)**
  - Options
    - Wizard auto-trigger
  - Examples
  - Notes
  - Related

- **[openclaw status](https://docs.openclaw.ai/cli/status)**
  - Related

- **[Uninstall](https://docs.openclaw.ai/cli/uninstall)**
  - Related

- **[Update](https://docs.openclaw.ai/cli/update)**
  - Usage
  - Options
  - `update status`
  - `update repair`
  - `update wizard`
  - What it does
    - Control-plane response shape
  - Git checkout flow
    - Channel selection
    - Update steps
      _... and 2 more headings_

- **[Agent](https://docs.openclaw.ai/cli/agent)**
  - Options
  - Examples
  - Notes
  - JSON delivery status
  - Related

- **[Agents](https://docs.openclaw.ai/cli/agents)**
  - Examples
  - Routing bindings
    - `--bind` format
    - Binding scope behavior
  - Command surface
    - `agents`
    - `agents list`
    - `agents add [name]`
    - `agents bindings`
    - `agents bind`
      _... and 5 more headings_

- **[Hooks](https://docs.openclaw.ai/cli/hooks)**
  - List all hooks
  - Get hook information
  - Check hooks eligibility
  - Enable a Hook
  - Disable a Hook
  - Notes
  - Install hook packs
  - Update hook packs
  - Bundled hooks
    - session-memory
      _... and 4 more headings_

- **[Inference CLI](https://docs.openclaw.ai/cli/infer)**
  - Turn infer into a skill
  - Why use infer
  - Command tree
  - Common tasks
  - Behavior
  - Model
  - Image
  - Audio
  - TTS
  - Video
    _... and 6 more headings_

- **[Memory](https://docs.openclaw.ai/cli/memory)**
  - Examples
  - Options
  - Dreaming
  - Related

- **[`openclaw commitments`](https://docs.openclaw.ai/cli/commitments)**
  - Usage
  - Options
  - Examples
  - Output
  - Related

- **[Message](https://docs.openclaw.ai/cli/message)**
  - Usage
  - Common flags
  - SecretRef behavior
  - Actions
    - Core
    - Threads
    - Emojis
    - Stickers
    - Roles / Channels / Members / Voice
    - Events
      _... and 4 more headings_

- **[Models](https://docs.openclaw.ai/cli/models)**
  - Common commands
    - Models scan
    - Models status
  - Aliases + fallbacks
  - Auth profiles
  - Related

- **[Sessions](https://docs.openclaw.ai/cli/sessions)**
  - Cleanup maintenance
  - Related

- **[System](https://docs.openclaw.ai/cli/system)**
  - Common commands
  - `system event`
  - `system heartbeat last|enable|disable`
  - `system presence`
  - Notes
  - Related

- **[`openclaw tasks`](https://docs.openclaw.ai/cli/tasks)**
  - Usage
  - Root Options
  - Subcommands
    - `list`
    - `show`
    - `notify`
    - `cancel`
    - `audit`
    - `maintenance`
    - `flow`
      _... and 1 more headings_

- **[Channels](https://docs.openclaw.ai/cli/channels)**
  - Common commands
  - Status / capabilities / resolve / logs
  - Add / remove accounts
  - Login and logout (interactive)
  - Troubleshooting
  - Capabilities probe
  - Resolve names to IDs
  - Related

- **[Devices](https://docs.openclaw.ai/cli/devices)**
  - Commands
    - `openclaw devices list`
    - `openclaw devices remove `
    - `openclaw devices clear --yes [--pending]`
    - `openclaw devices approve [requestId] [--latest]`
  - Paperclip / `openclaw_gateway` first-run approval
    - `openclaw devices reject `
    - `openclaw devices rotate --device  --role  [--scope ]`
    - `openclaw devices revoke --device  --role `
  - Common options
    _... and 3 more headings_

- **[Directory](https://docs.openclaw.ai/cli/directory)**
  - Common flags
  - Notes
  - Using results with `message send`
  - ID formats (by channel)
  - Self ("me")
  - Peers (contacts/users)
  - Groups
  - Related

- **[Pairing](https://docs.openclaw.ai/cli/pairing)**
  - Commands
  - `pairing list`
  - `pairing approve`
  - Notes
  - Related

- **[QR](https://docs.openclaw.ai/cli/qr)**
  - Usage
  - Options
  - Notes
  - Related

- **[Voicecall](https://docs.openclaw.ai/cli/voicecall)**
  - Subcommands
  - Setup and smoke
    - `setup`
    - `smoke`
  - Call lifecycle
    - `call`
    - `start`
    - `continue`
    - `speak`
    - `dtmf`
      _... and 8 more headings_

- **[Approvals](https://docs.openclaw.ai/cli/approvals)**
  - `openclaw exec-policy`
  - Common commands
  - Replace approvals from a file
  - "Never prompt" / YOLO example
  - Allowlist helpers
  - Common options
  - Notes
  - Related

- **[Browser](https://docs.openclaw.ai/cli/browser)**
  - Common flags
  - Quick start (local)
  - Quick troubleshooting
  - Lifecycle
  - If the command is missing
  - Profiles
  - Tabs
  - Snapshot / screenshot / actions
  - State and storage
  - Debugging
    _... and 3 more headings_

- **[Cron](https://docs.openclaw.ai/cli/cron)**
  - Create jobs quickly
  - Sessions
  - Delivery
    - Delivery ownership
    - Failure delivery
  - Scheduling
    - One-shot jobs
    - Recurring jobs
    - Manual runs
  - Models
    _... and 12 more headings_

- **[Flows (redirect)](https://docs.openclaw.ai/cli/flows)**
  - Subcommands
    - Status filter values
  - Examples
  - Related

- **[Node](https://docs.openclaw.ai/cli/node)**
  - Why use a node host?
  - Browser proxy (zero-config)
  - Run (foreground)
  - Gateway auth for node host
  - Service (background)
  - Pairing
  - Exec approvals
  - Related

- **[Nodes](https://docs.openclaw.ai/cli/nodes)**
  - Common commands
  - Invoke
  - Related

- **[Sandbox CLI](https://docs.openclaw.ai/cli/sandbox)**
  - Overview
  - Commands
    - `openclaw sandbox explain`
    - `openclaw sandbox list`
    - `openclaw sandbox recreate`
  - Use cases
    - After updating a Docker image
    - After changing sandbox configuration
    - After changing SSH target or SSH auth material
    - After changing OpenShell source, policy, or mode
      _... and 6 more headings_

- **[Config](https://docs.openclaw.ai/cli/config)**
  - Root options
  - Examples
    - `config schema`
    - Paths
  - Values
  - `config set` modes
  - `config patch`
  - Provider builder flags
  - Dry run
    - JSON output shape
      _... and 4 more headings_

- **[Configure](https://docs.openclaw.ai/cli/configure)**
  - Options
  - Examples
  - Related

- **[Webhooks](https://docs.openclaw.ai/cli/webhooks)**
  - Subcommands
  - `webhooks gmail setup`
    - Required
    - Pub/Sub options
    - OpenClaw delivery options
    - `gog watch serve` options
    - Tailscale exposure
    - Output
  - `webhooks gmail run`
  - End-to-end flow
    _... and 1 more headings_

- **[Plugins](https://docs.openclaw.ai/cli/plugins)**
  - Commands
    - Author
    - Install
      - Marketplace shorthand
    - List
    - Plugin index
    - Uninstall
    - Update
    - Inspect
    - Doctor
      _... and 3 more headings_

- **[Path](https://docs.openclaw.ai/cli/path)**
  - Why use it
  - How it is used
  - How it works
  - Subcommands
  - Global flags
  - `oc://` syntax
  - Addressing by file kind
  - Mutation contract
  - Examples
  - Recipes by file kind
    _... and 15 more headings_

- **[Policy](https://docs.openclaw.ai/cli/policy)**
  - Quick start
    - Policy rule reference
      - Scoped overlays
      - Channels
      - MCP servers
      - Model providers
      - Network
      - Ingress and channel access
      - Gateway
      - Agent workspace
        _... and 13 more headings_

- **[Skills](https://docs.openclaw.ai/cli/skills)**
  - Commands
  - Skill Workshop
  - Related

- **[Workboard CLI](https://docs.openclaw.ai/cli/workboard)**
  - Usage
  - `list`
  - `create`
  - `show`
  - `dispatch`
  - Slash Command Parity
  - Permissions
  - Troubleshooting
    - No Cards Appear
    - Dispatch Says Data-Only
      _... and 2 more headings_

- **[Dashboard](https://docs.openclaw.ai/cli/dashboard)**
  - Related

- **[TUI](https://docs.openclaw.ai/cli/tui)**
  - Options
  - Examples
  - Config repair loop
  - Related

- **[ACP](https://docs.openclaw.ai/cli/acp)**
  - What this is not
  - Compatibility Matrix
  - Known Limitations
  - Usage
  - ACP client (debug)
  - Protocol smoke testing
  - How to use this
  - Selecting agents
  - Use from `acpx` (Codex, Claude, other ACP clients)
  - Zed editor setup
    _... and 4 more headings_

- **[Clawbot](https://docs.openclaw.ai/cli/clawbot)**
  - Migration
  - Related

- **[Completion](https://docs.openclaw.ai/cli/completion)**
  - Usage
  - Options
  - Notes
  - Related

- **[DNS](https://docs.openclaw.ai/cli/dns)**
  - Setup
  - `dns setup`
  - Related

- **[Docs](https://docs.openclaw.ai/cli/docs)**
  - Usage
  - Examples
  - How it works
  - Output
  - Exit codes
  - Related

- **[MCP](https://docs.openclaw.ai/cli/mcp)**
  - Choose the right MCP path
  - OpenClaw as an MCP server
    - When to use `serve`
    - How it works
    - Choose a client mode
    - What `serve` exposes
    - Usage
    - Bridge tools
    - Event model
    - Claude channel notifications
      _... and 16 more headings_

- **[Proxy](https://docs.openclaw.ai/cli/proxy)**
  - Commands
  - Validate
  - Query presets
  - Notes
  - Related

- **[Wiki](https://docs.openclaw.ai/cli/wiki)**
  - What it is for
  - Common commands
  - Commands
    - `wiki status`
    - `wiki doctor`
    - `wiki init`
    - `wiki ingest `
    - `wiki okf import `
    - `wiki compile`
    - `wiki lint`
      _... and 9 more headings_

### RPC and API

- **[RPC adapters](https://docs.openclaw.ai/reference/rpc)**
  - Pattern A: HTTP daemon (signal-cli)
  - Pattern B: stdio child process (imsg)
  - Adapter guidelines
  - Related

- **[Gateway integrations for external apps](https://docs.openclaw.ai/gateway/external-apps)**
  - What is available today
  - Recommended path
  - App code vs plugin code
  - Related

- **[Code mode](https://docs.openclaw.ai/reference/code-mode)**
  - What is this?
  - Why is this good?
  - How to enable it
  - Technical tour
  - Runtime status
  - Scope
  - Terms
  - Configuration
  - Activation
  - Model-visible tools
    _... and 27 more headings_

- **[Device model database](https://docs.openclaw.ai/reference/device-models)**
  - Data source
  - Updating the database
  - Related

### Codex harness

- **[Codex harness reference](https://docs.openclaw.ai/plugins/codex-harness-reference)**
  - Plugin config surface
  - App-server transport
  - Approval and sandbox modes
  - Sandboxed native execution
  - Auth and environment isolation
  - Dynamic tools
  - Timeouts
  - Model discovery
  - Workspace bootstrap files
  - Environment overrides
    _... and 1 more headings_

- **[Codex harness runtime](https://docs.openclaw.ai/plugins/codex-harness-runtime)**
  - Overview
  - Thread bindings and model changes
  - Visible replies and heartbeats
  - Hook boundaries
  - V1 support contract
  - Native permissions and MCP elicitations
  - Queue steering
  - Codex feedback upload
  - Compaction and transcript mirror
  - Media and delivery
    _... and 1 more headings_

### Plugin reference

- **[Plugin inventory](https://docs.openclaw.ai/plugins/plugin-inventory)**
  - Definitions
  - Install a plugin
  - Core npm package
  - Official external packages
  - Source checkout only

- **[Plugin reference](https://docs.openclaw.ai/plugins/reference)**

- **[Plugin dependency resolution](https://docs.openclaw.ai/plugins/dependency-resolution)**
  - Responsibility split
  - Install roots
  - Local plugins
  - Startup and reload
  - Bundled plugins
  - Legacy cleanup

- **[Plugin install overrides](https://docs.openclaw.ai/plugins/install-overrides)**
  - Environment
  - Behavior
  - Package E2E

### Plugin SDK reference

- **[Plugin SDK overview](https://docs.openclaw.ai/plugins/sdk-overview)**
  - Import convention
  - Subpath reference
  - Registration API
    - Capability registration
    - Tools and commands
    - Infrastructure
    - Host hooks for workflow plugins
    - Gateway discovery registration
    - CLI registration metadata
    - CLI backend registration
      _... and 7 more headings_

- **[Plugin SDK subpaths](https://docs.openclaw.ai/plugins/sdk-subpaths)**
  - Plugin entry
    - Deprecated compatibility and test helpers
    - Reserved bundled plugin helper subpaths
  - Related

- **[Plugin entry points](https://docs.openclaw.ai/plugins/sdk-entrypoints)**
  - `defineToolPlugin`
  - `definePluginEntry`
  - `defineChannelPluginEntry`
  - `defineSetupPluginEntry`
  - Registration mode
  - Plugin shapes
  - Related

- **[Plugin runtime helpers](https://docs.openclaw.ai/plugins/sdk-runtime)**
  - Config loading and writes
  - Reusable runtime utilities
  - Runtime namespaces
  - Storing runtime references
  - Other top-level `api` fields
  - Related

- **[Agent harness plugins](https://docs.openclaw.ai/plugins/sdk-agent-harness)**
  - When to use a harness
  - What core still owns
  - Register a harness
  - Selection policy
  - Provider plus harness pairing
    - Tool-result middleware
    - Terminal outcome classification
    - Native Codex harness mode
  - Runtime strictness
  - Native sessions and transcript mirror
    _... and 3 more headings_

- **[Plugin setup and config](https://docs.openclaw.ai/plugins/sdk-setup)**
  - Package metadata
    - `openclaw` fields
    - `openclaw.channel`
    - `openclaw.install`
    - Deferred full load
  - Plugin manifest
  - ClawHub publishing
  - Setup entry
    - Narrow setup helper imports
    - Channel-owned single-account promotion
      _... and 5 more headings_

- **[Plugin testing](https://docs.openclaw.ai/plugins/sdk-testing)**
  - Test utilities
    - Available exports
    - Types
  - Testing target resolution
  - Testing patterns
    - Testing registration contracts
    - Testing runtime config access
    - Unit testing a channel plugin
    - Unit testing a provider plugin
    - Mocking the plugin runtime
      _... and 6 more headings_

- **[Plugin manifest](https://docs.openclaw.ai/plugins/manifest)**
  - What this file does
  - Minimal example
  - Rich example
  - Top-level field reference
  - Generation provider metadata reference
  - Tool metadata reference
  - providerAuthChoices reference
  - commandAliases reference
  - activation reference
  - qaRunners reference
    _... and 23 more headings_

### Plugin maintainer reference

- **[Plugin internals](https://docs.openclaw.ai/plugins/architecture)**
  - Public capability model
    - External compatibility stance
    - Plugin shapes
    - Legacy hooks
    - Compatibility signals
  - Architecture overview
    - Plugin metadata snapshot and lookup table
    - Activation planning
    - Channel plugins and the shared message tool
  - Capability ownership model
    _... and 9 more headings_

- **[Plugin architecture internals](https://docs.openclaw.ai/plugins/architecture-internals)**
  - Load pipeline
    - Manifest-first behavior
    - Plugin cache boundary
  - Registry model
  - Conversation binding callbacks
  - Provider runtime hooks
    - Hook order and usage
    - Provider example
    - Built-in examples
  - Runtime helpers
    _... and 15 more headings_

- **[Plugin SDK migration](https://docs.openclaw.ai/plugins/sdk-migration)**
  - What is changing
  - Why this changed
  - Talk and realtime voice migration plan
  - Compatibility policy
  - How to migrate
  - Import path reference
  - Active deprecations
  - Removal timeline
  - Suppressing the warnings temporarily
  - Related

- **[Plugin compatibility](https://docs.openclaw.ai/plugins/compatibility)**
  - Compatibility registry
  - Plugin inspector package
    - Maintainer acceptance lane
  - Deprecation policy
  - Current compatibility areas
    - WhatsApp Inbound Callback Flat Aliases
    - WhatsApp Inbound Admission Fields
  - Release notes

- **[Channel outbound API](https://docs.openclaw.ai/plugins/sdk-channel-outbound)**
  - Adapter
  - Existing Outbound Adapters
  - Durable Sends
  - Compatibility Dispatch

- **[Channel inbound API](https://docs.openclaw.ai/plugins/sdk-channel-inbound)**
  - Core Helpers
  - Migration

- **[Channel ingress API](https://docs.openclaw.ai/plugins/sdk-channel-ingress)**
  - Runtime Resolver
  - Result
  - Access Groups
  - Event Modes
  - Routes And Activation
  - Redaction
  - Verification

- **[Message presentation](https://docs.openclaw.ai/plugins/message-presentation)**
  - Contract
  - Producer examples
  - Renderer contract
  - Core render flow
  - Degradation rules
  - Provider mapping
  - Presentation vs InteractiveReply
  - Delivery pin
  - Plugin author checklist
  - Related docs

### Templates

- **[Default AGENTS.md](https://docs.openclaw.ai/reference/AGENTS.default)**
  - First run (recommended)
  - Safety defaults
  - Session start (required)
  - Soul (required)
  - Shared spaces (recommended)
  - Memory system (recommended)
  - Tools and skills
  - Backup tip (recommended)
  - What OpenClaw does
  - Core skills (enable in Settings → Skills)
    _... and 2 more headings_

- **[AGENTS.md template](https://docs.openclaw.ai/reference/templates/AGENTS)**
  - First Run
  - Session Startup
  - Memory
    - 🧠 MEMORY.md - Your Long-Term Memory
    - 📝 Write It Down - No "Mental Notes"!
  - Red Lines
  - External vs Internal
  - Group Chats
    - 💬 Know When to Speak!
    - 😊 React Like a Human!
      _... and 6 more headings_

- **[BOOT.md template](https://docs.openclaw.ai/reference/templates/BOOT)**
  - Related

- **[BOOTSTRAP.md template](https://docs.openclaw.ai/reference/templates/BOOTSTRAP)**
  - The Conversation
  - After You Know Who You Are
  - Connect (Optional)
  - When you are done
  - Related

- **[HEARTBEAT.md template](https://docs.openclaw.ai/reference/templates/HEARTBEAT)**
  - Related

- **[IDENTITY template](https://docs.openclaw.ai/reference/templates/IDENTITY)**
  - Related

- **[SOUL.md template](https://docs.openclaw.ai/reference/templates/SOUL)**
  - Core Truths
  - Boundaries
  - Vibe
  - Continuity
  - Related

- **[TOOLS.md template](https://docs.openclaw.ai/reference/templates/TOOLS)**
  - What Goes Here
  - Examples
    - Cameras
    - SSH
    - TTS
  - Why Separate?
  - Related

- **[USER template](https://docs.openclaw.ai/reference/templates/USER)**
  - Context
  - Related

### Technical reference

- **[Agent runtime architecture](https://docs.openclaw.ai/agent-runtime-architecture)**
  - Runtime Layout
  - Boundaries
  - Manifests
  - Runtime Selection
  - Related

- **[Onboarding reference](https://docs.openclaw.ai/reference/wizard)**
  - Flow details (local mode)
  - Non-interactive mode
    - Add agent (non-interactive)
  - Gateway wizard RPC
  - Signal setup (signal-cli)
  - What the wizard writes
  - Related docs

- **[Token use and costs](https://docs.openclaw.ai/reference/token-use)**
  - How the system prompt is built
  - What counts in the context window
  - How to see current token usage
  - Cost estimation (when shown)
  - Cache TTL and pruning impact
    - Example: keep 1h cache warm with heartbeat
    - Example: mixed traffic with per-agent cache strategy
    - Anthropic 1M context
  - Tips for reducing token pressure
  - Related

- **[SecretRef credential surface](https://docs.openclaw.ai/reference/secretref-credential-surface)**
  - Supported credentials
    - `openclaw.json` targets (`secrets configure` + `secrets apply` + `secrets audit`)
    - `auth-profiles.json` targets (`secrets configure` + `secrets apply` + `secrets audit`)
  - Unsupported credentials
  - Related

- **[Prompt caching](https://docs.openclaw.ai/reference/prompt-caching)**
  - Primary knobs
    - `cacheRetention` (global default, model, and per-agent)
    - `contextPruning.mode: "cache-ttl"`
    - Heartbeat keep-warm
  - Provider behavior
    - Anthropic (direct API)
    - OpenAI (direct API)
    - Anthropic Vertex
    - Amazon Bedrock
    - OpenRouter models
      _... and 17 more headings_

- **[API usage and costs](https://docs.openclaw.ai/reference/api-usage-costs)**
  - Where costs show up (chat + CLI)
  - How keys are discovered
  - Features that can spend keys
    - 1. Core model responses (chat + tools)
    - 2. Media understanding (audio/image/video)
    - 3. Image and video generation
    - 4. Memory embeddings + semantic search
    - 5. Web search tool
    - 5. Web fetch tool (Firecrawl)
    - 6. Provider usage snapshots (status/health)
         _... and 5 more headings_

- **[Transcript hygiene](https://docs.openclaw.ai/reference/transcript-hygiene)**
  - Global rule: runtime context is not user transcript
  - Where this runs
  - Global rule: image sanitization
  - Global rule: malformed tool calls
  - Global rule: incomplete reasoning-only turns
  - Global rule: inter-session input provenance
  - Provider matrix (current behavior)
  - Historical behavior (pre-2026.1.22)
  - Related

- **[Memory configuration reference](https://docs.openclaw.ai/reference/memory-config)**
  - Provider selection
    - Custom provider ids
    - API key resolution
  - Remote endpoint config
  - Provider-specific config
    - Inline embedding timeout
  - Hybrid search config
    - Full example
  - Additional memory paths
  - Multimodal memory (Gemini)
    _... and 11 more headings_

- **[Rich output protocol](https://docs.openclaw.ai/reference/rich-output-protocol)**
  - `[embed ...]`
  - Stored rendering shape
  - Related

- **[Session management deep dive](https://docs.openclaw.ai/reference/session-management-compaction)**
  - Source of truth: the Gateway
  - Two persistence layers
  - On-disk locations
  - Store maintenance and disk controls
  - Cron sessions and run logs
  - Session keys (`sessionKey`)
  - Session ids (`sessionId`)
  - Session store schema (`sessions.json`)
  - Transcript structure (`*.jsonl`)
  - Context windows vs tracked tokens
    _... and 10 more headings_

- **[Date and time](https://docs.openclaw.ai/date-time)**
  - Message envelopes (local by default)
    - Examples
  - System prompt: current date and time
  - System event lines (local by default)
    - Configure user timezone + format
  - Time format detection (auto)
  - Tool payloads + connectors (raw provider time + normalized fields)
  - Related docs

### Concept internals

- **[TypeBox](https://docs.openclaw.ai/concepts/typebox)**
  - Mental model (30 seconds)
  - Where the schemas live
  - Current pipeline
  - How the schemas are used at runtime
  - Example frames
  - Minimal client (Node.js)
  - Worked example: add a method end-to-end
  - Swift codegen behavior
  - Versioning + compatibility
  - Schema patterns and conventions
    _... and 3 more headings_

- **[Markdown formatting](https://docs.openclaw.ai/concepts/markdown-formatting)**
  - Goals
  - Pipeline
  - IR example
  - Where it is used
  - Table handling
  - Chunking rules
  - Link policy
  - Spoilers
  - How to add or update a channel formatter
  - Common gotchas
    _... and 1 more headings_

- **[Typing indicators](https://docs.openclaw.ai/concepts/typing-indicators)**
  - Defaults
  - Modes
  - Configuration
  - Notes
  - Related

- **[Usage tracking](https://docs.openclaw.ai/concepts/usage-tracking)**
  - What it is
  - Where it shows up
  - Custom `/usage full` footer
    - Shape
    - Contract Paths
    - Verbs
    - Piece forms
    - Example
  - Providers + credentials
  - Related

- **[Timezones](https://docs.openclaw.ai/concepts/timezone)**
  - Three timezone surfaces
  - Setting the user timezone
  - When to override
  - Related

### Project

- **[Application modernization plan](https://docs.openclaw.ai/reference/application-modernization-plan)**
  - Goal
  - Principles
  - Phase 1: Baseline audit
  - Phase 2: Product and UX cleanup
  - Phase 3: Frontend architecture tightening
  - Phase 4: Performance and reliability
  - Phase 5: Type, contract, and test hardening
  - Phase 6: Documentation and release readiness
  - Recommended first slice
  - Frontend skill update
    _... and 4 more headings_

- **[Credits](https://docs.openclaw.ai/reference/credits)**
  - The name
  - Credits
  - Core contributors
  - License
  - Related

### Release and CI

- **[Release policy](https://docs.openclaw.ai/reference/RELEASING)**
  - Version naming
  - Release cadence
  - Release operator checklist
  - Stable main closeout
  - Release preflight
  - Release test boxes
    - Vitest
    - Docker
    - QA Lab
    - Package
      _... and 5 more headings_

- **[Full release validation](https://docs.openclaw.ai/reference/full-release-validation)**
  - Top-level stages
  - Release checks stages
  - Docker release-path chunks
  - Release profiles
  - Full-only additions
  - Focused reruns
  - Evidence to keep
  - Workflow files

- **[Release performance sweep](https://docs.openclaw.ai/reference/release-performance-sweep)**
  - Snapshot
  - Install Footprint Timeline
  - What Changed In 5.28
  - Headline Numbers
    - Install footprint
    - npm package size
  - Kova agent turn summary
  - Source probes
  - Install footprint audit
    - Shrinkwrap boundary
      _... and 1 more headings_

- **[Tests](https://docs.openclaw.ai/reference/test)**
  - Local PR gate
  - Model latency bench (local keys)
  - CLI startup bench
  - Gateway startup bench
  - Gateway restart bench
  - Onboarding E2E (Docker)
  - QR import smoke (Docker)
  - Related

- **[CI pipeline](https://docs.openclaw.ai/ci)**
  - Pipeline overview
  - Fail-fast order
  - Real behavior proof
  - Scope and routing
  - ClawSweeper activity forwarding
  - Manual dispatches
  - Runners
  - Local equivalents
  - OpenClaw Performance
  - Full Release Validation
    _... and 25 more headings_

- **[Scripts](https://docs.openclaw.ai/help/scripts)**
  - Conventions
  - Auth monitoring scripts
  - GitHub read helper
  - When adding scripts
  - Related

## Help

### Start here

- **[Help](https://docs.openclaw.ai/help/index)**
  - FAQ
  - Diagnostics
  - Testing
  - Community and meta

- **[General troubleshooting](https://docs.openclaw.ai/help/troubleshooting)**
  - First 60 seconds
  - Assistant feels limited or missing tools
  - Anthropic long context 429
  - Local OpenAI-compatible backend works directly but fails in OpenClaw
  - Plugin install fails with missing openclaw extensions
  - Install policy blocks plugin installs or updates
  - Plugin present but blocked by suspicious ownership
  - Decision tree
  - Related

- **[Debugging](https://docs.openclaw.ai/help/debugging)**
  - Runtime debug overrides
  - Session trace output
  - Plugin lifecycle trace
  - CLI startup and command profiling
  - Gateway watch mode
  - Dev profile + dev gateway (--dev)
  - Raw stream logging (OpenClaw)
  - Raw OpenAI-compatible chunk logging
  - Safety notes
  - Debugging in VSCode
    _... and 3 more headings_

### FAQ

- **[FAQ](https://docs.openclaw.ai/help/faq)**
  - First 60 seconds if something is broken
  - Quick start and first-run setup
  - What is OpenClaw?
  - Skills and automation
  - Sandboxing and memory
  - Where things live on disk
  - Config basics
  - Remote gateways and nodes
  - Env vars and .env loading
  - Sessions and multiple chats
    _... and 8 more headings_

- **[FAQ: first-run setup](https://docs.openclaw.ai/help/faq-first-run)**
  - Quick start and first-run setup
  - Related

- **[FAQ: models and auth](https://docs.openclaw.ai/help/faq-models)**
  - Models: defaults, selection, aliases, switching
  - Model failover and "All models failed"
  - Auth profiles: what they are and how to manage them
  - Related

### Testing

- **[Testing](https://docs.openclaw.ai/help/testing)**
  - Quick start
  - Test Temp Directories
  - QA-specific runners
    - Shared Telegram credentials via Convex (v1)
    - Adding a channel to QA
  - Test suites (what runs where)
    - Unit / integration (default)
    - Stability (gateway)
    - E2E (repo aggregate)
    - E2E (gateway smoke)
      _... and 17 more headings_

- **[Testing: updates and plugins](https://docs.openclaw.ai/help/testing-updates-plugins)**
  - What we protect
  - Local proof during development
  - Docker lanes
  - Package Acceptance
  - Release default
  - Legacy compatibility
  - Adding coverage
  - Failure triage

- **[Testing: live suites](https://docs.openclaw.ai/help/testing-live)**
  - Live: local smoke commands
  - Live: Android node capability sweep
  - Live: model smoke (profile keys)
    - Layer 1: Direct model completion (no gateway)
    - Layer 2: Gateway + dev agent smoke (what "@openclaw" actually does)
  - Live: CLI backend smoke (Claude, Gemini, or other local CLIs)
  - Live: APNs HTTP/2 proxy reachability
  - Live: ACP bind smoke (`/acp spawn ... --bind here`)
  - Live: Codex app-server harness smoke
    - Recommended live recipes
      _... and 14 more headings_

### Diagnostics

- **[Environment variables](https://docs.openclaw.ai/help/environment)**
  - Precedence (highest → lowest)
  - Provider credentials and workspace `.env`
  - Config `env` block
  - Shell env import
  - Exec shell snapshots
  - Runtime-injected env vars
  - UI env vars
  - Env var substitution in config
  - Secret refs vs `${ENV}` strings
  - Path-related env vars
    _... and 5 more headings_

- **[Diagnostics flags](https://docs.openclaw.ai/diagnostics/flags)**
  - How it works
  - Enable via config
  - Env override (one-off)
  - Profiling flags
  - Timeline artifacts
  - Where logs go
  - Extract logs
  - Notes
  - Related

- **[Node + tsx crash](https://docs.openclaw.ai/debug/node-issue)**
  - Summary
  - Environment
  - Repro (Node-only)
  - Minimal repro in repo
  - Node version check
  - Notes / hypothesis
  - Regression history
  - Workarounds
  - References
  - Next steps
    _... and 1 more headings_

### Community and meta

- **[OpenClaw lore](https://docs.openclaw.ai/start/lore)**
  - The Origin Story
  - The First Molt (January 27, 2026)
  - The Name
  - The Daleks vs The Lobsters
  - Key Characters
    - Molty 🦞
    - Peter 👨‍💻
  - The Moltiverse
  - The Great Incidents
    - The Directory Dump (Dec 3, 2025)
      _... and 8 more headings_

- **[Docs hubs](https://docs.openclaw.ai/start/hubs)**
  - Start here
  - Installation + updates
  - Core concepts
  - Providers + ingress
  - Gateway + operations
  - Tools + automation
  - Nodes, media, voice
  - Platforms
  - macOS companion app (advanced)
  - Plugins
    _... and 4 more headings_

- **[Docs directory](https://docs.openclaw.ai/start/docs-directory)**
  - Start here
  - Providers and UX
  - Companion apps
  - Operations and safety
  - Related

## Unindexed pages

> These pages exist in the repo but are not in the main navigation.

- **[Docs Guide](https://docs.openclaw.ai/AGENTS)**
  - Mintlify Rules
  - Docs Content Rules
  - Internal Docs
  - Docs i18n
- **[Docs Guide](https://docs.openclaw.ai/CLAUDE)**
  - Mintlify Rules
  - Docs Content Rules
  - Internal Docs
  - Docs i18n
- **[Brave search](https://docs.openclaw.ai/brave-search)**
  - Related
- **[Perplexity search](https://docs.openclaw.ai/perplexity)**
  - Related
- **[OpenClaw Documentation Map](https://docs.openclaw.ai/docs_map)**
  - Get started
    - Overview
    - First steps
    - Guides
  - Install
- **[Text-to-speech](https://docs.openclaw.ai/tts)**
  - Related
- **[Translation workflow](https://docs.openclaw.ai/.i18n/translation-workflow)**
  - Goals
  - Event flow
  - Debounce policy
  - Incremental translation
  - Artifact contract
- **[OpenClaw docs i18n assets](https://docs.openclaw.ai/.i18n/README)**
  - Source of truth
  - End-to-end flow
  - Why the split exists
  - Locale visibility
  - Files in this folder
- **[Secret Placeholder Conventions](https://docs.openclaw.ai/reference/secret-placeholder-conventions)**
  - Recommended style
  - Avoid these patterns in docs
  - Example
- **[USER.dev template](https://docs.openclaw.ai/reference/templates/USER.dev)**
  - Related
- **[SOUL.dev template](https://docs.openclaw.ai/reference/templates/SOUL.dev)**
  - Who I Am
  - My Purpose
  - How I Operate
  - My Quirks
  - My Relationship with Clawd
- **[AGENTS.md template](https://docs.openclaw.ai/reference/templates/CLAUDE)**
  - First Run
  - Session Startup
  - Memory
    - 🧠 MEMORY.md - Your Long-Term Memory
    - 📝 Write It Down - No "Mental Notes"!
- **[TOOLS.dev template](https://docs.openclaw.ai/reference/templates/TOOLS.dev)**
  - Examples
    - imsg
    - sag
  - Related
- **[IDENTITY.dev template](https://docs.openclaw.ai/reference/templates/IDENTITY.dev)**
  - Role
  - Soul
  - Relationship with Clawd
  - Quirks
  - Catchphrase
- **[AGENTS.dev template](https://docs.openclaw.ai/reference/templates/AGENTS.dev)**
  - First run (one-time)
  - Backup tip (recommended)
  - Safety defaults
  - Daily memory (recommended)
  - Heartbeats (optional)
- **[Claw Supervisor](https://docs.openclaw.ai/specs/claw-supervisor)**
  - Goal
  - Product Model
  - Architecture
  - Codex App-Server Contract
  - Session Registry
- **[Generated Docs Artifacts](https://docs.openclaw.ai/.generated/README)**
- **[Incident response](https://docs.openclaw.ai/security/incident-response)**
  - 1. Detection and triage
  - 2. Assessment
  - 3. Response
  - 4. Communication
  - 5. Recovery and follow-up
- **[Registering tools](https://docs.openclaw.ai/plugins/agent-tools)**
  - Related
- **[Channel turn](https://docs.openclaw.ai/plugins/sdk-channel-turn)**
- **[Channel message API](https://docs.openclaw.ai/plugins/sdk-channel-message)**
- **[Copilot SDK harness](https://docs.openclaw.ai/plugins/copilot)**
  - Requirements
  - Plugin install
  - Quickstart
  - Supported providers
  - Auth
- **[Building plugins (redirect)](https://docs.openclaw.ai/plugins/building-extensions)**
  - Related
- **[SearXNG plugin](https://docs.openclaw.ai/plugins/reference/searxng)**
  - Distribution
  - Surface
- **[ComfyUI plugin](https://docs.openclaw.ai/plugins/reference/comfy)**
  - Distribution
  - Surface
  - Related docs
- **[Google plugin](https://docs.openclaw.ai/plugins/reference/google)**
  - Distribution
  - Surface
  - Related docs
- **[Moonshot plugin](https://docs.openclaw.ai/plugins/reference/moonshot)**
  - Distribution
  - Surface
  - Related docs
- **[Openshell plugin](https://docs.openclaw.ai/plugins/reference/openshell)**
  - Distribution
  - Surface
- **[OpenAI plugin](https://docs.openclaw.ai/plugins/reference/openai)**
  - Distribution
  - Surface
  - Related docs
- **[StepFun plugin](https://docs.openclaw.ai/plugins/reference/stepfun)**
  - Distribution
  - Surface
  - Related docs
- **[Gmi plugin](https://docs.openclaw.ai/plugins/reference/gmi)**
  - Distribution
  - Surface
  - Related docs
- **[LINE plugin](https://docs.openclaw.ai/plugins/reference/line)**
  - Distribution
  - Surface
  - Related docs
- **[Zalo Personal plugin](https://docs.openclaw.ai/plugins/reference/zalouser)**
  - Distribution
  - Surface
  - Related docs
- **[Synthetic plugin](https://docs.openclaw.ai/plugins/reference/synthetic)**
  - Distribution
  - Surface
  - Related docs
- **[Diagnostics OpenTelemetry plugin](https://docs.openclaw.ai/plugins/reference/diagnostics-otel)**
  - Distribution
  - Surface
- **[Slack plugin](https://docs.openclaw.ai/plugins/reference/slack)**
  - Distribution
  - Surface
  - Related docs
- **[LLM Task plugin](https://docs.openclaw.ai/plugins/reference/llm-task)**
  - Distribution
  - Surface
- **[File Transfer plugin](https://docs.openclaw.ai/plugins/reference/file-transfer)**
  - Distribution
  - Surface
- **[Diffs plugin](https://docs.openclaw.ai/plugins/reference/diffs)**
  - Distribution
  - Surface
- **[Admin Http Rpc plugin](https://docs.openclaw.ai/plugins/reference/admin-http-rpc)**
  - Distribution
  - Surface
  - Related docs
- **[Clickclack plugin](https://docs.openclaw.ai/plugins/reference/clickclack)**
  - Distribution
  - Surface
  - Related docs
- **[Exa plugin](https://docs.openclaw.ai/plugins/reference/exa)**
  - Distribution
  - Surface
  - Related docs
- **[LiteLLM plugin](https://docs.openclaw.ai/plugins/reference/litellm)**
  - Distribution
  - Surface
  - Related docs
- **[QA Channel plugin](https://docs.openclaw.ai/plugins/reference/qa-channel)**
  - Distribution
  - Surface
  - Related docs
- **[Qianfan plugin](https://docs.openclaw.ai/plugins/reference/qianfan)**
  - Distribution
  - Surface
  - Related docs
- **[PixVerse plugin](https://docs.openclaw.ai/plugins/reference/pixverse)**
  - Distribution
  - Surface
  - Related docs
- **[Groq plugin](https://docs.openclaw.ai/plugins/reference/groq)**
  - Distribution
  - Surface
  - Related docs
- **[Azure Speech plugin](https://docs.openclaw.ai/plugins/reference/azure-speech)**
  - Distribution
  - Surface
  - Related docs
- **[DuckDuckGo plugin](https://docs.openclaw.ai/plugins/reference/duckduckgo)**
  - Distribution
  - Surface
  - Related docs
- **[Web Readability plugin](https://docs.openclaw.ai/plugins/reference/web-readability)**
  - Distribution
  - Surface
- **[Firecrawl plugin](https://docs.openclaw.ai/plugins/reference/firecrawl)**
  - Distribution
  - Surface
  - Related docs
- **[Webhooks plugin](https://docs.openclaw.ai/plugins/reference/webhooks)**
  - Distribution
  - Surface
  - Related docs
- **[Signal plugin](https://docs.openclaw.ai/plugins/reference/signal)**
  - Distribution
  - Surface
  - Related docs
- **[Migrate Hermes plugin](https://docs.openclaw.ai/plugins/reference/migrate-hermes)**
  - Distribution
  - Surface
- **[Bonjour plugin](https://docs.openclaw.ai/plugins/reference/bonjour)**
  - Distribution
  - Surface
- **[Xiaomi plugin](https://docs.openclaw.ai/plugins/reference/xiaomi)**
  - Distribution
  - Surface
  - Related docs
- **[Anthropic Vertex plugin](https://docs.openclaw.ai/plugins/reference/anthropic-vertex)**
  - Distribution
  - Surface
  - Claude Fable 5
- **[DeepInfra plugin](https://docs.openclaw.ai/plugins/reference/deepinfra)**
  - Distribution
  - Surface
  - Related docs
- **[Twitch plugin](https://docs.openclaw.ai/plugins/reference/twitch)**
  - Distribution
  - Surface
  - Related docs
- **[SGLang plugin](https://docs.openclaw.ai/plugins/reference/sglang)**
  - Distribution
  - Surface
  - Related docs
- **[DeepSeek plugin](https://docs.openclaw.ai/plugins/reference/deepseek)**
  - Distribution
  - Surface
  - Related docs
- **[Deepgram plugin](https://docs.openclaw.ai/plugins/reference/deepgram)**
  - Distribution
  - Surface
  - Related docs
- **[Mistral plugin](https://docs.openclaw.ai/plugins/reference/mistral)**
  - Distribution
  - Surface
  - Related docs
- **[MiniMax plugin](https://docs.openclaw.ai/plugins/reference/minimax)**
  - Distribution
  - Surface
  - Related docs
- **[Amazon Bedrock Mantle plugin](https://docs.openclaw.ai/plugins/reference/amazon-bedrock-mantle)**
  - Distribution
  - Surface
  - Related docs
- **[Senseaudio plugin](https://docs.openclaw.ai/plugins/reference/senseaudio)**
  - Distribution
  - Surface
  - Related docs
- **[Telegram plugin](https://docs.openclaw.ai/plugins/reference/telegram)**
  - Distribution
  - Surface
  - Related docs
- **[Cloudflare AI Gateway plugin](https://docs.openclaw.ai/plugins/reference/cloudflare-ai-gateway)**
  - Distribution
  - Surface
  - Related docs
- **[Tlon plugin](https://docs.openclaw.ai/plugins/reference/tlon)**
  - Distribution
  - Surface
  - Related docs
- **[Canvas plugin](https://docs.openclaw.ai/plugins/reference/canvas)**
  - Distribution
  - Surface
- **[Diagnostics Prometheus plugin](https://docs.openclaw.ai/plugins/reference/diagnostics-prometheus)**
  - Distribution
  - Surface
- **[Policy plugin](https://docs.openclaw.ai/plugins/reference/policy)**
  - Distribution
  - Surface
  - Behavior
  - Related docs
- **[Feishu plugin](https://docs.openclaw.ai/plugins/reference/feishu)**
  - Distribution
  - Surface
  - Related docs
- **[GitHub Copilot plugin](https://docs.openclaw.ai/plugins/reference/github-copilot)**
  - Distribution
  - Surface
  - Related docs
- **[Workboard plugin](https://docs.openclaw.ai/plugins/reference/workboard)**
  - Distribution
  - Surface
  - Related docs
- **[Alibaba plugin](https://docs.openclaw.ai/plugins/reference/alibaba)**
  - Distribution
  - Surface
  - Related docs
- **[Qwen plugin](https://docs.openclaw.ai/plugins/reference/qwen)**
  - Distribution
  - Surface
  - Related docs
- **[ACPx plugin](https://docs.openclaw.ai/plugins/reference/acpx)**
  - Distribution
  - Surface
  - Related docs
- **[Novita plugin](https://docs.openclaw.ai/plugins/reference/novita)**
  - Distribution
  - Surface
  - Related docs
- **[Microsoft Teams plugin](https://docs.openclaw.ai/plugins/reference/msteams)**
  - Distribution
  - Surface
  - Related docs
- **[Memory Wiki plugin](https://docs.openclaw.ai/plugins/reference/memory-wiki)**
  - Distribution
  - Surface
  - Related docs
- **[Vydra plugin](https://docs.openclaw.ai/plugins/reference/vydra)**
  - Distribution
  - Surface
  - Related docs
- **[TTS Local CLI plugin](https://docs.openclaw.ai/plugins/reference/tts-local-cli)**
  - Distribution
  - Surface
- **[Inworld plugin](https://docs.openclaw.ai/plugins/reference/inworld)**
  - Distribution
  - Surface
  - Related docs
- **[LM Studio plugin](https://docs.openclaw.ai/plugins/reference/lmstudio)**
  - Distribution
  - Surface
  - Related docs
- **[Microsoft Foundry plugin](https://docs.openclaw.ai/plugins/reference/microsoft-foundry)**
  - Distribution
  - Surface
  - Requirements
  - Chat models
  - MAI image generation
- **[OpenCode plugin](https://docs.openclaw.ai/plugins/reference/opencode)**
  - Distribution
  - Surface
  - Related docs
- **[Discord plugin](https://docs.openclaw.ai/plugins/reference/discord)**
  - Distribution
  - Surface
  - Related docs
- **[Nextcloud Talk plugin](https://docs.openclaw.ai/plugins/reference/nextcloud-talk)**
  - Distribution
  - Surface
  - Related docs
- **[Cohere plugin](https://docs.openclaw.ai/plugins/reference/cohere)**
  - Distribution
  - Surface
  - Related docs
- **[IRC plugin](https://docs.openclaw.ai/plugins/reference/irc)**
  - Distribution
  - Surface
  - Related docs
- **[Vercel AI Gateway plugin](https://docs.openclaw.ai/plugins/reference/vercel-ai-gateway)**
  - Distribution
  - Surface
  - Related docs
- **[BytePlus plugin](https://docs.openclaw.ai/plugins/reference/byteplus)**
  - Distribution
  - Surface
- **[Migrate Claude plugin](https://docs.openclaw.ai/plugins/reference/migrate-claude)**
  - Distribution
  - Surface
- **[Zalo plugin](https://docs.openclaw.ai/plugins/reference/zalo)**
  - Distribution
  - Surface
  - Related docs
- **[OpenCode Go plugin](https://docs.openclaw.ai/plugins/reference/opencode-go)**
  - Distribution
  - Surface
  - Related docs
- **[Codex Supervisor plugin](https://docs.openclaw.ai/plugins/reference/codex-supervisor)**
  - Distribution
  - Surface
  - Session Listing
- **[Lobster plugin](https://docs.openclaw.ai/plugins/reference/lobster)**
  - Distribution
  - Surface
- **[Kimi plugin](https://docs.openclaw.ai/plugins/reference/kimi)**
  - Distribution
  - Surface
  - Related docs
- **[Tencent plugin](https://docs.openclaw.ai/plugins/reference/tencent)**
  - Distribution
  - Surface
  - Related docs
- **[Hugging Face plugin](https://docs.openclaw.ai/plugins/reference/huggingface)**
  - Distribution
  - Surface
  - Related docs
- **[Runway plugin](https://docs.openclaw.ai/plugins/reference/runway)**
  - Distribution
  - Surface
  - Related docs
- **[Document Extract plugin](https://docs.openclaw.ai/plugins/reference/document-extract)**
  - Distribution
  - Surface
  - Related docs
- **[Anthropic plugin](https://docs.openclaw.ai/plugins/reference/anthropic)**
  - Distribution
  - Surface
  - Related docs
- **[Synology Chat plugin](https://docs.openclaw.ai/plugins/reference/synology-chat)**
  - Distribution
  - Surface
  - Related docs
- **[Kilocode plugin](https://docs.openclaw.ai/plugins/reference/kilocode)**
  - Distribution
  - Surface
  - Related docs
- **[Open Prose plugin](https://docs.openclaw.ai/plugins/reference/open-prose)**
  - Distribution
  - Surface
- **[Diffs Language Pack plugin](https://docs.openclaw.ai/plugins/reference/diffs-language-pack)**
  - Distribution
  - Surface
  - Added languages
- **[Chutes plugin](https://docs.openclaw.ai/plugins/reference/chutes)**
  - Distribution
  - Surface
  - Related docs
- **[Together plugin](https://docs.openclaw.ai/plugins/reference/together)**
  - Distribution
  - Surface
  - Related docs
- **[Google Meet plugin](https://docs.openclaw.ai/plugins/reference/google-meet)**
  - Distribution
  - Surface
  - Related docs
- **[Venice plugin](https://docs.openclaw.ai/plugins/reference/venice)**
  - Distribution
  - Surface
  - Related docs
- **[Copilot Proxy plugin](https://docs.openclaw.ai/plugins/reference/copilot-proxy)**
  - Distribution
  - Surface
- **[vLLM plugin](https://docs.openclaw.ai/plugins/reference/vllm)**
  - Distribution
  - Surface
  - Related docs
- **[Memory Lancedb plugin](https://docs.openclaw.ai/plugins/reference/memory-lancedb)**
  - Distribution
  - Surface
  - Related docs
- **[Microsoft plugin](https://docs.openclaw.ai/plugins/reference/microsoft)**
  - Distribution
  - Surface
- **[Codex plugin](https://docs.openclaw.ai/plugins/reference/codex)**
  - Distribution
  - Surface
  - Related docs
- **[NVIDIA plugin](https://docs.openclaw.ai/plugins/reference/nvidia)**
  - Distribution
  - Surface
  - Related docs
- **[Voyage plugin](https://docs.openclaw.ai/plugins/reference/voyage)**
  - Distribution
  - Surface
- **[Copilot plugin](https://docs.openclaw.ai/plugins/reference/copilot)**
  - Distribution
  - Surface
  - Related docs
- **[Tokenjuice plugin](https://docs.openclaw.ai/plugins/reference/tokenjuice)**
  - Distribution
  - Surface
  - Related docs
- **[Sms plugin](https://docs.openclaw.ai/plugins/reference/sms)**
  - Distribution
  - Surface
  - Related docs
- **[Elevenlabs plugin](https://docs.openclaw.ai/plugins/reference/elevenlabs)**
  - Distribution
  - Surface
  - Related docs
- **[QA Lab plugin](https://docs.openclaw.ai/plugins/reference/qa-lab)**
  - Distribution
  - Surface
- **[Ollama plugin](https://docs.openclaw.ai/plugins/reference/ollama)**
  - Distribution
  - Surface
  - Related docs
- **[Arcee plugin](https://docs.openclaw.ai/plugins/reference/arcee)**
  - Distribution
  - Surface
  - Related docs
- **[Perplexity plugin](https://docs.openclaw.ai/plugins/reference/perplexity)**
  - Distribution
  - Surface
  - Related docs
- **[xAI plugin](https://docs.openclaw.ai/plugins/reference/xai)**
  - Distribution
  - Surface
  - Related docs
- **[Google Chat plugin](https://docs.openclaw.ai/plugins/reference/googlechat)**
  - Distribution
  - Surface
  - Related docs
- **[Amazon Bedrock plugin](https://docs.openclaw.ai/plugins/reference/amazon-bedrock)**
  - Distribution
  - Surface
  - Related docs
- **[Tavily plugin](https://docs.openclaw.ai/plugins/reference/tavily)**
  - Distribution
  - Surface
  - Related docs
- **[Mattermost plugin](https://docs.openclaw.ai/plugins/reference/mattermost)**
  - Distribution
  - Surface
  - Related docs
- **[QA Matrix plugin](https://docs.openclaw.ai/plugins/reference/qa-matrix)**
  - Distribution
  - Surface
- **[Voice Call plugin](https://docs.openclaw.ai/plugins/reference/voice-call)**
  - Distribution
  - Surface
  - Related docs
- **[iMessage plugin](https://docs.openclaw.ai/plugins/reference/imessage)**
  - Distribution
  - Surface
  - Related docs
- **[Z.AI plugin](https://docs.openclaw.ai/plugins/reference/zai)**
  - Distribution
  - Surface
  - Related docs
- **[QQ Bot plugin](https://docs.openclaw.ai/plugins/reference/qqbot)**
  - Distribution
  - Surface
  - Related docs
- **[Llama Cpp plugin](https://docs.openclaw.ai/plugins/reference/llama-cpp)**
  - Distribution
  - Surface
  - Related docs
- **[OpenRouter plugin](https://docs.openclaw.ai/plugins/reference/openrouter)**
  - Distribution
  - Surface
  - Related docs
- **[Cerebras plugin](https://docs.openclaw.ai/plugins/reference/cerebras)**
  - Distribution
  - Surface
  - Related docs
- **[Oc Path plugin](https://docs.openclaw.ai/plugins/reference/oc-path)**
  - Distribution
  - Surface
  - Related docs
- **[Nostr plugin](https://docs.openclaw.ai/plugins/reference/nostr)**
  - Distribution
  - Surface
  - Related docs
- **[Browser plugin](https://docs.openclaw.ai/plugins/reference/browser)**
  - Distribution
  - Surface
  - Related docs
- **[Brave plugin](https://docs.openclaw.ai/plugins/reference/brave)**
  - Distribution
  - Surface
  - Related docs
- **[Gradium plugin](https://docs.openclaw.ai/plugins/reference/gradium)**
  - Distribution
  - Surface
  - Related docs
- **[WhatsApp plugin](https://docs.openclaw.ai/plugins/reference/whatsapp)**
  - Distribution
  - Surface
  - Related docs
- **[Fireworks plugin](https://docs.openclaw.ai/plugins/reference/fireworks)**
  - Distribution
  - Surface
  - Related docs
- **[fal plugin](https://docs.openclaw.ai/plugins/reference/fal)**
  - Distribution
  - Surface
  - Related docs
- **[Matrix plugin](https://docs.openclaw.ai/plugins/reference/matrix)**
  - Distribution
  - Surface
  - Related docs
- **[Memory Core plugin](https://docs.openclaw.ai/plugins/reference/memory-core)**
  - Distribution
  - Surface
- **[Volcengine plugin](https://docs.openclaw.ai/plugins/reference/volcengine)**
  - Distribution
  - Surface
  - Related docs
- **[Quick start](https://docs.openclaw.ai/start/quickstart)**
  - Related
- **[DigitalOcean (platform)](https://docs.openclaw.ai/platforms/digitalocean)**
  - Related
- **[Oracle Cloud (platform)](https://docs.openclaw.ai/platforms/oracle)**
  - Related
- **[Raspberry Pi (platform)](https://docs.openclaw.ai/platforms/raspberry-pi)**
  - Related
- **[Channel presentation refactor plan](https://docs.openclaw.ai/plan/ui-channels)**
  - Status
  - Problem
  - Goals
  - Non goals
  - Target model
- **[Codex Harness Context Engine Port](https://docs.openclaw.ai/plan/codex-context-engine-harness)**
  - Status
  - Goal
  - Non-goals
  - Current architecture
  - Current gap
- **[ClickClack](https://docs.openclaw.ai/channels/clickclack)**
  - Quick setup
  - Multiple bots
  - Targets
  - Permissions
  - Troubleshooting
- **[Bot loop protection](https://docs.openclaw.ai/channels/bot-loop-protection)**
  - Defaults
  - Configure shared defaults
  - Override per channel or account
  - Channel support
- **[SMS](https://docs.openclaw.ai/channels/sms)**
  - Before you begin
  - Quick Setup
  - Configuration Examples
    - Config file
    - Environment variables
- **[Channel access cleanup](https://docs.openclaw.ai/refactor/access)**
- **[Ingress core deletion plan](https://docs.openclaw.ai/refactor/ingress-core)**
  - Budget
  - Diagnosis
  - Hotspots
  - Current Code Read
  - Boundary
- **[Canvas plugin refactor](https://docs.openclaw.ai/refactor/canvas)**
  - Goal
  - Non-goals
  - Current branch state
  - Target shape
  - Migration steps
- **[Database-first state refactor](https://docs.openclaw.ai/refactor/database-first)**
  - Decision
  - Hard Contract
  - Goal state and progress
    - Hard goal
    - Goal states
- **[ACP lifecycle refactor](https://docs.openclaw.ai/refactor/acp)**
  - Goals
  - Non-goals
  - Target Model
    - Gateway Instance Identity
    - ACP Session Ownership
- **[Network model](https://docs.openclaw.ai/gateway/network-model)**
  - Related
- **[Mantis Slack desktop runbook](https://docs.openclaw.ai/concepts/mantis-slack-desktop-runbook)**
  - Storage model
  - GitHub dispatch
  - Local CLI
  - Hydrate modes
  - Timing interpretation
- **[Mantis](https://docs.openclaw.ai/concepts/mantis)**
  - Goals
  - Non goals
  - Ownership
  - Command shape
  - Run lifecycle
- **[Polls](https://docs.openclaw.ai/automation/poll)**
  - Related
- **[ClawFlow](https://docs.openclaw.ai/automation/clawflow)**
  - Related
- **[Auth monitoring](https://docs.openclaw.ai/automation/auth-monitoring)**
  - Related
- **[Gmail PubSub](https://docs.openclaw.ai/automation/gmail-pubsub)**
  - Related
- **[Webhooks](https://docs.openclaw.ai/automation/webhook)**
  - Related
- **[Automation troubleshooting](https://docs.openclaw.ai/automation/troubleshooting)**
  - Related
- **[Cron vs heartbeat](https://docs.openclaw.ai/automation/cron-vs-heartbeat)**
  - Related
- **[Transcripts CLI](https://docs.openclaw.ai/cli/transcripts)**
  - Commands
  - Output
  - Many meetings per day
  - Missing summaries
  - Configuration
- **[Adding capabilities (redirect)](https://docs.openclaw.ai/tools/capability-cookbook)**
  - Related
- **[ClawHub (redirect)](https://docs.openclaw.ai/tools/clawhub)**
