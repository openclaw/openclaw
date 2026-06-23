---
summary: "Generated heading map for OpenClaw docs pages"
read_when: "Finding which docs page covers a topic before reading the page"
title: "Docs map"
---

# OpenClaw docs map

This file is generated from `docs/**/*.md` and `docs/**/*.mdx` headings to help agents navigate the documentation tree.
Do not edit it by hand; run `pnpm docs:map:gen`.

## agent-runtime-architecture.md
- Route: /agent-runtime-architecture
- Headings:
    - ## Runtime Layout
    - ## Boundaries
    - ## Manifests
    - ## Runtime Selection
    - ## Related

## announcements/bluebubbles-imessage.md
- Route: /announcements/bluebubbles-imessage
- Headings:
  - # BlueBubbles removal and the imsg iMessage path
    - ## What changed
    - ## What to do
    - ## Migration notes
    - ## See also

## auth-credential-semantics.md
- Route: /auth-credential-semantics
- Headings:
    - ## Stable probe reason codes
    - ## Token credentials
      - ### Eligibility rules
      - ### Resolution rules
    - ## Agent copy portability
    - ## Config-only auth routes
    - ## Explicit auth order filtering
    - ## Probe target resolution
    - ## External CLI credential discovery
    - ## OAuth SecretRef Policy Guard
    - ## Legacy-Compatible Messaging
    - ## Related

## automation/auth-monitoring.md
- Route: /automation/auth-monitoring
- Headings:
    - ## Related

## automation/clawflow.md
- Route: /automation/clawflow
- Headings:
    - ## Related

## automation/cron-jobs.md
- Route: /automation/cron-jobs
- Headings:
    - ## Quick start
    - ## How cron works
    - ## Schedule types
      - ### Day-of-month and day-of-week use OR logic
    - ## Execution styles
      - ### Command payloads
      - ### Payload options for isolated jobs
    - ## Delivery and output
    - ## Output language
    - ## CLI examples
    - ## Webhooks
      - ### Authentication
    - ## Gmail PubSub integration
      - ### Wizard setup (recommended)
      - ### Gateway auto-start
      - ### Manual one-time setup
      - ### Gmail model override
    - ## Managing jobs
    - ## Configuration
    - ## Troubleshooting
      - ### Command ladder
    - ## Related

## automation/cron-vs-heartbeat.md
- Route: /automation/cron-vs-heartbeat
- Headings:
    - ## Related

## automation/gmail-pubsub.md
- Route: /automation/gmail-pubsub
- Headings:
    - ## Related

## automation/hooks.md
- Route: /automation/hooks
- Headings:
    - ## Choose the right surface
    - ## Quick start
    - ## Event types
    - ## Writing hooks
      - ### Hook structure
      - ### HOOK.md format
      - ### Handler implementation
      - ### Event context highlights
    - ## Hook discovery
      - ### Hook packs
    - ## Bundled hooks
      - ### session-memory details
      - ### bootstrap-extra-files config
      - ### command-logger details
      - ### compaction-notifier details
      - ### boot-md details
    - ## Plugin hooks
    - ## Configuration
    - ## CLI reference
    - ## Best practices
    - ## Troubleshooting
      - ### Hook not discovered
      - ### Hook not eligible
      - ### Hook not executing
    - ## Related

## automation/index.md
- Route: /automation
- Headings:
    - ## Quick decision guide
      - ### Scheduled Tasks (Cron) vs Heartbeat
    - ## Core concepts
      - ### Scheduled tasks (cron)
      - ### Tasks
      - ### Inferred commitments
      - ### Task Flow
      - ### Standing orders
      - ### Hooks
      - ### Heartbeat
    - ## How they work together
    - ## Related

## automation/poll.md
- Route: /automation/poll
- Headings:
    - ## Related

## automation/standing-orders.md
- Route: /automation/standing-orders
- Headings:
    - ## Why standing orders
    - ## How they work
    - ## Anatomy of a standing order
    - ## Standing orders plus cron jobs
    - ## Examples
      - ### Example 1: content and social media (weekly cycle)
      - ### Example 2: finance operations (event-triggered)
      - ### Example 3: monitoring and alerts (continuous)
    - ## Execute-verify-report pattern
    - ## Multi-program architecture
    - ## Best practices
      - ### Do
      - ### Avoid
    - ## Related

## automation/taskflow.md
- Route: /automation/taskflow
- Headings:
    - ## When to use Task Flow
    - ## Reliable scheduled workflow pattern
    - ## Sync modes
      - ### Managed mode
      - ### Mirrored mode
    - ## Durable state and revision tracking
    - ## Cancel behavior
    - ## CLI commands
    - ## How flows relate to tasks
    - ## Related

## automation/tasks.md
- Route: /automation/tasks
- Headings:
    - ## TL;DR
    - ## Quick start
    - ## What creates a task
    - ## Task lifecycle
    - ## Delivery and notifications
      - ### Notification policies
    - ## CLI reference
    - ## Chat task board (/tasks)
    - ## Status integration (task pressure)
    - ## Storage and maintenance
      - ### Where tasks live
      - ### Automatic maintenance
    - ## How tasks relate to other systems
    - ## Related

## automation/troubleshooting.md
- Route: /automation/troubleshooting
- Headings:
    - ## Related

## automation/webhook.md
- Route: /automation/webhook
- Headings:
    - ## Related

## brave-search.md
- Route: /brave-search
- Headings:
    - ## Related

## channels/access-groups.md
- Route: /channels/access-groups
- Headings:
    - ## Static message sender groups
    - ## Reference groups from allowlists
    - ## Supported message-channel paths
    - ## Plugin diagnostics
    - ## Discord channel audiences
    - ## Security notes
    - ## Troubleshooting

## channels/ambient-room-events.md
- Route: /channels/ambient-room-events
- Headings:
    - ## Recommended setup
    - ## What changes
    - ## Discord example
    - ## Slack example
    - ## Telegram example
    - ## Agent specific policy
    - ## Visible reply modes
    - ## History
    - ## Troubleshooting
    - ## Related

## channels/bot-loop-protection.md
- Route: /channels/bot-loop-protection
- Headings:
  - # Bot loop protection
    - ## Defaults
    - ## Configure shared defaults
    - ## Override per channel or account
    - ## Channel support

## channels/broadcast-groups.md
- Route: /channels/broadcast-groups
- Headings:
    - ## Overview
    - ## Use cases
    - ## Configuration
      - ### Basic setup
      - ### Processing strategy
      - ### Complete example
    - ## How it works
      - ### Message flow
      - ### Session isolation
      - ### Example: isolated sessions
    - ## Best practices
    - ## Compatibility
      - ### Providers
      - ### Routing
    - ## Troubleshooting
    - ## Examples
    - ## API reference
      - ### Config schema
      - ### Fields
    - ## Limitations
    - ## Future enhancements
    - ## Related

## channels/channel-routing.md
- Route: /channels/channel-routing
- Headings:
  - # Channels & routing
    - ## Key terms
    - ## Outbound target prefixes
    - ## Session key shapes (examples)
    - ## Main DM route pinning
    - ## Guarded inbound recording
    - ## Routing rules (how an agent is chosen)
    - ## Broadcast groups (run multiple agents)
    - ## Config overview
    - ## Session storage
    - ## WebChat behavior
    - ## Reply context
    - ## Related

## channels/clickclack.md
- Route: /channels/clickclack
- Headings:
    - ## Quick setup
    - ## Multiple bots
    - ## Targets
    - ## Permissions
    - ## Troubleshooting

## channels/discord.md
- Route: /channels/discord
- Headings:
    - ## Quick setup
    - ## Recommended: Set up a guild workspace
    - ## Runtime model
    - ## Forum channels
    - ## Interactive components
    - ## Access control and routing
      - ### Role-based agent routing
    - ## Native commands and command auth
    - ## Feature details
    - ## Tools and action gates
    - ## Components v2 UI
    - ## Voice
      - ### Voice channels
      - ### Follow users in voice
      - ### Voice messages
    - ## Troubleshooting
    - ## Configuration reference
    - ## Safety and operations
    - ## Related

## channels/feishu.md
- Route: /channels/feishu
- Headings:
    - ## Quick start
    - ## Access control
      - ### Direct messages
      - ### Group chats
    - ## Group configuration examples
      - ### Allow all groups, no @mention required
      - ### Allow all groups, still require @mention
      - ### Allow specific groups only
      - ### Restrict senders within a group
    - ## Get group/user IDs
      - ### Group IDs (chatid, format: ocxxx)
      - ### User IDs (openid, format: ouxxx)
    - ## Common commands
    - ## Troubleshooting
      - ### Bot does not respond in group chats
      - ### Bot does not receive messages
      - ### QR setup does not react in the Feishu mobile app
      - ### App Secret leaked
    - ## Advanced configuration
      - ### Multiple accounts
      - ### Message limits
      - ### Streaming
      - ### Quota optimization
      - ### ACP sessions
        - #### Persistent ACP binding
        - #### Spawn ACP from chat
      - ### Multi-agent routing
    - ## Per-user agent isolation (Dynamic Agent Creation)
      - ### Quick setup
      - ### How it works
      - ### Configuration options
      - ### Session scope
      - ### Typical multi-user deployment
      - ### Verification
      - ### Notes
    - ## Configuration reference
    - ## Supported message types
      - ### Receive
      - ### Send
      - ### Threads and replies
    - ## Related

## channels/googlechat.md
- Route: /channels/googlechat
- Headings:
    - ## Install
    - ## Quick setup (beginner)
    - ## Add to Google Chat
    - ## Public URL (Webhook-only)
      - ### Option A: Tailscale Funnel (Recommended)
      - ### Option B: Reverse Proxy (Caddy)
      - ### Option C: Cloudflare Tunnel
    - ## How it works
    - ## Targets
    - ## Config highlights
    - ## Troubleshooting
      - ### 405 Method Not Allowed
      - ### Other issues
    - ## Related

## channels/group-messages.md
- Route: /channels/group-messages
- Headings:
    - ## Behavior
    - ## Config example (WhatsApp)
      - ### Activation command (owner-only)
    - ## How to use
    - ## Testing / verification
    - ## Known considerations
    - ## Related

## channels/groups.md
- Route: /channels/groups
- Headings:
    - ## Beginner intro (2 minutes)
    - ## Visible replies
    - ## Context visibility and allowlists
    - ## Session keys
    - ## Pattern: personal DMs + public groups (single agent)
    - ## Display labels
    - ## Group policy
    - ## Mention gating (default)
    - ## Scope configured mention patterns
    - ## Group/channel tool restrictions (optional)
    - ## Group allowlists
    - ## Activation (owner-only)
    - ## Context fields
    - ## iMessage specifics
    - ## WhatsApp system prompts
    - ## WhatsApp specifics
    - ## Related

## channels/imessage-from-bluebubbles.md
- Route: /channels/imessage-from-bluebubbles
- Headings:
    - ## Migration checklist
    - ## When this migration makes sense
    - ## What imsg does
    - ## Before you start
    - ## Config translation
    - ## Group registry footgun
    - ## Step-by-step
    - ## Action parity at a glance
    - ## Pairing, sessions, and ACP bindings
    - ## No rollback channel
    - ## Related

## channels/imessage.md
- Route: /channels/imessage
- Headings:
    - ## Quick setup
    - ## Requirements and permissions (macOS)
    - ## Enabling the imsg private API
      - ### Setup
      - ### When you can't disable SIP
    - ## Access control and routing
    - ## ACP conversation bindings
    - ## Deployment patterns
    - ## Media, chunking, and delivery targets
    - ## Private API actions
    - ## Config writes
    - ## Coalescing split-send DMs (command + URL in one composition)
      - ### Scenarios and what the agent sees
    - ## Inbound recovery after a bridge or gateway restart
      - ### Operator-visible signal
      - ### Migration
    - ## Troubleshooting
    - ## Configuration reference pointers
    - ## Related

## channels/index.md
- Route: /channels
- Headings:
    - ## Delivery notes
    - ## Supported channels
    - ## Notes

## channels/irc.md
- Route: /channels/irc
- Headings:
    - ## Quick start
    - ## Security defaults
    - ## Access control
      - ### Common gotcha: allowFrom is for DMs, not channels
    - ## Reply triggering (mentions)
    - ## Security note (recommended for public channels)
      - ### Same tools for everyone in the channel
      - ### Different tools per sender (owner gets more power)
    - ## NickServ
    - ## Environment variables
    - ## Troubleshooting
    - ## Related

## channels/line.md
- Route: /channels/line
- Headings:
    - ## Install
    - ## Setup
    - ## Configure
    - ## Access control
    - ## Message behavior
    - ## Channel data (rich messages)
    - ## ACP support
    - ## Outbound media
    - ## Troubleshooting
    - ## Related

## channels/location.md
- Route: /channels/location
- Headings:
    - ## Text formatting
    - ## Context fields
    - ## Channel notes
    - ## Related

## channels/matrix-migration.md
- Route: /channels/matrix-migration
- Headings:
    - ## What the migration does automatically
    - ## What the migration cannot do automatically
    - ## Recommended upgrade flow
    - ## How encrypted migration works
    - ## Common messages and what they mean
      - ### Upgrade and detection messages
      - ### Encrypted-state recovery messages
      - ### Manual recovery messages
      - ### Custom plugin install messages
    - ## If encrypted history still does not come back
    - ## If you want to start fresh for future messages
    - ## Related

## channels/matrix-presentation.md
- Route: /channels/matrix-presentation
- Headings:
    - ## Event content
    - ## Fallback behavior
    - ## Supported blocks
    - ## Interactions
    - ## Relationship to approval metadata
    - ## Media messages

## channels/matrix-push-rules.md
- Route: /channels/matrix-push-rules
- Headings:
    - ## Prerequisites
    - ## Steps
    - ## Multi-bot notes
    - ## Homeserver notes
    - ## Related

## channels/matrix.md
- Route: /channels/matrix
- Headings:
    - ## Install
    - ## Setup
      - ### Interactive setup
      - ### Minimal config
      - ### Auto-join
      - ### Allowlist target formats
      - ### Account ID normalization
      - ### Cached credentials
      - ### Environment variables
    - ## Configuration example
    - ## Streaming previews
    - ## Voice messages
    - ## Approval metadata
      - ### Self-hosted push rules for quiet finalized previews
    - ## Bot-to-bot rooms
    - ## Encryption and verification
      - ### Enable encryption
      - ### Status and trust signals
      - ### Verify this device with a recovery key
      - ### Bootstrap or repair cross-signing
      - ### Room-key backup
      - ### Listing, requesting, and responding to verifications
      - ### Multi-account notes
    - ## Profile management
    - ## Threads
      - ### Session routing (sessionScope)
      - ### Reply threading (threadReplies)
      - ### Thread inheritance and slash commands
    - ## ACP conversation bindings
      - ### Thread binding config
    - ## Reactions
    - ## History context
    - ## Context visibility
    - ## DM and room policy
    - ## Direct room repair
    - ## Exec approvals
    - ## Slash commands
    - ## Multi-account
    - ## Private/LAN homeservers
    - ## Proxying Matrix traffic
    - ## Target resolution
    - ## Configuration reference
      - ### Account and connection
      - ### Encryption
      - ### Access and policy
      - ### Reply behavior
      - ### Reaction settings
      - ### Tooling and per-room overrides
      - ### Exec approval settings
    - ## Related

## channels/mattermost.md
- Route: /channels/mattermost
- Headings:
    - ## Install
    - ## Quick setup
    - ## Native slash commands
    - ## Environment variables (default account)
    - ## Chat modes
    - ## Threading and sessions
    - ## Access control (DMs)
    - ## Channels (groups)
    - ## Targets for outbound delivery
    - ## DM channel retry
    - ## Preview streaming
    - ## Reactions (message tool)
    - ## Interactive buttons (message tool)
      - ### Direct API integration (external scripts)
    - ## Directory adapter
    - ## Multi-account
    - ## Troubleshooting
    - ## Related

## channels/msteams.md
- Route: /channels/msteams
- Headings:
    - ## Bundled plugin
    - ## Quick setup
    - ## Goals
    - ## Config writes
    - ## Access control (DMs + groups)
      - ### How it works
      - ### Step 1: Create Azure Bot
      - ### Step 2: Get Credentials
      - ### Step 3: Configure Messaging Endpoint
      - ### Step 4: Enable Teams Channel
      - ### Step 5: Build Teams App Manifest
      - ### Step 6: Configure OpenClaw
      - ### Step 7: Run the Gateway
    - ## Federated authentication (certificate plus managed identity)
      - ### Option A: Certificate-based authentication
      - ### Option B: Azure Managed Identity
      - ### AKS Workload Identity Setup
      - ### Auth type comparison
    - ## Local development (tunneling)
    - ## Testing the Bot
    - ## Environment variables
    - ## Member info action
    - ## History context
    - ## Current Teams RSC permissions (manifest)
    - ## Example Teams manifest (redacted)
      - ### Manifest caveats (must-have fields)
      - ### Updating an existing app
    - ## Capabilities: RSC only vs Graph
      - ### With Teams RSC only (app installed, no Graph API permissions)
      - ### With Teams RSC + Microsoft Graph Application permissions
      - ### RSC vs Graph API
    - ## Graph-enabled media + history (required for channels)
    - ## Known limitations
      - ### Webhook timeouts
      - ### Teams cloud and service URL support
      - ### Formatting
    - ## Configuration
    - ## Routing and sessions
    - ## Reply style: threads vs posts
      - ### Resolution precedence
      - ### Thread context preservation
    - ## Attachments and images
    - ## Sending files in group chats
      - ### Why group chats need SharePoint
      - ### Setup
      - ### Sharing behavior
      - ### Fallback behavior
      - ### Files stored location
    - ## Polls (Adaptive Cards)
    - ## Presentation cards
    - ## Target formats
    - ## Proactive messaging
    - ## Team and Channel IDs (Common Gotcha)
    - ## Private channels
    - ## Troubleshooting
      - ### Common issues
      - ### Manifest upload errors
      - ### RSC permissions not working
    - ## References
    - ## Related

## channels/nextcloud-talk.md
- Route: /channels/nextcloud-talk
- Headings:
    - ## Bundled plugin
    - ## Quick setup (beginner)
    - ## Notes
    - ## Access control (DMs)
    - ## Rooms (groups)
    - ## Capabilities
    - ## Configuration reference (Nextcloud Talk)
    - ## Related

## channels/nostr.md
- Route: /channels/nostr
- Headings:
    - ## Bundled plugin
      - ### Older/custom installs
      - ### Non-interactive setup
    - ## Quick setup
    - ## Configuration reference
    - ## Profile metadata
    - ## Access control
      - ### DM policies
      - ### Allowlist example
    - ## Key formats
    - ## Relays
    - ## Protocol support
    - ## Testing
      - ### Local relay
      - ### Manual test
    - ## Troubleshooting
      - ### Not receiving messages
      - ### Not sending responses
      - ### Duplicate responses
    - ## Security
    - ## Limitations (MVP)
    - ## Related

## channels/pairing.md
- Route: /channels/pairing
- Headings:
    - ## 1) DM pairing (inbound chat access)
      - ### Approve a sender
      - ### Reusable sender groups
      - ### Where the state lives
    - ## 2) Node device pairing (iOS/Android/macOS/headless nodes)
      - ### Pair via Telegram (recommended for iOS)
      - ### Approve a node device
      - ### Optional trusted-CIDR node auto-approve
      - ### Node pairing state storage
      - ### Notes
    - ## Related docs

## channels/qa-channel.md
- Route: /channels/qa-channel
- Headings:
    - ## What it does
    - ## Config
    - ## Runners
    - ## Related

## channels/qqbot.md
- Route: /channels/qqbot
- Headings:
    - ## Install
    - ## Setup
    - ## Configure
      - ### Multi-account setup
      - ### Group chats
      - ### Voice (STT / TTS)
    - ## Target formats
    - ## Slash commands
    - ## Engine architecture
    - ## QR-code onboarding
    - ## Troubleshooting
    - ## Related

## channels/raft.md
- Route: /channels/raft
- Headings:
    - ## Install
    - ## Prerequisites
    - ## Configure
    - ## How It Works
    - ## Verify
    - ## Troubleshooting
    - ## References

## channels/signal.md
- Route: /channels/signal
- Headings:
    - ## Prerequisites
    - ## Quick setup (beginner)
    - ## What it is
    - ## Config writes
    - ## The number model (important)
    - ## Setup path A: link existing Signal account (QR)
    - ## Setup path B: register dedicated bot number (SMS, Linux)
    - ## External daemon mode (httpUrl)
    - ## Container mode (bbernhard/signal-cli-rest-api)
    - ## Access control (DMs + groups)
    - ## How it works (behavior)
    - ## Media + limits
    - ## Typing + read receipts
    - ## Reactions (message tool)
    - ## Approval reactions
    - ## Delivery targets (CLI/cron)
    - ## Troubleshooting
    - ## Security notes
    - ## Configuration reference (Signal)
    - ## Related

## channels/slack.md
- Route: /channels/slack
- Headings:
    - ## Choosing Socket Mode or HTTP Request URLs
      - ### Relay mode
    - ## Install
    - ## Quick setup
    - ## Socket Mode transport tuning
    - ## Manifest and scope checklist
      - ### Additional manifest settings
    - ## Token model
    - ## Actions and gates
    - ## Access control and routing
    - ## Threading, sessions, and reply tags
    - ## Ack reactions
      - ### Emoji (ackReaction)
      - ### Scope (messages.ackReactionScope)
    - ## Text streaming
    - ## Typing reaction fallback
    - ## Media, chunking, and delivery
    - ## Commands and slash behavior
    - ## Interactive replies
      - ### Plugin-owned modal submissions
    - ## Native approvals in Slack
    - ## Events and operational behavior
    - ## Configuration reference
    - ## Troubleshooting
    - ## Attachment vision reference
      - ### Supported media types
      - ### Inbound pipeline
      - ### Thread-root attachment inheritance
      - ### Multi-attachment handling
      - ### Size, download, and model limits
      - ### Known limits
      - ### Related documentation
    - ## Related

## channels/sms.md
- Route: /channels/sms
- Headings:
    - ## Before you begin
    - ## Quick Setup
    - ## Configuration Examples
      - ### Config file
      - ### Environment variables
      - ### SecretRef auth token
      - ### Allowlist-only private number
      - ### Messaging Service sender
      - ### Default outbound target
    - ## Access control
    - ## Sending SMS
    - ## Verify Setup
      - ### End-to-end test from macOS iMessage/SMS
    - ## Webhook security
    - ## Multi-account config
    - ## Troubleshooting
      - ### Twilio returns 403 or OpenClaw rejects the webhook
      - ### No pairing request appears
      - ### Outbound sends fail
      - ### Messages arrive but the agent does not answer

## channels/synology-chat.md
- Route: /channels/synology-chat
- Headings:
    - ## Bundled plugin
    - ## Quick setup
    - ## Environment variables
    - ## DM policy and access control
    - ## Outbound delivery
    - ## Multi-account
    - ## Security notes
    - ## Troubleshooting
    - ## Related

## channels/telegram.md
- Route: /channels/telegram
- Headings:
    - ## Quick setup
    - ## Telegram side settings
    - ## Access control and activation
      - ### Group bot identity
    - ## Runtime behavior
    - ## Feature reference
    - ## Error reply controls
    - ## Troubleshooting
    - ## Configuration reference
    - ## Related

## channels/tlon.md
- Route: /channels/tlon
- Headings:
    - ## Bundled plugin
    - ## Setup
    - ## Private/LAN ships
    - ## Group channels
    - ## Access control
    - ## Owner and approval system
    - ## Auto-accept settings
    - ## Delivery targets (CLI/cron)
    - ## Bundled skill
    - ## Capabilities
    - ## Troubleshooting
    - ## Configuration reference
    - ## Notes
    - ## Related

## channels/troubleshooting.md
- Route: /channels/troubleshooting
- Headings:
    - ## Command ladder
    - ## After an update
    - ## WhatsApp
      - ### WhatsApp failure signatures
    - ## Telegram
      - ### Telegram failure signatures
    - ## Discord
      - ### Discord failure signatures
    - ## Slack
      - ### Slack failure signatures
    - ## iMessage
      - ### iMessage failure signatures
    - ## Signal
      - ### Signal failure signatures
    - ## QQ Bot
      - ### QQ Bot failure signatures
    - ## Matrix
      - ### Matrix failure signatures
    - ## Related

## channels/twitch.md
- Route: /channels/twitch
- Headings:
    - ## Bundled plugin
    - ## Quick setup (beginner)
    - ## What it is
    - ## Setup (detailed)
      - ### Generate credentials
      - ### Configure the bot
      - ### Access control (recommended)
    - ## Token refresh (optional)
    - ## Multi-account support
    - ## Access control
    - ## Troubleshooting
    - ## Config
      - ### Account config
      - ### Provider options
    - ## Tool actions
    - ## Safety and ops
    - ## Limits
    - ## Related

## channels/wechat.md
- Route: /channels/wechat
- Headings:
    - ## Naming
    - ## How it works
    - ## Install
    - ## Login
    - ## Access control
    - ## Compatibility
    - ## Sidecar process
    - ## Troubleshooting
    - ## Related docs

## channels/whatsapp.md
- Route: /channels/whatsapp
- Headings:
    - ## Install (on demand)
    - ## Quick setup
    - ## Deployment patterns
    - ## Runtime model
    - ## Approval prompts
    - ## Plugin hooks and privacy
    - ## Access control and activation
    - ## Configured ACP bindings
    - ## Personal-number and self-chat behavior
    - ## Message normalization and context
    - ## Delivery, chunking, and media
    - ## Reply quoting
    - ## Reaction level
    - ## Acknowledgment reactions
    - ## Lifecycle status reactions
    - ## Multi-account and credentials
    - ## Tools, actions, and config writes
    - ## Troubleshooting
    - ## System prompts
    - ## Configuration reference pointers
    - ## Related

## channels/yuanbao.md
- Route: /channels/yuanbao
- Headings:
    - ## Quick start
      - ### Interactive setup (alternative)
    - ## Access control
      - ### Direct messages
      - ### Group chats
    - ## Configuration examples
      - ### Basic setup with open DM policy
      - ### Restrict DMs to specific users
      - ### Disable @mention requirement in groups
      - ### Optimize outbound message delivery
      - ### Tune merge-text strategy
    - ## Common commands
    - ## Troubleshooting
      - ### Bot does not respond in group chats
      - ### Bot does not receive messages
      - ### Bot sends empty or fallback replies
      - ### App Secret leaked
    - ## Advanced configuration
      - ### Multiple accounts
      - ### Message limits
      - ### Streaming
      - ### Group chat history context
      - ### Reply-to mode
      - ### Markdown hint injection
      - ### Debug mode
      - ### Multi-agent routing
    - ## Configuration reference
    - ## Supported message types
      - ### Receive
      - ### Send
      - ### Threads and replies
    - ## Related

## channels/zalo.md
- Route: /channels/zalo
- Headings:
    - ## Bundled plugin
    - ## Quick setup (beginner)
    - ## What it is
    - ## Setup (fast path)
      - ### 1) Create a bot token (Zalo Bot Platform)
      - ### 2) Configure the token (env or config)
    - ## How it works (behavior)
    - ## Limits
    - ## Access control (DMs)
      - ### DM access
    - ## Access control (Groups)
    - ## Long-polling vs webhook
    - ## Supported message types
    - ## Capabilities
    - ## Delivery targets (CLI/cron)
    - ## Troubleshooting
    - ## Configuration reference (Zalo)
    - ## Related

## channels/zaloclawbot.md
- Route: /channels/zaloclawbot
- Headings:
    - ## Compatibility
    - ## Prerequisites
    - ## Install with onboard (recommended)
    - ## Manual Installation
      - ### 1. Install the plugin
      - ### 2. Enable the plugin in config
      - ### 3. Generate QR code and log in
      - ### 4. Restart the gateway
    - ## How It Works
    - ## Under the Hood
    - ## Troubleshooting

## channels/zalouser.md
- Route: /channels/zalouser
- Headings:
    - ## Bundled plugin
    - ## Quick setup (beginner)
    - ## What it is
    - ## Naming
    - ## Finding IDs (directory)
    - ## Limits
    - ## Access control (DMs)
    - ## Group access (optional)
      - ### Group mention gating
    - ## Multi-account
    - ## Environment variables
    - ## Typing, reactions, and delivery acknowledgements
    - ## Troubleshooting
    - ## Related

## ci.md
- Route: /ci
- Headings:
    - ## Pipeline overview
    - ## Fail-fast order
    - ## PR context and evidence
    - ## Scope and routing
    - ## ClawSweeper activity forwarding
    - ## Manual dispatches
    - ## Runners
    - ## Local equivalents
    - ## OpenClaw Performance
    - ## Full Release Validation
    - ## Live and E2E shards
    - ## Package Acceptance
      - ### Jobs
      - ### Candidate sources
      - ### Suite profiles
      - ### Legacy compatibility windows
      - ### Examples
    - ## Install smoke
    - ## Local Docker E2E
      - ### Tunables
      - ### Reusable live/E2E workflow
      - ### Release-path chunks
    - ## Plugin Prerelease
    - ## QA Lab
    - ## CodeQL
      - ### Security categories
      - ### Platform-specific security shards
      - ### Critical Quality categories
    - ## Maintenance workflows
      - ### Docs Agent
      - ### Test Performance Agent
      - ### Duplicate PRs After Merge
    - ## Local check gates and changed routing
    - ## Testbox validation
    - ## Related

## clawhub/cli.md
- Route: /clawhub/cli
- Headings:
  - # ClawHub CLI
    - ## Discover and install
    - ## Publish and maintain
    - ## Related

## clawhub/publishing.md
- Route: /clawhub/publishing
- Headings:
  - # Publishing on ClawHub
    - ## Owners
    - ## Skills
    - ## Plugins
    - ## Release Flow
    - ## FAQ
      - ### Package scope must match selected owner

## cli/acp.md
- Route: /cli/acp
- Headings:
    - ## What this is not
    - ## Compatibility Matrix
    - ## Known Limitations
    - ## Usage
    - ## ACP client (debug)
    - ## Protocol smoke testing
    - ## How to use this
    - ## Selecting agents
    - ## Use from acpx (Codex, Claude, other ACP clients)
    - ## Zed editor setup
    - ## Session mapping
    - ## Options
      - ### acp client options
    - ## Related

## cli/agent.md
- Route: /cli/agent
- Headings:
  - # openclaw agent
    - ## Options
    - ## Examples
    - ## Notes
    - ## JSON delivery status
    - ## Related

## cli/agents.md
- Route: /cli/agents
- Headings:
  - # openclaw agents
    - ## Examples
    - ## Routing bindings
      - ### --bind format
      - ### Binding scope behavior
    - ## Command surface
      - ### agents
      - ### agents list
      - ### agents add [name]
      - ### agents bindings
      - ### agents bind
      - ### agents unbind
      - ### agents delete
    - ## Identity files
    - ## Set identity
    - ## Related

## cli/approvals.md
- Route: /cli/approvals
- Headings:
  - # openclaw approvals
    - ## openclaw exec-policy
    - ## Common commands
    - ## Replace approvals from a file
    - ## "Never prompt" / YOLO example
    - ## Allowlist helpers
    - ## Common options
    - ## Notes
    - ## Related

## cli/backup.md
- Route: /cli/backup
- Headings:
  - # openclaw backup
    - ## Notes
    - ## What gets backed up
    - ## Invalid config behavior
    - ## Size and performance
    - ## Related

## cli/browser.md
- Route: /cli/browser
- Headings:
  - # openclaw browser
    - ## Common flags
    - ## Quick start (local)
    - ## Quick troubleshooting
    - ## Lifecycle
    - ## If the command is missing
    - ## Profiles
    - ## Tabs
    - ## Snapshot / screenshot / actions
    - ## State and storage
    - ## Debugging
    - ## Existing Chrome via MCP
    - ## Remote browser control (node host proxy)
    - ## Related

## cli/channels.md
- Route: /cli/channels
- Headings:
  - # openclaw channels
    - ## Common commands
    - ## Status / capabilities / resolve / logs
    - ## Add / remove accounts
    - ## Login and logout (interactive)
    - ## Troubleshooting
    - ## Capabilities probe
    - ## Resolve names to IDs
    - ## Related

## cli/clawbot.md
- Route: /cli/clawbot
- Headings:
  - # openclaw clawbot
    - ## Migration
    - ## Related

## cli/commitments.md
- Route: /cli/commitments
- Headings:
    - ## Usage
    - ## Options
    - ## Examples
    - ## Output
    - ## Related

## cli/completion.md
- Route: /cli/completion
- Headings:
  - # openclaw completion
    - ## Usage
    - ## Options
    - ## Notes
    - ## Related

## cli/config.md
- Route: /cli/config
- Headings:
    - ## Root options
    - ## Examples
      - ### config schema
      - ### Paths
    - ## Values
    - ## config set modes
    - ## config patch
    - ## Provider builder flags
    - ## Dry run
      - ### JSON output shape
    - ## Write safety
    - ## Subcommands
    - ## Validate
    - ## Related

## cli/configure.md
- Route: /cli/configure
- Headings:
  - # openclaw configure
    - ## Options
    - ## Examples
    - ## Related

## cli/crestodian.md
- Route: /cli/crestodian
- Headings:
  - # openclaw crestodian
    - ## What Crestodian shows
    - ## Examples
    - ## Safe startup
    - ## Operations and approval
    - ## Setup bootstrap
    - ## Model-Assisted Planner
    - ## Switching to an agent
    - ## Message rescue mode
    - ## Related

## cli/cron.md
- Route: /cli/cron
- Headings:
  - # openclaw cron
    - ## Create jobs quickly
    - ## Sessions
    - ## Delivery
      - ### Delivery ownership
      - ### Failure delivery
    - ## Scheduling
      - ### One-shot jobs
      - ### Recurring jobs
      - ### Manual runs
    - ## Models
      - ### Isolated cron model precedence
      - ### Fast mode
      - ### Live model switch retries
    - ## Run output and denials
      - ### Stale acknowledgement suppression
      - ### Silent token suppression
      - ### Structured denials
    - ## Retention
    - ## Migrating older jobs
    - ## Common edits
    - ## Common admin commands
    - ## Related

## cli/daemon.md
- Route: /cli/daemon
- Headings:
  - # openclaw daemon
    - ## Usage
    - ## Subcommands
    - ## Common options
    - ## Prefer
    - ## Related

## cli/dashboard.md
- Route: /cli/dashboard
- Headings:
  - # openclaw dashboard
    - ## Related

## cli/devices.md
- Route: /cli/devices
- Headings:
  - # openclaw devices
    - ## Commands
      - ### openclaw devices list
      - ### openclaw devices remove
      - ### openclaw devices clear --yes [--pending]
      - ### openclaw devices approve [requestId] [--latest]
    - ## Paperclip / openclawgateway first-run approval
      - ### openclaw devices reject
      - ### openclaw devices rotate --device --role [--scope ]
      - ### openclaw devices revoke --device --role
    - ## Common options
    - ## Notes
    - ## Token drift recovery checklist
    - ## Related

## cli/directory.md
- Route: /cli/directory
- Headings:
  - # openclaw directory
    - ## Common flags
    - ## Notes
    - ## Using results with message send
    - ## ID formats (by channel)
    - ## Self ("me")
    - ## Peers (contacts/users)
    - ## Groups
    - ## Related

## cli/dns.md
- Route: /cli/dns
- Headings:
  - # openclaw dns
    - ## Setup
    - ## dns setup
    - ## Related

## cli/docs.md
- Route: /cli/docs
- Headings:
  - # openclaw docs
    - ## Usage
    - ## Examples
    - ## How it works
    - ## Output
    - ## Exit codes
    - ## Related

## cli/doctor.md
- Route: /cli/doctor
- Headings:
  - # openclaw doctor
    - ## Why Use It
    - ## Examples
    - ## Options
    - ## Lint mode
    - ## Structured Health Checks
    - ## Check Selection
    - ## Post-upgrade mode
    - ## macOS: launchctl env overrides
    - ## Related

## cli/flows.md
- Route: /cli/flows
- Headings:
  - # openclaw tasks flow
    - ## Subcommands
      - ### Status filter values
    - ## Examples
    - ## Related

## cli/gateway.md
- Route: /cli/gateway
- Headings:
    - ## Run the Gateway
      - ### Options
    - ## Restart the Gateway
      - ### Gateway profiling
    - ## Query a running Gateway
      - ### gateway health
      - ### gateway usage-cost
      - ### gateway stability
      - ### gateway diagnostics export
      - ### gateway status
      - ### gateway probe
        - #### Remote over SSH (Mac app parity)
      - ### gateway call
    - ## Manage the Gateway service
      - ### Install with a wrapper
    - ## Discover gateways (Bonjour)
      - ### gateway discover
    - ## Related

## cli/health.md
- Route: /cli/health
- Headings:
  - # openclaw health
    - ## Options
    - ## Related

## cli/hooks.md
- Route: /cli/hooks
- Headings:
  - # openclaw hooks
    - ## List all hooks
    - ## Get hook information
    - ## Check hooks eligibility
    - ## Enable a Hook
    - ## Disable a Hook
    - ## Notes
    - ## Install hook packs
    - ## Update hook packs
    - ## Bundled hooks
      - ### session-memory
      - ### bootstrap-extra-files
      - ### command-logger
      - ### boot-md
    - ## Related

## cli/index.md
- Route: /cli
- Headings:
    - ## Command pages
    - ## Global flags
    - ## Output modes
    - ## Command tree
    - ## Chat slash commands
    - ## Usage tracking
    - ## Related

## cli/infer.md
- Route: /cli/infer
- Headings:
    - ## Turn infer into a skill
    - ## Why use infer
    - ## Command tree
    - ## Common tasks
    - ## Behavior
    - ## Model
    - ## Image
    - ## Audio
    - ## TTS
    - ## Video
    - ## Web
    - ## Embedding
    - ## JSON output
    - ## Common pitfalls
    - ## Notes
    - ## Related

## cli/logs.md
- Route: /cli/logs
- Headings:
  - # openclaw logs
    - ## Options
    - ## Shared Gateway RPC options
    - ## Examples
    - ## Notes
    - ## Related

## cli/mcp.md
- Route: /cli/mcp
- Headings:
    - ## Choose the right MCP path
    - ## OpenClaw as an MCP server
      - ### When to use serve
      - ### How it works
      - ### Choose a client mode
      - ### What serve exposes
      - ### Usage
      - ### Bridge tools
      - ### Event model
      - ### Claude channel notifications
      - ### MCP client config
      - ### Options
      - ### Security and trust boundary
      - ### Testing
      - ### Troubleshooting
    - ## OpenClaw as an MCP client registry
      - ### Saved MCP server definitions
      - ### Common server recipes
      - ### JSON output shapes
      - ### Stdio transport
      - ### SSE / HTTP transport
      - ### OAuth workflow
      - ### Streamable HTTP transport
    - ## Control UI
    - ## Current limits
    - ## Related

## cli/memory.md
- Route: /cli/memory
- Headings:
  - # openclaw memory
    - ## Examples
    - ## Options
    - ## Dreaming
    - ## Related

## cli/message.md
- Route: /cli/message
- Headings:
  - # openclaw message
    - ## Usage
    - ## Common flags
    - ## SecretRef behavior
    - ## Actions
      - ### Core
      - ### Threads
      - ### Emojis
      - ### Stickers
      - ### Roles / Channels / Members / Voice
      - ### Events
      - ### Moderation (Discord)
      - ### Broadcast
    - ## Examples
    - ## Related

## cli/migrate.md
- Route: /cli/migrate
- Headings:
  - # openclaw migrate
    - ## Commands
    - ## Safety model
    - ## Claude provider
      - ### What Claude imports
      - ### Archive and manual-review state
    - ## Codex provider
      - ### What Codex imports
      - ### Manual-review Codex state
    - ## Hermes provider
      - ### What Hermes imports
      - ### Supported .env keys
      - ### Archive-only state
      - ### After applying
    - ## Plugin contract
    - ## Onboarding integration
    - ## Related

## cli/models.md
- Route: /cli/models
- Headings:
  - # openclaw models
    - ## Common commands
      - ### Models scan
      - ### Models status
    - ## Aliases + fallbacks
    - ## Auth profiles
    - ## Related

## cli/node.md
- Route: /cli/node
- Headings:
  - # openclaw node
    - ## Why use a node host?
    - ## Browser proxy (zero-config)
    - ## Run (foreground)
    - ## Gateway auth for node host
    - ## Service (background)
    - ## Pairing
    - ## Exec approvals
    - ## Related

## cli/nodes.md
- Route: /cli/nodes
- Headings:
  - # openclaw nodes
    - ## Common commands
    - ## Invoke
    - ## Related

## cli/onboard.md
- Route: /cli/onboard
- Headings:
  - # openclaw onboard
    - ## Related guides
    - ## Examples
    - ## Locale
      - ### Non-interactive Z.AI endpoint choices
    - ## Flow notes
    - ## Common follow-up commands

## cli/pairing.md
- Route: /cli/pairing
- Headings:
  - # openclaw pairing
    - ## Commands
    - ## pairing list
    - ## pairing approve
    - ## Notes
    - ## Related

## cli/path.md
- Route: /cli/path
- Headings:
  - # openclaw path
    - ## Why use it
    - ## How it is used
    - ## How it works
    - ## Subcommands
    - ## Global flags
    - ## oc:// syntax
    - ## Addressing by file kind
    - ## Mutation contract
    - ## Examples
    - ## Recipes by file kind
      - ### Markdown
      - ### JSONC
      - ### JSONL
      - ### YAML
    - ## Subcommand reference
      - ### resolve
      - ### find
      - ### set
      - ### validate
      - ### emit
    - ## Exit codes
    - ## Output mode
    - ## Notes
    - ## Related

## cli/plugins.md
- Route: /cli/plugins
- Headings:
    - ## Commands
      - ### Author
      - ### Install
        - #### Marketplace shorthand
      - ### List
      - ### Plugin index
      - ### Uninstall
      - ### Update
      - ### Inspect
      - ### Doctor
      - ### Registry
      - ### Marketplace
    - ## Related

## cli/policy.md
- Route: /cli/policy
- Headings:
  - # openclaw policy
    - ## Quick start
      - ### Policy rule reference
        - #### Scoped overlays
        - #### Channels
        - #### MCP servers
        - #### Model providers
        - #### Network
        - #### Ingress and channel access
        - #### Gateway
        - #### Agent workspace
        - #### Sandbox posture
        - #### Data Handling
        - #### Secrets
        - #### Exec approvals
        - #### Auth profiles
        - #### Tool metadata
        - #### Tool posture
    - ## Configure policy
    - ## Accept policy state
    - ## Findings
    - ## Repair
    - ## Exit codes
    - ## Related

## cli/proxy.md
- Route: /cli/proxy
- Headings:
  - # openclaw proxy
    - ## Commands
    - ## Validate
    - ## Query presets
    - ## Notes
    - ## Related

## cli/qr.md
- Route: /cli/qr
- Headings:
  - # openclaw qr
    - ## Usage
    - ## Options
    - ## Notes
    - ## Related

## cli/reset.md
- Route: /cli/reset
- Headings:
  - # openclaw reset
    - ## Related

## cli/sandbox.md
- Route: /cli/sandbox
- Headings:
    - ## Overview
    - ## Commands
      - ### openclaw sandbox explain
      - ### openclaw sandbox list
      - ### openclaw sandbox recreate
    - ## Use cases
      - ### After updating a Docker image
      - ### After changing sandbox configuration
      - ### After changing SSH target or SSH auth material
      - ### After changing OpenShell source, policy, or mode
      - ### After changing setupCommand
      - ### For a specific agent only
    - ## Why this is needed
    - ## Registry migration
    - ## Configuration
    - ## Related

## cli/secrets.md
- Route: /cli/secrets
- Headings:
  - # openclaw secrets
    - ## Reload runtime snapshot
    - ## Audit
    - ## Configure (interactive helper)
    - ## Apply a saved plan
    - ## Why no rollback backups
    - ## Example
    - ## Related

## cli/security.md
- Route: /cli/security
- Headings:
  - # openclaw security
    - ## Audit
    - ## JSON output
    - ## What --fix changes
    - ## Related

## cli/sessions.md
- Route: /cli/sessions
- Headings:
  - # openclaw sessions
    - ## Cleanup maintenance
    - ## Compact a session
      - ### sessions.compact RPC
    - ## Related

## cli/setup.md
- Route: /cli/setup
- Headings:
  - # openclaw setup
    - ## Options
      - ### Wizard auto-trigger
    - ## Examples
    - ## Notes
    - ## Related

## cli/skills.md
- Route: /cli/skills
- Headings:
  - # openclaw skills
    - ## Commands
    - ## Skill Workshop
    - ## Related

## cli/status.md
- Route: /cli/status
- Headings:
    - ## Related

## cli/system.md
- Route: /cli/system
- Headings:
  - # openclaw system
    - ## Common commands
    - ## system event
    - ## system heartbeat last|enable|disable
    - ## system presence
    - ## Notes
    - ## Related

## cli/tasks.md
- Route: /cli/tasks
- Headings:
    - ## Usage
    - ## Root Options
    - ## Subcommands
      - ### list
      - ### show
      - ### notify
      - ### cancel
      - ### audit
      - ### maintenance
      - ### flow
    - ## Related

## cli/transcripts.md
- Route: /cli/transcripts
- Headings:
  - # openclaw transcripts
    - ## Commands
    - ## Output
    - ## Many meetings per day
    - ## Missing summaries
    - ## Configuration

## cli/tui.md
- Route: /cli/tui
- Headings:
  - # openclaw tui
    - ## Options
    - ## Examples
    - ## Config repair loop
    - ## Related

## cli/uninstall.md
- Route: /cli/uninstall
- Headings:
  - # openclaw uninstall
    - ## Related

## cli/update.md
- Route: /cli/update
- Headings:
  - # openclaw update
    - ## Usage
    - ## Options
    - ## update status
    - ## update repair
    - ## update wizard
    - ## What it does
      - ### Control-plane response shape
    - ## Git checkout flow
      - ### Channel selection
      - ### Update steps
    - ## --update shorthand
    - ## Related

## cli/voicecall.md
- Route: /cli/voicecall
- Headings:
  - # openclaw voicecall
    - ## Subcommands
    - ## Setup and smoke
      - ### setup
      - ### smoke
    - ## Call lifecycle
      - ### call
      - ### start
      - ### continue
      - ### speak
      - ### dtmf
      - ### end
      - ### status
    - ## Logs and metrics
      - ### tail
      - ### latency
    - ## Exposing webhooks
      - ### expose
    - ## Related

## cli/webhooks.md
- Route: /cli/webhooks
- Headings:
  - # openclaw webhooks
    - ## Subcommands
    - ## webhooks gmail setup
      - ### Required
      - ### Pub/Sub options
      - ### OpenClaw delivery options
      - ### gog watch serve options
      - ### Tailscale exposure
      - ### Output
    - ## webhooks gmail run
    - ## End-to-end flow
    - ## Related

## cli/wiki.md
- Route: /cli/wiki
- Headings:
  - # openclaw wiki
    - ## What it is for
    - ## Common commands
    - ## Commands
      - ### wiki status
      - ### wiki doctor
      - ### wiki init
      - ### wiki ingest
      - ### wiki okf import
      - ### wiki compile
      - ### wiki lint
      - ### wiki search
      - ### wiki get
      - ### wiki apply
      - ### wiki bridge import
      - ### wiki unsafe-local import
      - ### wiki obsidian ...
    - ## Practical usage guidance
    - ## Configuration tie-ins
    - ## Related

## cli/workboard.md
- Route: /cli/workboard
- Headings:
    - ## Usage
    - ## list
    - ## create
    - ## show
    - ## dispatch
    - ## Slash Command Parity
    - ## Permissions
    - ## Troubleshooting
      - ### No Cards Appear
      - ### Dispatch Says Data-Only
      - ### Dispatch Starts Nothing
    - ## Related

## concepts/active-memory.md
- Route: /concepts/active-memory
- Headings:
    - ## Quick start
    - ## Speed recommendations
      - ### Cerebras setup
    - ## How to see it
    - ## Session toggle
    - ## When it runs
    - ## Session types
    - ## Where it runs
    - ## Why use it
    - ## How it works
    - ## Query modes
    - ## Prompt styles
    - ## Model fallback policy
    - ## Memory tools
      - ### Built-in memory-core
      - ### LanceDB memory
      - ### Lossless Claw
    - ## Advanced escape hatches
    - ## Transcript persistence
    - ## Configuration
    - ## Recommended setup
      - ### Cold-start grace
    - ## Debugging
    - ## Common issues
    - ## Related pages

## concepts/agent-loop.md
- Route: /concepts/agent-loop
- Headings:
    - ## Entry points
    - ## How it works (high-level)
    - ## Queueing + concurrency
    - ## Session + workspace preparation
    - ## Prompt assembly + system prompt
    - ## Hook points (where you can intercept)
      - ### Internal hooks (Gateway hooks)
      - ### Plugin hooks (agent + gateway lifecycle)
    - ## Streaming + partial replies
    - ## Tool execution + messaging tools
    - ## Reply shaping + suppression
    - ## Compaction + retries
    - ## Event streams (today)
    - ## Chat channel handling
    - ## Timeouts
    - ## Where things can end early
    - ## Related

## concepts/agent-runtimes.md
- Route: /concepts/agent-runtimes
- Headings:
    - ## Codex surfaces
    - ## Runtime ownership
    - ## Runtime selection
    - ## GitHub Copilot agent runtime
    - ## Compatibility contract
    - ## Status labels
    - ## Related

## concepts/agent-workspace.md
- Route: /concepts/agent-workspace
- Headings:
    - ## Default location
    - ## Extra workspace folders
    - ## Workspace file map
    - ## What is NOT in the workspace
    - ## Git backup (recommended, private)
    - ## Do not commit secrets
    - ## Moving the workspace to a new machine
    - ## Advanced notes
    - ## Related

## concepts/agent.md
- Route: /concepts/agent
- Headings:
    - ## Workspace (required)
    - ## Bootstrap files (injected)
    - ## Built-in tools
    - ## Skills
    - ## Runtime boundaries
    - ## Sessions
    - ## Steering while streaming
    - ## Model refs
    - ## Configuration (minimal)
    - ## Related

## concepts/architecture.md
- Route: /concepts/architecture
- Headings:
    - ## Overview
    - ## Components and flows
      - ### Gateway (daemon)
      - ### Clients (mac app / CLI / web admin)
      - ### Nodes (macOS / iOS / Android / headless)
      - ### WebChat
    - ## Connection lifecycle (single client)
    - ## Wire protocol (summary)
    - ## Pairing + local trust
    - ## Protocol typing and codegen
    - ## Remote access
    - ## Operations snapshot
    - ## Invariants
    - ## Related

## concepts/channel-docking.md
- Route: /concepts/channel-docking
- Headings:
    - ## Example
    - ## Why use it
    - ## Required config
    - ## Commands
    - ## What changes
    - ## What does not change
    - ## Troubleshooting

## concepts/commitments.md
- Route: /concepts/commitments
- Headings:
    - ## Enable commitments
    - ## How it works
    - ## Scope
    - ## Commitments vs reminders
    - ## Manage commitments
    - ## Privacy and cost
    - ## Troubleshooting
    - ## Related

## concepts/compaction.md
- Route: /concepts/compaction
- Headings:
    - ## How it works
    - ## Auto-compaction
    - ## Manual compaction
    - ## Configuration
      - ### Using a different model
      - ### Identifier preservation
      - ### Active transcript byte guard
      - ### Successor transcripts
      - ### Compaction notices
      - ### Memory flush
    - ## Pluggable compaction providers
    - ## Compaction vs pruning
    - ## Troubleshooting
    - ## Related

## concepts/context-engine.md
- Route: /concepts/context-engine
- Headings:
    - ## Quick start
    - ## How it works
      - ### Subagent lifecycle (optional)
      - ### System prompt addition
    - ## The legacy engine
    - ## Plugin engines
      - ### The ContextEngine interface
      - ### Runtime settings
      - ### Host requirements
      - ### Failure isolation
      - ### ownsCompaction
    - ## Configuration reference
    - ## Relationship to compaction and memory
    - ## Tips
    - ## Related

## concepts/context.md
- Route: /concepts/context
- Headings:
    - ## Quick start (inspect context)
    - ## Example output
      - ### /context list
      - ### /context detail
      - ### /context map
    - ## What counts toward the context window
    - ## How OpenClaw builds the system prompt
    - ## Injected workspace files (Project Context)
    - ## Skills: injected vs loaded on-demand
    - ## Tools: there are two costs
    - ## Commands, directives, and "inline shortcuts"
    - ## Sessions, compaction, and pruning (what persists)
    - ## What /context actually reports
    - ## Related

## concepts/delegate-architecture.md
- Route: /concepts/delegate-architecture
- Headings:
    - ## What is a delegate?
    - ## Why delegates?
    - ## Capability tiers
      - ### Tier 1: Read-Only + Draft
      - ### Tier 2: Send on Behalf
      - ### Tier 3: Proactive
    - ## Prerequisites: isolation and hardening
      - ### Hard blocks (non-negotiable)
      - ### Tool restrictions
      - ### Sandbox isolation
      - ### Audit trail
    - ## Setting up a delegate
      - ### 1. Create the delegate agent
      - ### 2. Configure identity provider delegation
        - #### Microsoft 365
        - #### Google Workspace
      - ### 3. Bind the delegate to channels
      - ### 4. Add credentials to the delegate agent
    - ## Example: organizational assistant
    - ## Scaling pattern
    - ## Related

## concepts/dreaming.md
- Route: /concepts/dreaming
- Headings:
    - ## What dreaming writes
    - ## Phase model
    - ## Session transcript ingestion
    - ## Dream Diary
    - ## Deep ranking signals
    - ## QA shadow trial report coverage
    - ## Scheduling
    - ## Quick start
    - ## Slash command
    - ## CLI workflow
    - ## Key defaults
    - ## Dreams UI
    - ## Dreaming never runs: status shows blocked
    - ## Related

## concepts/experimental-features.md
- Route: /concepts/experimental-features
- Headings:
    - ## Currently documented flags
    - ## Local model lean mode
      - ### Why these three tools
      - ### When to turn it on
      - ### When to leave it off
      - ### Enable
    - ## Experimental does not mean hidden
    - ## Related

## concepts/features.md
- Route: /concepts/features
- Headings:
    - ## Highlights
    - ## Full list
    - ## Related

## concepts/mantis-slack-desktop-runbook.md
- Route: /concepts/mantis-slack-desktop-runbook
- Headings:
    - ## Storage model
    - ## GitHub dispatch
    - ## Local CLI
    - ## Hydrate modes
    - ## Timing interpretation
    - ## Evidence checklist
    - ## Failure handling
    - ## Related

## concepts/mantis.md
- Route: /concepts/mantis
- Headings:
    - ## Goals
    - ## Non goals
    - ## Ownership
    - ## Command shape
    - ## Run lifecycle
    - ## Discord MVP
    - ## Existing QA pieces
    - ## Evidence model
    - ## Browser and VNC
    - ## Machines
    - ## Secrets
    - ## GitHub artifacts and PR comments
    - ## Private deployment notes
    - ## Adding a scenario
    - ## Provider expansion
    - ## Open questions

## concepts/markdown-formatting.md
- Route: /concepts/markdown-formatting
- Headings:
    - ## Goals
    - ## Pipeline
    - ## IR example
    - ## Where it is used
    - ## Table handling
    - ## Chunking rules
    - ## Link policy
    - ## Spoilers
    - ## How to add or update a channel formatter
    - ## Common gotchas
    - ## Related

## concepts/memory-builtin.md
- Route: /concepts/memory-builtin
- Headings:
    - ## What it provides
    - ## Getting started
    - ## Supported embedding providers
    - ## How indexing works
    - ## When to use
    - ## Troubleshooting
    - ## Configuration
    - ## Related

## concepts/memory-honcho.md
- Route: /concepts/memory-honcho
- Headings:
    - ## What it provides
    - ## Available tools
    - ## Getting started
    - ## Configuration
    - ## Migrating existing memory
    - ## How it works
    - ## Honcho vs builtin memory
    - ## CLI commands
    - ## Further reading
    - ## Related

## concepts/memory-qmd.md
- Route: /concepts/memory-qmd
- Headings:
    - ## What it adds over builtin
    - ## Getting started
      - ### Prerequisites
      - ### Enable
    - ## How the sidecar works
    - ## Search performance and compatibility
    - ## Model overrides
    - ## Indexing extra paths
    - ## Indexing session transcripts
    - ## Search scope
    - ## Citations
    - ## When to use
    - ## Troubleshooting
    - ## Configuration
    - ## Related

## concepts/memory-search.md
- Route: /concepts/memory-search
- Headings:
    - ## Quick start
    - ## Supported providers
    - ## How search works
    - ## Improving search quality
      - ### Temporal decay
      - ### MMR (diversity)
      - ### Enable both
    - ## Multimodal memory
    - ## Session memory search
    - ## Troubleshooting
    - ## Further reading
    - ## Related

## concepts/memory.md
- Route: /concepts/memory
- Headings:
    - ## How it works
    - ## What goes where
    - ## Action-sensitive memories
    - ## Inferred commitments
    - ## Memory tools
    - ## Memory Wiki companion plugin
    - ## Memory search
    - ## Memory backends
    - ## Knowledge wiki layer
    - ## Automatic memory flush
    - ## Dreaming
    - ## Grounded backfill and live promotion
    - ## CLI
    - ## Further reading
    - ## Related

## concepts/message-lifecycle-refactor.md
- Route: /concepts/message-lifecycle-refactor
- Headings:
    - ## Problems
    - ## Goals
    - ## Non goals
    - ## Reference model
    - ## Core model
    - ## Message terms
      - ### Message
      - ### Target
      - ### Relation
      - ### Origin
      - ### Receipt
    - ## Receive context
    - ## Send context
    - ## Live context
    - ## Adapter surface
    - ## Public SDK reduction
    - ## Relationship to channel inbound
    - ## Compatibility guardrails
    - ## Internal storage
    - ## Failure classes
    - ## Channel mapping
    - ## Migration plan
      - ### Phase 1: Internal Message Domain
      - ### Phase 2: Durable Send Core
      - ### Phase 3: Channel Inbound Bridge
      - ### Phase 4: Prepared Dispatcher Bridge
      - ### Phase 5: Unified Live Lifecycle
      - ### Phase 6: Public SDK
      - ### Phase 7: All Senders
      - ### Phase 8: Remove Turn-Named Compatibility
    - ## Test plan
    - ## Open questions
    - ## Acceptance criteria
    - ## Related

## concepts/messages.md
- Route: /concepts/messages
- Headings:
    - ## Message flow (high level)
    - ## Inbound dedupe
    - ## Inbound debouncing
    - ## Sessions and devices
    - ## Tool result metadata
    - ## Inbound bodies and history context
    - ## Queueing and followups
    - ## Channel run ownership
    - ## Streaming, chunking, and batching
    - ## Reasoning visibility and tokens
    - ## Prefixes, threading, and replies
    - ## Silent replies
    - ## Related

## concepts/model-failover.md
- Route: /concepts/model-failover
- Headings:
    - ## Runtime flow
    - ## Selection source policy
    - ## Auth failure skip cache
    - ## User-visible fallback notices
    - ## Auth storage (keys + OAuth)
    - ## Profile IDs
    - ## Rotation order
      - ### Session stickiness (cache-friendly)
      - ### OpenAI Codex subscription plus API-key backup
    - ## Cooldowns
    - ## Billing disables
    - ## Model fallback
      - ### Candidate chain rules
      - ### Which errors advance fallback
      - ### Cooldown skip vs probe behavior
    - ## Session overrides and live model switching
    - ## Observability and failure summaries
    - ## Related config

## concepts/model-providers.md
- Route: /concepts/model-providers
- Headings:
    - ## Quick rules
    - ## Plugin-owned provider behavior
    - ## API key rotation
    - ## Official provider plugins
      - ### OpenAI
      - ### Anthropic
      - ### OpenAI ChatGPT/Codex OAuth
      - ### Other subscription-style hosted options
      - ### OpenCode
      - ### Google Gemini (API key)
      - ### Google Vertex and Gemini CLI
      - ### Z.AI (GLM)
      - ### Vercel AI Gateway
      - ### Other bundled provider plugins
        - #### Quirks worth knowing
    - ## Providers via models.providers (custom/base URL)
      - ### Moonshot AI (Kimi)
      - ### Kimi coding
      - ### Volcano Engine (Doubao)
      - ### BytePlus (International)
      - ### Synthetic
      - ### MiniMax
      - ### LM Studio
      - ### Ollama
      - ### vLLM
      - ### SGLang
      - ### Local proxies (LM Studio, vLLM, LiteLLM, etc.)
    - ## CLI examples
    - ## Related

## concepts/models.md
- Route: /concepts/models
- Headings:
    - ## How model selection works
    - ## Selection source and fallback behavior
    - ## Quick model policy
    - ## Onboarding (recommended)
    - ## Config keys (overview)
      - ### Safe allowlist edits
    - ## "Model is not allowed" (and why replies stop)
    - ## Switching models in chat (/model)
    - ## CLI commands
      - ### models list
      - ### models status
    - ## Scanning (OpenRouter free models)
    - ## Models registry (models.json)
    - ## Related

## concepts/multi-agent.md
- Route: /concepts/multi-agent
- Headings:
    - ## What is "one agent"?
    - ## Paths (quick map)
      - ### Single-agent mode (default)
    - ## Agent helper
    - ## Quick start
    - ## Multiple agents = multiple people, multiple personalities
    - ## Cross-agent QMD memory search
    - ## One WhatsApp number, multiple people (DM split)
    - ## Routing rules (how messages pick an agent)
    - ## Multiple accounts / phone numbers
    - ## Concepts
    - ## Platform examples
    - ## Common patterns
    - ## Per-agent sandbox and tool configuration
    - ## Related

## concepts/oauth.md
- Route: /concepts/oauth
- Headings:
    - ## The token sink (why it exists)
    - ## Storage (where tokens live)
    - ## Anthropic legacy token compatibility
    - ## Anthropic Claude CLI migration
    - ## OAuth exchange (how login works)
      - ### Anthropic setup-token
      - ### OpenAI Codex (ChatGPT OAuth)
    - ## Refresh + expiry
    - ## Multiple accounts (profiles) + routing
      - ### 1) Preferred: separate agents
      - ### 2) Advanced: multiple profiles in one agent
    - ## Related

## concepts/parallel-specialist-lanes.md
- Route: /concepts/parallel-specialist-lanes
- Headings:
    - ## First principles
    - ## Recommended rollout
      - ### Phase 1: lane contracts + background heavy work
      - ### Phase 2: priority and concurrency controls
      - ### Phase 3: coordinator / traffic controller
    - ## Minimal lane contract template
    - ## Related

## concepts/personal-agent-benchmark-pack.md
- Route: /concepts/personal-agent-benchmark-pack
- Headings:
    - ## Scenarios
    - ## Privacy Model
    - ## Extending The Pack

## concepts/presence.md
- Route: /concepts/presence
- Headings:
    - ## Presence fields (what shows up)
    - ## Producers (where presence comes from)
      - ### 1) Gateway self entry
      - ### 2) WebSocket connect
        - #### Why one-off CLI commands do not show up
      - ### 3) system-event beacons
      - ### 4) Node connects (role: node)
    - ## Merge + dedupe rules (why instanceId matters)
    - ## TTL and bounded size
    - ## Remote/tunnel caveat (loopback IPs)
    - ## Consumers
      - ### macOS Instances tab
    - ## Debugging tips
    - ## Related

## concepts/progress-drafts.md
- Route: /concepts/progress-drafts
- Headings:
    - ## Quick start
    - ## What users see
    - ## Choose a mode
    - ## Configure labels
    - ## Control progress lines
    - ## Channel behavior
    - ## Finalization
    - ## Troubleshooting
    - ## Related

## concepts/qa-e2e-automation.md
- Route: /concepts/qa-e2e-automation
- Headings:
    - ## Command surface
    - ## Operator flow
    - ## Live transport coverage
    - ## Telegram, Discord, Slack, and WhatsApp QA reference
      - ### Shared CLI flags
      - ### Telegram QA
      - ### Discord QA
      - ### Slack QA
        - #### Setting up the Slack workspace
      - ### WhatsApp QA
      - ### Convex credential pool
    - ## Repo-backed seeds
    - ## Provider mock lanes
    - ## Transport adapters
      - ### Adding a channel
      - ### Scenario helper names
    - ## Reporting
    - ## Related docs

## concepts/qa-matrix.md
- Route: /concepts/qa-matrix
- Headings:
    - ## Quick start
    - ## What the lane does
    - ## CLI
      - ### Common flags
      - ### Provider flags
    - ## Profiles
    - ## Scenarios
    - ## Environment variables
    - ## Output artifacts
    - ## Triage tips
    - ## Live transport contract
    - ## Related

## concepts/queue-steering.md
- Route: /concepts/queue-steering
- Headings:
    - ## Runtime boundary
    - ## Modes
    - ## Burst example
    - ## Scope
    - ## Debounce
    - ## Related

## concepts/queue.md
- Route: /concepts/queue
- Headings:
    - ## Why
    - ## How it works
    - ## Defaults
    - ## Queue modes
    - ## Queue options
    - ## Steer and streaming
    - ## Precedence
    - ## Per-session overrides
    - ## Scope and guarantees
    - ## Troubleshooting
    - ## Related

## concepts/retry.md
- Route: /concepts/retry
- Headings:
    - ## Goals
    - ## Defaults
    - ## Behavior
      - ### Model providers
      - ### Discord
      - ### Telegram
    - ## Configuration
    - ## Notes
    - ## Related

## concepts/session-pruning.md
- Route: /concepts/session-pruning
- Headings:
    - ## Why it matters
    - ## How it works
    - ## Legacy image cleanup
    - ## Smart defaults
    - ## Enable or disable
    - ## Pruning vs compaction
    - ## Further reading
    - ## Related

## concepts/session-tool.md
- Route: /concepts/session-tool
- Headings:
    - ## Available tools
    - ## Listing and reading sessions
    - ## Sending cross-session messages
    - ## Status and orchestration helpers
    - ## Spawning sub-agents
    - ## Visibility
    - ## Further reading
    - ## Related

## concepts/session.md
- Route: /concepts/session
- Headings:
    - ## How messages are routed
    - ## DM isolation
      - ### Dock linked channels
    - ## Session lifecycle
    - ## Where state lives
    - ## Session maintenance
    - ## Inspecting sessions
    - ## Further reading
    - ## Related

## concepts/soul.md
- Route: /concepts/soul
- Headings:
    - ## What belongs in SOUL.md
    - ## Why this works
    - ## The Molty prompt
    - ## What good looks like
    - ## One warning
    - ## Related

## concepts/streaming.md
- Route: /concepts/streaming
- Headings:
    - ## Block streaming (channel messages)
      - ### Media delivery with block streaming
    - ## Chunking algorithm (low/high bounds)
    - ## Coalescing (merge streamed blocks)
    - ## Human-like pacing between blocks
    - ## "Stream chunks or everything"
    - ## Preview streaming modes
      - ### Channel mapping
      - ### Runtime behavior
      - ### Tool-progress preview updates
    - ## Related

## concepts/system-prompt.md
- Route: /concepts/system-prompt
- Headings:
    - ## Structure
    - ## Prompt modes
    - ## Prompt snapshots
    - ## Workspace bootstrap injection
    - ## Time handling
    - ## Skills
    - ## Documentation
    - ## Related

## concepts/timezone.md
- Route: /concepts/timezone
- Headings:
    - ## Three timezone surfaces
    - ## Setting the user timezone
    - ## When to override
    - ## Related

## concepts/typebox.md
- Route: /concepts/typebox
- Headings:
    - ## Mental model (30 seconds)
    - ## Where the schemas live
    - ## Current pipeline
    - ## How the schemas are used at runtime
    - ## Example frames
    - ## Minimal client (Node.js)
    - ## Worked example: add a method end-to-end
    - ## Swift codegen behavior
    - ## Versioning + compatibility
    - ## Schema patterns and conventions
    - ## Live schema JSON
    - ## When you change schemas
    - ## Related

## concepts/typing-indicators.md
- Route: /concepts/typing-indicators
- Headings:
    - ## Defaults
    - ## Modes
    - ## Configuration
    - ## Notes
    - ## Related

## concepts/usage-tracking.md
- Route: /concepts/usage-tracking
- Headings:
    - ## What it is
    - ## Where it shows up
    - ## Custom /usage full footer
      - ### Shape
      - ### Contract Paths
      - ### Verbs
      - ### Piece forms
      - ### Example
    - ## Providers + credentials
    - ## Related

## date-time.md
- Route: /date-time
- Headings:
    - ## Message envelopes (local by default)
      - ### Examples
    - ## System prompt: current date and time
    - ## System event lines (local by default)
      - ### Configure user timezone + format
    - ## Time format detection (auto)
    - ## Tool payloads + connectors (raw provider time + normalized fields)
    - ## Related docs

## debug/node-issue.md
- Route: /debug/node-issue
- Headings:
  - # Node + tsx "\\name is not a function" crash
    - ## Summary
    - ## Environment
    - ## Repro (Node-only)
    - ## Minimal repro in repo
    - ## Node version check
    - ## Notes / hypothesis
    - ## Regression history
    - ## Workarounds
    - ## References
    - ## Next steps
    - ## Related

## diagnostics/flags.md
- Route: /diagnostics/flags
- Headings:
    - ## How it works
    - ## Enable via config
    - ## Env override (one-off)
    - ## Profiling flags
    - ## Timeline artifacts
    - ## Where logs go
    - ## Extract logs
    - ## Notes
    - ## Related

## gateway/authentication.md
- Route: /gateway/authentication
- Headings:
    - ## Recommended setup (API key, any provider)
    - ## Anthropic: Claude CLI and token compatibility
    - ## Anthropic note
    - ## Checking model auth status
    - ## API key rotation behavior (gateway)
    - ## Removing provider auth while the gateway is running
    - ## Controlling which credential is used
      - ### OpenAI and legacy openai-codex ids
      - ### During login (CLI)
      - ### Per-session (chat command)
      - ### Per-agent (CLI override)
    - ## Troubleshooting
      - ### "No credentials found"
      - ### Token expiring/expired
    - ## Related

## gateway/background-process.md
- Route: /gateway/background-process
- Headings:
    - ## exec tool
    - ## Child process bridging
    - ## process tool
    - ## Examples
    - ## Related

## gateway/bonjour.md
- Route: /gateway/bonjour
- Headings:
    - ## Wide-area Bonjour (Unicast DNS-SD) over Tailscale
      - ### Gateway config (recommended)
      - ### One-time DNS server setup (gateway host)
      - ### Tailscale DNS settings
      - ### Gateway listener security (recommended)
    - ## What advertises
    - ## Service types
    - ## TXT keys (non-secret hints)
    - ## Debugging on macOS
    - ## Debugging in Gateway logs
    - ## Debugging on iOS node
    - ## When to enable Bonjour
    - ## When to disable Bonjour
    - ## Docker gotchas
    - ## Troubleshooting disabled Bonjour
    - ## Common failure modes
    - ## Escaped instance names (\032)
    - ## Enabling / disabling / configuration
    - ## Related docs

## gateway/bridge-protocol.md
- Route: /gateway/bridge-protocol
- Headings:
    - ## Why it existed
    - ## Transport
    - ## Handshake + pairing
    - ## Frames
    - ## Exec lifecycle events
    - ## Historical tailnet usage
    - ## Versioning
    - ## Related

## gateway/cli-backends.md
- Route: /gateway/cli-backends
- Headings:
    - ## Beginner-friendly quick start
    - ## Using it as a fallback
    - ## Configuration overview
      - ### Example configuration
    - ## How it works
    - ## Sessions
    - ## Fallback prelude from claude-cli sessions
    - ## Images (pass-through)
    - ## Inputs / outputs
    - ## Defaults (plugin-owned)
    - ## Plugin-owned defaults
    - ## Native compaction ownership
    - ## Bundle MCP overlays
    - ## Reseed history cap
    - ## Limitations
    - ## Troubleshooting
    - ## Related

## gateway/config-agents.md
- Route: /gateway/config-agents
- Headings:
    - ## Agent defaults
      - ### agents.defaults.workspace
      - ### agents.defaults.repoRoot
      - ### agents.defaults.skills
      - ### agents.defaults.skipBootstrap
      - ### agents.defaults.skipOptionalBootstrapFiles
      - ### agents.defaults.contextInjection
      - ### agents.defaults.bootstrapMaxChars
      - ### agents.defaults.bootstrapTotalMaxChars
      - ### Per-agent bootstrap profile overrides
      - ### agents.defaults.bootstrapPromptTruncationWarning
      - ### Context budget ownership map
        - #### agents.defaults.startupContext
        - #### agents.defaults.contextLimits
        - #### agents.list[].contextLimits
        - #### skills.limits.maxSkillsPromptChars
        - #### agents.list[].skillsLimits.maxSkillsPromptChars
      - ### agents.defaults.imageMaxDimensionPx
      - ### agents.defaults.imageQuality
      - ### agents.defaults.userTimezone
      - ### agents.defaults.timeFormat
      - ### agents.defaults.model
      - ### Runtime policy
      - ### agents.defaults.cliBackends
      - ### agents.defaults.promptOverlays
      - ### agents.defaults.heartbeat
      - ### agents.defaults.compaction
      - ### agents.defaults.runRetries
      - ### agents.defaults.contextPruning
      - ### Block streaming
      - ### Typing indicators
      - ### agents.defaults.sandbox
      - ### agents.list (per-agent overrides)
    - ## Multi-agent routing
      - ### Binding match fields
      - ### Per-agent access profiles
    - ## Session
    - ## Messages
      - ### Response prefix
      - ### Ack reaction
      - ### Inbound debounce
      - ### TTS (text-to-speech)
    - ## Talk
    - ## Related

## gateway/config-channels.md
- Route: /gateway/config-channels
- Headings:
    - ## Channels
      - ### DM and group access
      - ### Channel model overrides
      - ### Channel defaults and heartbeat
      - ### WhatsApp
      - ### Telegram
      - ### Discord
      - ### Google Chat
      - ### Slack
      - ### Mattermost
      - ### Signal
      - ### iMessage
      - ### Matrix
      - ### Microsoft Teams
      - ### IRC
      - ### Multi-account (all channels)
      - ### Other plugin channels
      - ### Group chat mention gating
        - #### DM history limits
        - #### Self-chat mode
      - ### Commands (chat command handling)
    - ## Related

## gateway/config-tools.md
- Route: /gateway/config-tools
- Headings:
    - ## Tools
      - ### Tool profiles
      - ### Tool groups
      - ### MCP and plugin tools inside sandbox tool policy
      - ### tools.codeMode
      - ### tools.allow / tools.deny
      - ### tools.byProvider
      - ### tools.toolsBySender
      - ### tools.elevated
      - ### tools.exec
      - ### tools.loopDetection
      - ### tools.web
      - ### tools.media
      - ### tools.agentToAgent
      - ### tools.sessions
      - ### tools.sessionsspawn
      - ### tools.experimental
      - ### agents.defaults.subagents
    - ## Custom providers and base URLs
      - ### Provider field details
      - ### Provider examples
    - ## Related

## gateway/configuration-examples.md
- Route: /gateway/configuration-examples
- Headings:
    - ## Quick start
      - ### Absolute minimum
      - ### Recommended starter
    - ## Expanded example (major options)
      - ### Symlinked sibling skill repo
    - ## Common patterns
      - ### Shared skill baseline with one override
      - ### Multi-platform setup
      - ### Trusted node network auto-approval
      - ### Secure DM mode (shared inbox / multi-user DMs)
      - ### Anthropic API key + MiniMax fallback
      - ### Work bot (restricted access)
      - ### Local models only
    - ## Tips
    - ## Related

## gateway/configuration-reference.md
- Route: /gateway/configuration-reference
- Headings:
    - ## Channels
    - ## Agent defaults, multi-agent, sessions, and messages
    - ## Tools and custom providers
    - ## Models
    - ## MCP
    - ## Skills
    - ## Plugins
      - ### Codex harness plugin config
    - ## Commitments
    - ## Browser
    - ## UI
    - ## Gateway
      - ### OpenAI-compatible endpoints
      - ### Multi-instance isolation
      - ### gateway.tls
      - ### gateway.reload
    - ## Hooks
      - ### Gmail integration
    - ## Canvas plugin host
    - ## Discovery
      - ### mDNS (Bonjour)
      - ### Wide-area (DNS-SD)
    - ## Environment
      - ### env (inline env vars)
      - ### Env var substitution
    - ## Secrets
      - ### SecretRef
      - ### Supported credential surface
      - ### Secret providers config
    - ## Auth storage
      - ### auth.cooldowns
    - ## Logging
    - ## Diagnostics
    - ## Update
    - ## ACP
    - ## CLI
    - ## Wizard
    - ## Identity
    - ## Bridge (legacy, removed)
    - ## Cron
      - ### cron.retry
      - ### cron.failureAlert
      - ### cron.failureDestination
    - ## Media model template variables
    - ## Config includes ($include)
    - ## Related

## gateway/configuration.md
- Route: /gateway/configuration
- Headings:
    - ## Minimal config
    - ## Editing config
    - ## Strict validation
    - ## Common tasks
    - ## Config hot reload
      - ### Reload modes
      - ### What hot-applies vs what needs a restart
      - ### Reload planning
    - ## Config RPC (programmatic updates)
    - ## Environment variables
    - ## Full reference
    - ## Related

## gateway/diagnostics.md
- Route: /gateway/diagnostics
- Headings:
    - ## Quick start
    - ## Chat command
    - ## What the export contains
    - ## Privacy model
    - ## Stability recorder
    - ## Useful options
    - ## Disable diagnostics
    - ## Related

## gateway/discovery.md
- Route: /gateway/discovery
- Headings:
    - ## Terms
    - ## Why we keep both direct and SSH
    - ## Discovery inputs (how clients learn where the gateway is)
      - ### 1) Bonjour / DNS-SD discovery
        - #### Service beacon details
      - ### 2) Tailnet (cross-network)
      - ### 3) Manual / SSH target
    - ## Transport selection (client policy)
    - ## Pairing + auth (direct transport)
    - ## Responsibilities by component
    - ## Related

## gateway/doctor.md
- Route: /gateway/doctor
- Headings:
    - ## Quick start
      - ### Headless and automation modes
    - ## Read-only lint mode
    - ## What it does (summary)
    - ## Dreams UI backfill and reset
    - ## Detailed behavior and rationale
    - ## Related

## gateway/external-apps.md
- Route: /gateway/external-apps
- Headings:
    - ## What is available today
    - ## Recommended path
    - ## App code vs plugin code
    - ## Related

## gateway/gateway-lock.md
- Route: /gateway/gateway-lock
- Headings:
    - ## Why
    - ## Mechanism
    - ## Error surface
    - ## Operational notes
    - ## Related

## gateway/health.md
- Route: /gateway/health
- Headings:
    - ## Quick checks
    - ## Deep diagnostics
    - ## Health monitor config
    - ## Uptime monitoring
      - ### Monitoring service setup examples
    - ## When something fails
    - ## Dedicated "health" command
    - ## Related

## gateway/heartbeat.md
- Route: /gateway/heartbeat
- Headings:
    - ## Quick start (beginner)
    - ## Defaults
    - ## What the heartbeat prompt is for
    - ## Response contract
    - ## Config
      - ### Scope and precedence
      - ### Per-agent heartbeats
      - ### Active hours example
      - ### 24/7 setup
      - ### Multi-account example
      - ### Field notes
    - ## Delivery behavior
    - ## Visibility controls
      - ### What each flag does
      - ### Per-channel vs per-account examples
      - ### Common patterns
    - ## HEARTBEAT.md (optional)
      - ### tasks: blocks
      - ### Can the agent update HEARTBEAT.md?
    - ## Manual wake (on-demand)
    - ## Reasoning delivery (optional)
    - ## Cost awareness
    - ## Context overflow after heartbeat
    - ## Related

## gateway/index.md
- Route: /gateway
- Headings:
    - ## 5-minute local startup
    - ## Runtime model
    - ## OpenAI-compatible endpoints
      - ### Port and bind precedence
      - ### Hot reload modes
    - ## Operator command set
    - ## Multiple gateways (same host)
    - ## Remote access
    - ## Supervision and service lifecycle
    - ## Dev profile quick path
    - ## Protocol quick reference (operator view)
    - ## Operational checks
      - ### Liveness
      - ### Readiness
      - ### Gap recovery
    - ## Common failure signatures
    - ## Safety guarantees
    - ## Related

## gateway/local-model-services.md
- Route: /gateway/local-model-services
- Headings:
    - ## How it works
    - ## Config shape
    - ## Fields
    - ## Inferrs example
    - ## ds4 example
    - ## Operational notes
    - ## Related

## gateway/local-models.md
- Route: /gateway/local-models
- Headings:
    - ## Hardware floor
    - ## Pick a backend
    - ## Recommended: LM Studio + large local model (Responses API)
      - ### Hybrid config: hosted primary, local fallback
      - ### Local-first with hosted safety net
      - ### Regional hosting / data routing
    - ## Other OpenAI-compatible local proxies
    - ## Smaller or stricter backends
    - ## Troubleshooting
    - ## Related

## gateway/logging.md
- Route: /gateway/logging
- Headings:
  - # Logging
    - ## File-based logger
    - ## Console capture
    - ## Redaction
    - ## Gateway WebSocket logs
      - ### WS log style
    - ## Console formatting (subsystem logging)
    - ## Related

## gateway/multiple-gateways.md
- Route: /gateway/multiple-gateways
- Headings:
    - ## Best recommended setup
    - ## Rescue-Bot Quickstart
    - ## Why this works
    - ## What --profile rescue onboard Changes
    - ## General multi-gateway setup
    - ## Isolation checklist
    - ## Port mapping (derived)
    - ## Browser/CDP notes (common footgun)
    - ## Manual env example
    - ## Quick checks
    - ## Related

## gateway/network-model.md
- Route: /gateway/network-model
- Headings:
    - ## Related

## gateway/openai-http-api.md
- Route: /gateway/openai-http-api
- Headings:
    - ## Authentication
    - ## Security boundary (important)
    - ## When to use this endpoint
    - ## Agent-first model contract
    - ## Enabling the endpoint
    - ## Disabling the endpoint
    - ## Session behavior
    - ## Why this surface matters
    - ## Model list and agent routing
    - ## Streaming (SSE)
    - ## Chat tool contract
      - ### Supported request fields
      - ### Unsupported variants
      - ### Non-streaming tool response shape
      - ### Streaming tool response shape
      - ### Tool follow-up loop
    - ## Open WebUI quick setup
    - ## Examples
    - ## Related

## gateway/openresponses-http-api.md
- Route: /gateway/openresponses-http-api
- Headings:
    - ## Authentication, security, and routing
    - ## Session behavior
    - ## Request shape (supported)
    - ## Items (input)
      - ### message
      - ### functioncalloutput (turn-based tools)
      - ### reasoning and itemreference
    - ## Tools (client-side function tools)
    - ## Images (inputimage)
    - ## Files (inputfile)
    - ## File + image limits (config)
    - ## Streaming (SSE)
    - ## Usage
    - ## Errors
    - ## Examples
    - ## Related

## gateway/openshell.md
- Route: /gateway/openshell
- Headings:
    - ## Prerequisites
    - ## Quick start
    - ## Workspace modes
      - ### mirror
      - ### remote
      - ### Choosing a mode
    - ## Configuration reference
    - ## Examples
      - ### Minimal remote setup
      - ### Mirror mode with GPU
      - ### Per-agent OpenShell with custom gateway
    - ## Lifecycle management
      - ### When to recreate
    - ## Security hardening
    - ## Current limitations
    - ## How it works
    - ## Related

## gateway/opentelemetry.md
- Route: /gateway/opentelemetry
- Headings:
    - ## How it fits together
    - ## Quick start
    - ## Signals exported
    - ## Configuration reference
      - ### Environment variables
    - ## Privacy and content capture
    - ## Sampling and flushing
    - ## Exported metrics
      - ### Model usage
      - ### Message flow
      - ### Talk
      - ### Queues and sessions
      - ### Session liveness telemetry
      - ### Harness lifecycle
      - ### Tool execution
      - ### Exec
      - ### Diagnostics internals (memory and tool loop)
    - ## Exported spans
    - ## Diagnostic event catalog
    - ## Without an exporter
    - ## Disable
    - ## Related

## gateway/operator-scopes.md
- Route: /gateway/operator-scopes
- Headings:
    - ## Roles
    - ## Scope levels
    - ## Method scope is only the first gate
    - ## Device pairing approvals
    - ## Node pairing approvals
    - ## Shared-secret auth

## gateway/pairing.md
- Route: /gateway/pairing
- Headings:
    - ## Concepts
    - ## How pairing works
    - ## CLI workflow (headless friendly)
    - ## API surface (gateway protocol)
    - ## Node command gating (2026.3.31+)
    - ## Node event trust boundaries (2026.3.31+)
    - ## Auto-approval (macOS app)
    - ## Trusted-CIDR device auto-approval
    - ## Metadata-upgrade auto-approval
    - ## QR pairing helpers
    - ## Locality and forwarded headers
    - ## Storage (local, private)
    - ## Transport behavior
    - ## Related

## gateway/prometheus.md
- Route: /gateway/prometheus
- Headings:
    - ## Quick start
    - ## Metrics exported
    - ## Label policy
    - ## PromQL recipes
    - ## Choosing between Prometheus and OpenTelemetry export
    - ## Troubleshooting
    - ## Related

## gateway/protocol.md
- Route: /gateway/protocol
- Headings:
    - ## Transport
    - ## Handshake (connect)
      - ### Node example
    - ## Framing
    - ## Roles + scopes
      - ### Roles
      - ### Scopes (operator)
      - ### Caps/commands/permissions (node)
    - ## Presence
      - ### Node background alive event
    - ## Broadcast event scoping
    - ## Common RPC method families
      - ### Common event families
      - ### Node helper methods
      - ### Task ledger RPCs
      - ### Operator helper methods
      - ### models.list views
    - ## Exec approvals
    - ## Agent delivery fallback
    - ## Versioning
      - ### Client constants
    - ## Auth
    - ## Device identity + pairing
      - ### Device auth migration diagnostics
    - ## TLS + pinning
    - ## Scope
    - ## Related

## gateway/remote-gateway-readme.md
- Route: /gateway/remote-gateway-readme
- Headings:
  - # Running OpenClaw.app with a Remote Gateway
    - ## Overview
    - ## Quick setup
      - ### Step 1: Add SSH Config
      - ### Step 2: Copy SSH Key
      - ### Step 3: Configure Remote Gateway Auth
      - ### Step 4: Start SSH Tunnel
      - ### Step 5: Restart OpenClaw.app
    - ## Auto-Start Tunnel on Login
      - ### Create the PLIST file
      - ### Load the Launch Agent
    - ## Troubleshooting
    - ## How it works
    - ## Related

## gateway/remote.md
- Route: /gateway/remote
- Headings:
    - ## The core idea
    - ## Common VPN and tailnet setups
      - ### Always-on Gateway in your tailnet
      - ### Home desktop runs the Gateway
      - ### Laptop runs the Gateway
    - ## Command flow (what runs where)
    - ## SSH tunnel (CLI + tools)
    - ## CLI remote defaults
    - ## Credential precedence
    - ## Chat UI remote access
    - ## macOS app remote mode
    - ## Security rules (remote/VPN)
      - ### macOS: persistent SSH tunnel via LaunchAgent
        - #### Step 1: add SSH config
        - #### Step 2: copy SSH key (one-time)
        - #### Step 3: configure the gateway token
        - #### Step 4: create the LaunchAgent
        - #### Step 5: load the LaunchAgent
        - #### Troubleshooting
    - ## Related

## gateway/sandbox-vs-tool-policy-vs-elevated.md
- Route: /gateway/sandbox-vs-tool-policy-vs-elevated
- Headings:
    - ## Quick debug
    - ## Sandbox: where tools run
      - ### Bind mounts (security quick check)
    - ## Tool policy: which tools exist/are callable
      - ### Tool groups (shorthands)
    - ## Elevated: exec-only "run on host"
    - ## Common "sandbox jail" fixes
      - ### "Tool X blocked by sandbox tool policy"
      - ### "I thought this was main, why is it sandboxed?"
    - ## Related

## gateway/sandboxing.md
- Route: /gateway/sandboxing
- Headings:
    - ## What gets sandboxed
    - ## Modes
    - ## Scope
    - ## Backend
      - ### Choosing a backend
      - ### Docker backend
      - ### SSH backend
      - ### OpenShell backend
        - #### Workspace modes
        - #### OpenShell lifecycle
    - ## Workspace access
    - ## Custom bind mounts
    - ## Images and setup
    - ## setupCommand (one-time container setup)
    - ## Tool policy and escape hatches
    - ## Multi-agent overrides
    - ## Minimal enable example
    - ## Related

## gateway/secrets-plan-contract.md
- Route: /gateway/secrets-plan-contract
- Headings:
    - ## Plan file shape
    - ## Provider upserts and deletes
    - ## Supported target scope
    - ## Target type behavior
    - ## Path validation rules
    - ## Failure behavior
    - ## Exec provider consent behavior
    - ## Runtime and audit scope notes
    - ## Operator checks
    - ## Related docs

## gateway/secrets.md
- Route: /gateway/secrets
- Headings:
    - ## Goals and runtime model
    - ## Agent-access boundary
    - ## Active-surface filtering
    - ## Gateway auth surface diagnostics
    - ## Onboarding reference preflight
    - ## SecretRef contract
    - ## Provider config
    - ## File-backed API keys
    - ## Exec integration examples
    - ## MCP server environment variables
    - ## Sandbox SSH auth material
    - ## Supported credential surface
    - ## Required behavior and precedence
    - ## Activation triggers
    - ## Degraded and recovered signals
    - ## Command-path resolution
    - ## Audit and configure workflow
    - ## One-way safety policy
    - ## Legacy auth compatibility notes
    - ## Web UI note
    - ## Related

## gateway/security/audit-checks.md
- Route: /gateway/security/audit-checks
- Headings:
    - ## Related

## gateway/security/exposure-runbook.md
- Route: /gateway/security/exposure-runbook
- Headings:
    - ## Choose the exposure pattern
    - ## Pre-flight inventory
    - ## Baseline checks
    - ## Minimum safe baseline
    - ## DM and group exposure
    - ## Reverse proxy checks
    - ## Tool and sandbox review
    - ## Post-change validation
    - ## Rollback plan
    - ## Review checklist

## gateway/security/index.md
- Route: /gateway/security
- Headings:
    - ## Scope first: personal assistant security model
    - ## Quick check: openclaw security audit
      - ### Published package dependency lock
      - ### Deployment and host trust
      - ### Secure file operations
      - ### Shared Slack workspace: real risk
      - ### Company-shared agent: acceptable pattern
    - ## Gateway and node trust concept
    - ## Trust boundary matrix
    - ## Not vulnerabilities by design
    - ## Hardened baseline in 60 seconds
    - ## Shared inbox quick rule
    - ## Context visibility model
    - ## What the audit checks (high level)
    - ## Credential storage map
    - ## Security audit checklist
    - ## Security audit glossary
    - ## Control UI over HTTP
    - ## Insecure or dangerous flags summary
    - ## Reverse proxy configuration
    - ## HSTS and origin notes
    - ## Local session logs live on disk
    - ## Node execution (system.run)
    - ## Dynamic skills (watcher / remote nodes)
    - ## The threat model
    - ## Core concept: access control before intelligence
    - ## Command authorization model
    - ## Control plane tools risk
    - ## Plugins
    - ## DM access model: pairing, allowlist, open, disabled
    - ## DM session isolation (multi-user mode)
      - ### Secure DM mode (recommended)
    - ## Allowlists for DMs and groups
    - ## Prompt injection (what it is, why it matters)
    - ## External content special-token sanitization
    - ## Unsafe external content bypass flags
      - ### Prompt injection does not require public DMs
      - ### Self-hosted LLM backends
      - ### Model strength (security note)
    - ## Reasoning and verbose output in groups
    - ## Configuration hardening examples
      - ### File permissions
      - ### Network exposure (bind, port, firewall)
      - ### Docker port publishing with UFW
      - ### mDNS/Bonjour discovery
      - ### Lock down the Gateway WebSocket (local auth)
      - ### Tailscale Serve identity headers
      - ### Browser control via node host (recommended)
      - ### Secrets on disk
      - ### Workspace .env files
      - ### Logs and transcripts (redaction and retention)
      - ### DMs: pairing by default
      - ### Groups: require mention everywhere
      - ### Separate numbers (WhatsApp, Signal, Telegram)
      - ### Read-only mode (via sandbox and tools)
      - ### Secure baseline (copy/paste)
    - ## Sandboxing (recommended)
      - ### Sub-agent delegation guardrail
    - ## Browser control risks
      - ### Browser SSRF policy (strict by default)
    - ## Per-agent access profiles (multi-agent)
      - ### Example: full access (no sandbox)
      - ### Example: read-only tools + read-only workspace
      - ### Example: no filesystem/shell access (provider messaging allowed)
    - ## Incident response
      - ### Contain
      - ### Rotate (assume compromise if secrets leaked)
      - ### Audit
      - ### Collect for a report
    - ## Secret scanning
    - ## Reporting security issues

## gateway/security/secure-file-operations.md
- Route: /gateway/security/secure-file-operations
- Headings:
    - ## Default: no Python helper
    - ## What stays protected without Python
    - ## What Python adds
    - ## Plugin and core guidance

## gateway/security/shrinkwrap.md
- Route: /gateway/security/shrinkwrap
- Headings:
    - ## The easy version
    - ## Why OpenClaw uses it
    - ## Technical details

## gateway/tailscale.md
- Route: /gateway/tailscale
- Headings:
    - ## Modes
    - ## Auth
    - ## Config examples
      - ### Tailnet-only (Serve)
      - ### Tailnet-only (bind to Tailnet IP)
      - ### Public internet (Funnel + shared password)
    - ## CLI examples
    - ## Notes
    - ## Browser control (remote Gateway + local browser)
    - ## Tailscale prerequisites + limits
    - ## Learn more
    - ## Related

## gateway/tools-invoke-http-api.md
- Route: /gateway/tools-invoke-http-api
- Headings:
    - ## Authentication
    - ## Security boundary (important)
    - ## Request body
    - ## Policy + routing behavior
    - ## Responses
    - ## Example
    - ## Related

## gateway/troubleshooting.md
- Route: /gateway/troubleshooting
- Headings:
    - ## Command ladder
    - ## After an update
    - ## Split brain installs and newer config guard
    - ## Protocol mismatch after rollback
    - ## Skill symlink skipped as path escape
    - ## Anthropic 429 extra usage required for long context
    - ## Upstream 403 blocked responses
    - ## Local OpenAI-compatible backend passes direct probes but agent runs fail
    - ## No replies
    - ## Dashboard control UI connectivity
      - ### Auth detail codes quick map
    - ## Gateway service not running
    - ## macOS gateway silently stops responding, then resumes when you touch the dashboard
    - ## Gateway exits during high memory use
    - ## Gateway rejected invalid config
    - ## Gateway probe warnings
    - ## Channel connected, messages not flowing
    - ## Cron and heartbeat delivery
    - ## Node paired, tool fails
    - ## Browser tool fails
    - ## If you upgraded and something suddenly broke
    - ## Related

## gateway/trusted-proxy-auth.md
- Route: /gateway/trusted-proxy-auth
- Headings:
    - ## When to use
    - ## When NOT to use
    - ## How it works
    - ## Control UI pairing behavior
    - ## Configuration
      - ### Configuration reference
    - ## TLS termination and HSTS
      - ### Rollout guidance
    - ## Proxy setup examples
    - ## Mixed token configuration
    - ## Operator scopes header
    - ## Security checklist
    - ## Security audit
    - ## Troubleshooting
    - ## Migration from token auth
    - ## Related

## help/debugging.md
- Route: /help/debugging
- Headings:
    - ## Runtime debug overrides
    - ## Session trace output
    - ## Plugin lifecycle trace
    - ## CLI startup and command profiling
    - ## Gateway watch mode
    - ## Dev profile + dev gateway (--dev)
    - ## Raw stream logging (OpenClaw)
    - ## Raw OpenAI-compatible chunk logging
    - ## Safety notes
    - ## Debugging in VSCode
      - ### Setup
      - ### Notes
    - ## Related

## help/environment.md
- Route: /help/environment
- Headings:
    - ## Precedence (highest → lowest)
    - ## Provider credentials and workspace .env
    - ## Config env block
    - ## Shell env import
    - ## Exec shell snapshots
    - ## Runtime-injected env vars
    - ## UI env vars
    - ## Env var substitution in config
    - ## Secret refs vs ${ENV} strings
    - ## Path-related env vars
    - ## Logging
      - ### OPENCLAWHOME
    - ## nvm users: webfetch TLS failures
    - ## Legacy environment variables
    - ## Related

## help/faq-first-run.md
- Route: /help/faq-first-run
- Headings:
    - ## Quick start and first-run setup
    - ## Related

## help/faq-models.md
- Route: /help/faq-models
- Headings:
    - ## Models: defaults, selection, aliases, switching
    - ## Model failover and "All models failed"
    - ## Auth profiles: what they are and how to manage them
    - ## Related

## help/faq.md
- Route: /help/faq
- Headings:
    - ## First 60 seconds if something is broken
    - ## Quick start and first-run setup
    - ## What is OpenClaw?
    - ## Skills and automation
    - ## Sandboxing and memory
    - ## Where things live on disk
    - ## Config basics
    - ## Remote gateways and nodes
    - ## Env vars and .env loading
    - ## Sessions and multiple chats
    - ## Models, failover, and auth profiles
    - ## Gateway: ports, "already running", and remote mode
    - ## Logging and debugging
    - ## Media and attachments
    - ## Security and access control
    - ## Chat commands, aborting tasks, and "it will not stop"
    - ## Miscellaneous
    - ## Related

## help/index.md
- Route: /help
- Headings:
    - ## FAQ
    - ## Diagnostics
    - ## Testing
    - ## Community and meta

## help/scripts.md
- Route: /help/scripts
- Headings:
    - ## Conventions
    - ## Auth monitoring scripts
    - ## GitHub read helper
    - ## When adding scripts
    - ## Related

## help/testing-live.md
- Route: /help/testing-live
- Headings:
    - ## Live: local smoke commands
    - ## Live: Android node capability sweep
    - ## Live: model smoke (profile keys)
      - ### Layer 1: Direct model completion (no gateway)
      - ### Layer 2: Gateway + dev agent smoke (what "@openclaw" actually does)
    - ## Live: CLI backend smoke (Claude, Gemini, or other local CLIs)
    - ## Live: APNs HTTP/2 proxy reachability
    - ## Live: ACP bind smoke (/acp spawn ... --bind here)
    - ## Live: Codex app-server harness smoke
      - ### Recommended live recipes
    - ## Live: model matrix (what we cover)
      - ### Modern smoke set (tool calling + image)
      - ### Baseline: tool calling (Read + optional Exec)
      - ### Vision: image send (attachment → multimodal message)
      - ### Aggregators / alternate gateways
    - ## Credentials (never commit)
    - ## Deepgram live (audio transcription)
    - ## BytePlus coding plan live
    - ## ComfyUI workflow media live
    - ## Image generation live
    - ## Music generation live
    - ## Video generation live
    - ## Media live harness
    - ## Related

## help/testing-updates-plugins.md
- Route: /help/testing-updates-plugins
- Headings:
    - ## What we protect
    - ## Local proof during development
    - ## Docker lanes
    - ## Package Acceptance
    - ## Release default
    - ## Legacy compatibility
    - ## Adding coverage
    - ## Failure triage

## help/testing.md
- Route: /help/testing
- Headings:
    - ## Quick start
    - ## Test Temp Directories
    - ## QA-specific runners
      - ### Shared Telegram credentials via Convex (v1)
      - ### Adding a channel to QA
    - ## Test suites (what runs where)
      - ### Unit / integration (default)
      - ### Stability (gateway)
      - ### E2E (repo aggregate)
      - ### E2E (gateway smoke)
      - ### E2E (Control UI mocked browser)
      - ### E2E: OpenShell backend smoke
      - ### Live (real providers + real models)
    - ## Which suite should I run?
    - ## Live (network-touching) tests
    - ## Docker runners (optional "works in Linux" checks)
    - ## Docs sanity
    - ## Offline regression (CI-safe)
    - ## Agent reliability evals (skills)
    - ## Contract tests (plugin and channel shape)
      - ### Commands
      - ### Channel contracts
      - ### Provider status contracts
      - ### Provider contracts
      - ### When to run
    - ## Adding regressions (guidance)
    - ## Related

## help/troubleshooting.md
- Route: /help/troubleshooting
- Headings:
    - ## First 60 seconds
    - ## Assistant feels limited or missing tools
    - ## Anthropic long context 429
    - ## Local OpenAI-compatible backend works directly but fails in OpenClaw
    - ## Plugin install fails with missing openclaw extensions
    - ## Install policy blocks plugin installs or updates
    - ## Plugin present but blocked by suspicious ownership
    - ## Decision tree
    - ## Related

## index.md
- Route: /
- Headings:
  - # OpenClaw 🦞
    - ## What is OpenClaw?
    - ## How it works
    - ## Key capabilities
    - ## Quick start
    - ## Dashboard
    - ## Configuration (optional)
    - ## Start here
    - ## Learn more

## install/ansible.md
- Route: /install/ansible
- Headings:
    - ## Prerequisites
    - ## What you get
    - ## Quick start
    - ## What gets installed
    - ## Post-Install Setup
      - ### Quick commands
    - ## Security architecture
    - ## Manual installation
    - ## Updating
    - ## Troubleshooting
    - ## Advanced configuration
    - ## Related

## install/azure.md
- Route: /install/azure
- Headings:
    - ## What you will do
    - ## What you need
    - ## Configure deployment
    - ## Deploy Azure resources
    - ## Install OpenClaw
    - ## Cost considerations
    - ## Cleanup
    - ## Next steps
    - ## Related

## install/bun.md
- Route: /install/bun
- Headings:
    - ## Install
    - ## Lifecycle scripts
    - ## Caveats
    - ## Related

## install/clawdock.md
- Route: /install/clawdock
- Headings:
    - ## Install
    - ## What you get
      - ### Basic operations
      - ### Container access
      - ### Web UI and pairing
      - ### Setup and maintenance
      - ### Utilities
    - ## First-time flow
    - ## Config and secrets
    - ## Related

## install/development-channels.md
- Route: /install/development-channels
- Headings:
    - ## Switching channels
    - ## One-off version or tag targeting
    - ## Dry run
    - ## Plugins and channels
    - ## Checking current status
    - ## Tagging best practices
    - ## macOS app availability
    - ## Related

## install/digitalocean.md
- Route: /install/digitalocean
- Headings:
    - ## Prerequisites
    - ## Setup
    - ## Persistence and backups
    - ## 1 GB RAM tips
    - ## Troubleshooting
    - ## Next steps
    - ## Related

## install/docker-vm-runtime.md
- Route: /install/docker-vm-runtime
- Headings:
    - ## Bake required binaries into the image
    - ## Build and launch
    - ## What persists where
    - ## Updates
    - ## Related

## install/docker.md
- Route: /install/docker
- Headings:
    - ## Is Docker right for me?
    - ## Prerequisites
    - ## Containerized gateway
      - ### Manual flow
      - ### Environment variables
      - ### Observability
      - ### Health checks
      - ### LAN vs loopback
      - ### Host Local Providers
      - ### Bonjour / mDNS
      - ### Storage and persistence
      - ### Shell helpers (optional)
      - ### Running on a VPS?
    - ## Agent sandbox
      - ### Quick enable
    - ## Troubleshooting
    - ## Related

## install/exe-dev.md
- Route: /install/exe-dev
- Headings:
    - ## Beginner quick path
    - ## What you need
    - ## Automated install with Shelley
    - ## Manual installation
    - ## 1) Create the VM
    - ## 2) Install prerequisites (on the VM)
    - ## 3) Install OpenClaw
    - ## 4) Setup nginx to proxy OpenClaw to port 8000
    - ## 5) Access OpenClaw and grant privileges
    - ## Remote channel setup
    - ## Remote access
    - ## Updating
    - ## Related

## install/fly.md
- Route: /install/fly
- Headings:
    - ## What you need
    - ## Beginner quick path
    - ## Troubleshooting
      - ### "App is not listening on expected address"
      - ### Health checks failing / connection refused
      - ### OOM / Memory Issues
      - ### Gateway lock issues
      - ### Config not being read
      - ### Writing config via SSH
      - ### State not persisting
    - ## Updates
      - ### Updating machine command
    - ## Private deployment (hardened)
      - ### When to use private deployment
      - ### Setup
      - ### Accessing a private deployment
      - ### Webhooks with private deployment
      - ### Security benefits
    - ## Notes
    - ## Cost
    - ## Next steps
    - ## Related

## install/gcp.md
- Route: /install/gcp
- Headings:
    - ## What are we doing (simple terms)?
    - ## Quick path (experienced operators)
    - ## What you need
    - ## Troubleshooting
    - ## Service accounts (security best practice)
    - ## Next steps
    - ## Related

## install/hetzner.md
- Route: /install/hetzner
- Headings:
    - ## Goal
    - ## What are we doing (simple terms)?
    - ## Quick path (experienced operators)
    - ## What you need
    - ## Infrastructure as Code (Terraform)
    - ## Next steps
    - ## Related

## install/hostinger.md
- Route: /install/hostinger
- Headings:
    - ## Prerequisites
    - ## Option A: 1-Click OpenClaw
    - ## Option B: OpenClaw on VPS
    - ## Verify your setup
    - ## Troubleshooting
    - ## Next steps
    - ## Related

## install/index.md
- Route: /install
- Headings:
    - ## System requirements
    - ## Recommended: installer script
    - ## Alternative install methods
      - ### Local prefix installer (install-cli.sh)
      - ### npm, pnpm, or bun
      - ### From source
      - ### Install from the GitHub main checkout
      - ### Containers and package managers
    - ## Verify the install
    - ## Hosting and deployment
    - ## Update, migrate, or uninstall
    - ## Troubleshooting: openclaw not found

## install/installer.md
- Route: /install/installer
- Headings:
    - ## Quick commands
    - ## install.sh
      - ### Flow (install.sh)
      - ### Source checkout detection
      - ### Examples (install.sh)
    - ## install-cli.sh
      - ### Flow (install-cli.sh)
      - ### Examples (install-cli.sh)
    - ## install.ps1
      - ### Flow (install.ps1)
      - ### Examples (install.ps1)
    - ## CI and automation
    - ## Troubleshooting
    - ## Related

## install/kubernetes.md
- Route: /install/kubernetes
- Headings:
    - ## Why not Helm?
    - ## What you need
    - ## Quick start
    - ## Local testing with Kind
    - ## Step by step
      - ### 1) Deploy
      - ### 2) Access the gateway
    - ## What gets deployed
    - ## Customization
      - ### Agent instructions
      - ### Gateway config
      - ### Add providers
      - ### Custom namespace
      - ### Custom image
      - ### Expose beyond port-forward
    - ## Re-deploy
    - ## Teardown
    - ## Architecture notes
    - ## File structure
    - ## Related

## install/macos-vm.md
- Route: /install/macos-vm
- Headings:
    - ## Recommended default (most users)
    - ## macOS VM options
      - ### Local VM on your Apple Silicon Mac (Lume)
      - ### Hosted Mac providers (cloud)
    - ## Quick path (Lume, experienced users)
    - ## What you need (Lume)
    - ## 1) Install Lume
    - ## 2) Create the macOS VM
    - ## 3) Complete Setup Assistant
    - ## 4) Get the VM IP address
    - ## 5) SSH into the VM
    - ## 6) Install OpenClaw
    - ## 7) Configure channels
    - ## 8) Run the VM headlessly
    - ## Bonus: iMessage integration
    - ## Save a golden image
    - ## Running 24/7
    - ## Troubleshooting
    - ## Related docs

## install/migrating-claude.md
- Route: /install/migrating-claude
- Headings:
    - ## Two ways to import
    - ## What gets imported
    - ## What stays archive-only
    - ## Source selection
    - ## Recommended flow
    - ## Conflict handling
    - ## JSON output for automation
    - ## Troubleshooting
    - ## Related

## install/migrating-hermes.md
- Route: /install/migrating-hermes
- Headings:
    - ## Two ways to import
    - ## What gets imported
    - ## What stays archive-only
    - ## Recommended flow
    - ## Conflict handling
    - ## Secrets
    - ## JSON output for automation
    - ## Troubleshooting
    - ## Related

## install/migrating.md
- Route: /install/migrating
- Headings:
    - ## Import from another agent system
    - ## Move OpenClaw to a new machine
      - ### Migration steps
      - ### Common pitfalls
      - ### Verification checklist
    - ## Upgrade a plugin in place
    - ## Related

## install/nix.md
- Route: /install/nix
- Headings:
    - ## What you get
    - ## Quick start
    - ## Nix-mode runtime behavior
      - ### What changes in Nix mode
      - ### Config and state paths
      - ### Service PATH discovery
    - ## Related

## install/node.md
- Route: /install/node
- Headings:
    - ## Check your version
    - ## Install Node
    - ## Troubleshooting
      - ### openclaw: command not found
      - ### Permission errors on npm install -g (Linux)
    - ## Related

## install/northflank.mdx
- Route: /install/northflank
- Headings:
  - # Northflank
    - ## How to get started
    - ## What you get
    - ## Connect a channel
    - ## Next steps

## install/oracle.md
- Route: /install/oracle
- Headings:
    - ## Prerequisites
    - ## Setup
    - ## Verify the security posture
    - ## ARM notes
    - ## Persistence and backups
    - ## Fallback: SSH tunnel
    - ## Troubleshooting
    - ## Next steps
    - ## Related

## install/podman.md
- Route: /install/podman
- Headings:
    - ## Prerequisites
    - ## Quick start
    - ## Podman and Tailscale
    - ## Systemd (Quadlet, optional)
    - ## Config, env, and storage
    - ## Useful commands
    - ## Troubleshooting
    - ## Related

## install/railway.mdx
- Route: /install/railway
- Headings:
  - # Railway
    - ## Quick checklist (new users)
    - ## One-click deploy
    - ## What you get
    - ## Required Railway settings
      - ### Public Networking
      - ### Volume (required)
      - ### Variables
    - ## Connect a channel
    - ## Backups & migration
    - ## Next steps

## install/raspberry-pi.md
- Route: /install/raspberry-pi
- Headings:
    - ## Hardware compatibility
    - ## Prerequisites
    - ## Setup
    - ## Performance tips
    - ## Recommended model setup
    - ## ARM binary notes
    - ## Persistence and backups
    - ## Troubleshooting
    - ## Next steps
    - ## Related

## install/render.mdx
- Route: /install/render
- Headings:
  - # Render
    - ## Prerequisites
    - ## Deploy with a Render Blueprint
    - ## Understanding the Blueprint
    - ## Choosing a plan
    - ## After deployment
      - ### Access the Control UI
    - ## Render Dashboard features
      - ### Logs
      - ### Shell access
      - ### Environment variables
      - ### Auto-deploy
    - ## Custom domain
    - ## Scaling
    - ## Backups and migration
    - ## Troubleshooting
      - ### Service will not start
      - ### Slow cold starts (free tier)
      - ### Data loss after redeploy
      - ### Health check failures
    - ## Next steps

## install/uninstall.md
- Route: /install/uninstall
- Headings:
    - ## Easy path (CLI still installed)
    - ## Manual service removal (CLI not installed)
      - ### macOS (launchd)
      - ### Linux (systemd user unit)
      - ### Windows (Scheduled Task)
    - ## Normal install vs source checkout
      - ### Normal install (install.sh / npm / pnpm / bun)
      - ### Source checkout (git clone)
    - ## Related

## install/updating.md
- Route: /install/updating
- Headings:
    - ## Recommended: openclaw update
    - ## Switch between npm and git installs
    - ## Alternative: re-run the installer
    - ## Alternative: manual npm, pnpm, or bun
      - ### Advanced npm install topics
    - ## Auto-updater
    - ## After updating
      - ### Run doctor
      - ### Restart the gateway
      - ### Verify
    - ## Rollback
      - ### Pin a version (npm)
      - ### Pin a commit (source)
    - ## If you are stuck
    - ## Related

## install/upstash.md
- Route: /install/upstash
- Headings:
    - ## Prerequisites
    - ## Create a Box
    - ## Connect with an SSH tunnel
    - ## Install OpenClaw
    - ## Run onboarding
    - ## Start the Gateway
    - ## Auto-restart
    - ## Troubleshooting
    - ## Related

## logging.md
- Route: /logging
- Headings:
    - ## Where logs live
    - ## How to read logs
      - ### CLI: live tail (recommended)
      - ### Control UI (web)
      - ### Channel-only logs
    - ## Log formats
      - ### File logs (JSONL)
      - ### Console output
      - ### Gateway WebSocket logs
    - ## Configuring logging
      - ### Log levels
      - ### Targeted model transport diagnostics
      - ### Trace correlation
      - ### Model call size and timing
      - ### Console styles
      - ### Redaction
    - ## Diagnostics and OpenTelemetry
    - ## Troubleshooting tips
    - ## Related

## network.md
- Route: /network
- Headings:
    - ## Core model
    - ## Pairing + identity
    - ## Discovery + transports
    - ## Nodes + transports
    - ## Security
    - ## Related

## nodes/audio.md
- Route: /nodes/audio
- Headings:
    - ## What works
    - ## Auto-detection (default)
    - ## Config examples
      - ### Provider + CLI fallback (OpenAI + Whisper CLI)
      - ### Provider-only with scope gating
      - ### Provider-only (Deepgram)
      - ### Provider-only (Mistral Voxtral)
      - ### Provider-only (SenseAudio)
      - ### Echo transcript to chat (opt-in)
    - ## Notes and limits
      - ### Proxy environment support
    - ## Mention detection in groups
    - ## Gotchas
    - ## Related

## nodes/camera.md
- Route: /nodes/camera
- Headings:
    - ## iOS node
      - ### User setting (default on)
      - ### Commands (via Gateway node.invoke)
      - ### Foreground requirement
      - ### CLI helper
    - ## Android node
      - ### Android user setting (default on)
      - ### Permissions
      - ### Android foreground requirement
      - ### Android commands (via Gateway node.invoke)
      - ### Payload guard
    - ## macOS app
      - ### User setting (default off)
      - ### CLI helper (node invoke)
    - ## Safety + practical limits
    - ## macOS screen video (OS-level)
    - ## Related

## nodes/images.md
- Route: /nodes/images
- Headings:
    - ## Goals
    - ## CLI Surface
    - ## WhatsApp Web channel behavior
    - ## Auto-Reply Pipeline
    - ## Inbound Media To Commands
    - ## Limits and errors
    - ## Notes for Tests
    - ## Related

## nodes/index.md
- Route: /nodes
- Headings:
    - ## Pairing + status
    - ## Remote node host (system.run)
      - ### What runs where
      - ### Start a node host (foreground)
      - ### Remote gateway via SSH tunnel (loopback bind)
      - ### Start a node host (service)
      - ### Pair + name
      - ### Allowlist the commands
      - ### Point exec at the node
    - ## Invoking commands
    - ## Command policy
    - ## Config (openclaw.json)
    - ## Screenshots (canvas snapshots)
      - ### Canvas controls
      - ### A2UI (Canvas)
    - ## Photos + videos (node camera)
    - ## Screen recordings (nodes)
    - ## Location (nodes)
    - ## SMS (Android nodes)
    - ## Android device + personal data commands
    - ## System commands (node host / mac node)
    - ## Exec node binding
    - ## Permissions map
    - ## Headless node host (cross-platform)
    - ## Mac node mode

## nodes/location-command.md
- Route: /nodes/location-command
- Headings:
    - ## TL;DR
    - ## Why a selector (not just a switch)
    - ## Settings model
    - ## Permissions mapping (node.permissions)
    - ## Command: location.get
    - ## Background behavior
    - ## Model/tooling integration
    - ## UX copy (suggested)
    - ## Related

## nodes/media-understanding.md
- Route: /nodes/media-understanding
- Headings:
    - ## Goals
    - ## High-level behavior
    - ## Config overview
      - ### Model entries
      - ### Provider credentials (apiKey)
    - ## Defaults and limits
      - ### Auto-detect media understanding (default)
      - ### Proxy environment support (provider models)
    - ## Capabilities (optional)
    - ## Provider support matrix (OpenClaw integrations)
    - ## Model selection guidance
    - ## Attachment policy
    - ## Config examples
    - ## Status output
    - ## Notes
    - ## Related

## nodes/talk.md
- Route: /nodes/talk
- Headings:
    - ## Behavior (macOS)
    - ## Voice directives in replies
    - ## Config (/.openclaw/openclaw.json)
    - ## macOS UI
    - ## Android UI
    - ## Notes
    - ## Related

## nodes/troubleshooting.md
- Route: /nodes/troubleshooting
- Headings:
    - ## Command ladder
    - ## Foreground requirements
    - ## Permissions matrix
    - ## Pairing versus approvals
    - ## Common node error codes
    - ## Fast recovery loop
    - ## Related

## nodes/voicewake.md
- Route: /nodes/voicewake
- Headings:
    - ## Storage (Gateway host)
    - ## Protocol
      - ### Methods
      - ### Routing methods (trigger → target)
      - ### Events
    - ## Client behavior
      - ### macOS app
      - ### iOS node
      - ### Android node
    - ## Related

## openclaw-agent-runtime.md
- Route: /openclaw-agent-runtime
- Headings:
    - ## Type checking and linting
    - ## Running Agent Runtime Tests
    - ## Manual testing
    - ## Clean slate reset
    - ## References
    - ## Related

## perplexity.md
- Route: /perplexity
- Headings:
    - ## Related

## plan/codex-context-engine-harness.md
- Route: /plan/codex-context-engine-harness
- Headings:
    - ## Status
    - ## Goal
    - ## Non-goals
    - ## Current architecture
    - ## Current gap
    - ## Desired behavior
    - ## Design constraints
      - ### Codex app-server remains canonical for native thread state
      - ### Context engine assembly must be projected into Codex inputs
      - ### Prompt-cache stability matters
      - ### Runtime selection semantics do not change
    - ## Implementation plan
      - ### 1. Export or relocate reusable context-engine attempt helpers
      - ### 2. Add a Codex context projection helper
      - ### 3. Wire bootstrap before Codex thread startup
      - ### 4. Wire assemble before thread/start / thread/resume and turn/start
      - ### 5. Preserve prompt-cache stable formatting
      - ### 6. Wire post-turn after transcript mirroring
      - ### 7. Normalize usage and prompt-cache runtime context
      - ### 8. Compaction policy
        - #### /compact and explicit OpenClaw compaction
        - #### In-turn Codex native contextCompaction events
      - ### 9. Session reset and binding behavior
      - ### 10. Error handling
    - ## Test plan
      - ### Unit tests
      - ### Existing tests to update
      - ### Integration / live tests
    - ## Observability
    - ## Migration / compatibility
    - ## Open questions
    - ## Acceptance criteria

## plan/ui-channels.md
- Route: /plan/ui-channels
- Headings:
    - ## Status
    - ## Problem
    - ## Goals
    - ## Non goals
    - ## Target model
    - ## Delivery metadata
    - ## Runtime capability contract
    - ## Channel mapping
    - ## Refactor steps
    - ## Tests
    - ## Open questions
    - ## Related

## platforms/android.md
- Route: /platforms/android
- Headings:
    - ## Support snapshot
    - ## System control
    - ## Connection runbook
      - ### Prerequisites
      - ### 1) Start the Gateway
      - ### 2) Verify discovery (optional)
        - #### Tailnet (Vienna ⇄ London) discovery via unicast DNS-SD
      - ### 3) Connect from Android
      - ### Presence alive beacons
      - ### 4) Approve pairing (CLI)
      - ### 5) Verify the node is connected
      - ### 6) Chat + history
      - ### 7) Canvas + camera
        - #### Gateway Canvas Host (recommended for web content)
      - ### 8) Voice + expanded Android command surface
    - ## Assistant entrypoints
    - ## Notification forwarding
    - ## Related

## platforms/digitalocean.md
- Route: /platforms/digitalocean
- Headings:
    - ## Related

## platforms/easyrunner.md
- Route: /platforms/easyrunner
- Headings:
    - ## Before you begin
    - ## Compose app
    - ## Configure OpenClaw
    - ## Verify
    - ## Updates and backups
    - ## Troubleshooting

## platforms/index.md
- Route: /platforms
- Headings:
    - ## Choose your OS
    - ## VPS and hosting
    - ## Common links
    - ## Gateway service install (CLI)
    - ## Related

## platforms/ios.md
- Route: /platforms/ios
- Headings:
    - ## What it does
    - ## Requirements
    - ## Quick start (pair + connect)
    - ## Relay-backed push for official builds
    - ## Background alive beacons
    - ## Authentication and trust flow
    - ## Discovery paths
      - ### Bonjour (LAN)
      - ### Tailnet (cross-network)
      - ### Manual host/port
    - ## Canvas + A2UI
    - ## Computer Use relationship
      - ### Canvas eval / snapshot
    - ## Voice wake + talk mode
    - ## Common errors
    - ## Related docs

## platforms/linux.md
- Route: /platforms/linux
- Headings:
    - ## Beginner quick path (VPS)
    - ## Install
    - ## Gateway
    - ## Gateway service install (CLI)
    - ## System control (systemd user unit)
    - ## Memory pressure and OOM kills
    - ## Related

## platforms/mac/bundled-gateway.md
- Route: /platforms/mac/bundled-gateway
- Headings:
    - ## Install the CLI (required for local mode)
    - ## Launchd (Gateway as LaunchAgent)
    - ## Version compatibility
    - ## Smoke check
    - ## Related

## platforms/mac/canvas.md
- Route: /platforms/mac/canvas
- Headings:
    - ## Where Canvas lives
    - ## Panel behavior
    - ## Agent API surface
    - ## A2UI in Canvas
      - ### A2UI commands (v0.8)
    - ## Triggering agent runs from Canvas
    - ## Security notes
    - ## Related

## platforms/mac/child-process.md
- Route: /platforms/mac/child-process
- Headings:
    - ## Default behavior (launchd)
    - ## Unsigned dev builds
    - ## Attach-only mode
    - ## Remote mode
    - ## Why we prefer launchd
    - ## Related

## platforms/mac/dev-setup.md
- Route: /platforms/mac/dev-setup
- Headings:
  - # macOS developer setup
    - ## Prerequisites
    - ## 1. Install Dependencies
    - ## 2. Build and Package the App
    - ## 3. Install the CLI
    - ## Troubleshooting
      - ### Build fails: toolchain or SDK mismatch
      - ### App crashes on permission grant
      - ### Gateway "Starting..." indefinitely
    - ## Related

## platforms/mac/health.md
- Route: /platforms/mac/health
- Headings:
  - # Health Checks on macOS
    - ## Menu bar
    - ## Settings
    - ## How the probe works
    - ## When in doubt
    - ## Related

## platforms/mac/icon.md
- Route: /platforms/mac/icon
- Headings:
  - # Menu Bar Icon States
    - ## Related

## platforms/mac/logging.md
- Route: /platforms/mac/logging
- Headings:
  - # Logging (macOS)
    - ## Rolling diagnostics file log (Debug pane)
    - ## Unified logging private data on macOS
    - ## Enable for OpenClaw (ai.openclaw)
    - ## Disable after debugging
    - ## Related

## platforms/mac/menu-bar.md
- Route: /platforms/mac/menu-bar
- Headings:
    - ## What is shown
    - ## State model
    - ## IconState enum (Swift)
      - ### ActivityKind → glyph
      - ### Visual mapping
    - ## Context submenu
    - ## Status row text (menu)
    - ## Event ingestion
    - ## Debug override
    - ## Testing checklist
    - ## Related

## platforms/mac/peekaboo.md
- Route: /platforms/mac/peekaboo
- Headings:
    - ## What this is (and is not)
    - ## Relationship to Computer Use
    - ## Enable the bridge
    - ## Client discovery order
    - ## Security and permissions
    - ## Snapshot behavior (automation)
    - ## Troubleshooting
    - ## Related

## platforms/mac/permissions.md
- Route: /platforms/mac/permissions
- Headings:
    - ## Requirements for stable permissions
    - ## Accessibility grants for Node and CLI runtimes
    - ## Recovery checklist when prompts disappear
    - ## Files and folders permissions (Desktop/Documents/Downloads)
    - ## Related

## platforms/mac/remote.md
- Route: /platforms/mac/remote
- Headings:
    - ## Modes
    - ## Remote transports
    - ## Prereqs on the remote host
    - ## macOS app setup
    - ## Web Chat
    - ## Permissions
    - ## Security notes
    - ## WhatsApp login flow (remote)
    - ## Troubleshooting
    - ## Notification sounds
    - ## Related

## platforms/mac/signing.md
- Route: /platforms/mac/signing
- Headings:
  - # mac signing (debug builds)
    - ## Usage
      - ### Ad-hoc Signing Note
    - ## Build metadata for About
    - ## Why
    - ## Related

## platforms/mac/skills.md
- Route: /platforms/mac/skills
- Headings:
    - ## Data source
    - ## Install actions
    - ## Env/API keys
    - ## Remote mode
    - ## Related

## platforms/mac/voice-overlay.md
- Route: /platforms/mac/voice-overlay
- Headings:
  - # Voice Overlay Lifecycle (macOS)
    - ## Current intent
    - ## Implemented (Dec 9, 2025)
    - ## Next steps
    - ## Debugging checklist
    - ## Migration steps (suggested)
    - ## Related

## platforms/mac/voicewake.md
- Route: /platforms/mac/voicewake
- Headings:
  - # Voice Wake & Push-to-Talk
    - ## Requirements
    - ## Modes
    - ## Runtime behavior (wake-word)
    - ## Lifecycle invariants
    - ## Sticky overlay failure mode (previous)
    - ## Push-to-talk specifics
    - ## User-facing settings
    - ## Forwarding behavior
    - ## Forwarding payload
    - ## Quick verification
    - ## Related

## platforms/mac/webchat.md
- Route: /platforms/mac/webchat
- Headings:
    - ## Launch and debugging
    - ## How it is wired
    - ## Security surface
    - ## Known limitations
    - ## Related

## platforms/mac/xpc.md
- Route: /platforms/mac/xpc
- Headings:
  - # OpenClaw macOS IPC architecture
    - ## Goals
    - ## How it works
      - ### Gateway + node transport
      - ### Node service + app IPC
      - ### PeekabooBridge (UI automation)
    - ## Operational flows
    - ## Hardening notes
    - ## Related

## platforms/macos.md
- Route: /platforms/macos
- Headings:
    - ## What it does
    - ## Local vs remote mode
    - ## Launchd control
    - ## Node capabilities (mac)
    - ## Exec approvals (system.run)
    - ## Deep links
      - ### openclaw://agent
    - ## Onboarding flow (typical)
    - ## State dir placement (macOS)
    - ## Build and dev workflow (native)
    - ## Debug gateway connectivity (macOS CLI)
    - ## Remote connection plumbing (SSH tunnels)
      - ### Control tunnel (Gateway WebSocket port)
    - ## Related docs

## platforms/oracle.md
- Route: /platforms/oracle
- Headings:
    - ## Related

## platforms/raspberry-pi.md
- Route: /platforms/raspberry-pi
- Headings:
    - ## Related

## platforms/windows.md
- Route: /platforms/windows
- Headings:
    - ## Recommended: Windows Hub
      - ### What Windows Hub includes
      - ### First launch
    - ## Windows node mode
    - ## Local MCP mode
    - ## Native Windows CLI and Gateway
    - ## WSL2 Gateway
    - ## Gateway auto-start before Windows login
    - ## Expose WSL services over LAN
    - ## Troubleshooting
      - ### The tray icon does not appear
      - ### Local setup fails
      - ### The app says pairing is required
      - ### Web chat cannot reach a remote Gateway
      - ### screen.snapshot, camera, or audio commands fail
      - ### Git or GitHub connectivity fails
    - ## Related

## plugins/adding-capabilities.md
- Route: /plugins/adding-capabilities
- Headings:
    - ## When to create a capability
    - ## The standard sequence
    - ## What goes where
    - ## Provider and harness seams
    - ## File checklist
    - ## Worked example: image generation
    - ## Embedding providers
    - ## Review checklist
    - ## Related

## plugins/admin-http-rpc.md
- Route: /plugins/admin-http-rpc
- Headings:
    - ## Before you enable it
    - ## Enable
    - ## Verify the route
    - ## Authentication
    - ## Security model
    - ## Request
    - ## Response
    - ## Allowed methods
    - ## WebSocket comparison
    - ## Troubleshooting
    - ## Related

## plugins/agent-tools.md
- Route: /plugins/agent-tools
- Headings:
    - ## Related

## plugins/architecture-internals.md
- Route: /plugins/architecture-internals
- Headings:
    - ## Load pipeline
      - ### Manifest-first behavior
      - ### Plugin cache boundary
    - ## Registry model
    - ## Conversation binding callbacks
    - ## Provider runtime hooks
      - ### Hook order and usage
      - ### Provider example
      - ### Built-in examples
    - ## Runtime helpers
      - ### api.runtime.imageGeneration
    - ## Gateway HTTP routes
    - ## Plugin SDK import paths
    - ## Message tool schemas
    - ## Channel target resolution
    - ## Config-backed directories
    - ## Provider catalogs
    - ## Read-only channel inspection
    - ## Package packs
      - ### Channel catalog metadata
    - ## Context engine plugins
    - ## Adding a new capability
      - ### Capability checklist
      - ### Capability template
    - ## Related

## plugins/architecture.md
- Route: /plugins/architecture
- Headings:
    - ## Public capability model
      - ### External compatibility stance
      - ### Plugin shapes
      - ### Legacy hooks
      - ### Compatibility signals
    - ## Architecture overview
      - ### Plugin metadata snapshot and lookup table
      - ### Activation planning
      - ### Channel plugins and the shared message tool
    - ## Capability ownership model
      - ### Capability layering
      - ### Multi-capability company plugin example
      - ### Capability example: video understanding
    - ## Contracts and enforcement
      - ### What belongs in a contract
    - ## Execution model
    - ## Export boundary
    - ## Internals and reference
    - ## Related

## plugins/building-extensions.md
- Route: /plugins/building-extensions
- Headings:
    - ## Related

## plugins/building-plugins.md
- Route: /plugins/building-plugins
- Headings:
    - ## Requirements
    - ## Choose the plugin shape
    - ## Quickstart
    - ## Registering tools
    - ## Import conventions
    - ## Pre-submission checklist
    - ## Test against beta releases
    - ## Next steps
    - ## Related

## plugins/bundles.md
- Route: /plugins/bundles
- Headings:
    - ## Why bundles exist
    - ## Install a bundle
    - ## What OpenClaw maps from bundles
      - ### Supported now
        - #### Skill content
        - #### Hook packs
        - #### MCP for embedded OpenClaw
        - #### Embedded OpenClaw settings
        - #### Embedded OpenClaw LSP
      - ### Detected but not executed
    - ## Bundle formats
    - ## Detection precedence
    - ## Runtime dependencies and cleanup
    - ## Security
    - ## Troubleshooting
    - ## Related

## plugins/cli-backend-plugins.md
- Route: /plugins/cli-backend-plugins
- Headings:
    - ## What the plugin owns
    - ## Minimal backend plugin
    - ## Config shape
    - ## Advanced backend hooks
      - ### ownsNativeCompaction: opting out of OpenClaw compaction
    - ## MCP tool bridge
    - ## User configuration
    - ## Verification
    - ## Checklist
    - ## Related

## plugins/codex-computer-use.md
- Route: /plugins/codex-computer-use
- Headings:
    - ## OpenClaw.app and Peekaboo
    - ## iOS app
    - ## Direct cua-driver MCP
    - ## Quick setup
    - ## Commands
    - ## Marketplace choices
    - ## Bundled macOS marketplace
    - ## Remote catalog limit
    - ## Configuration reference
    - ## What OpenClaw checks
    - ## macOS permissions
    - ## Troubleshooting
    - ## Related

## plugins/codex-harness-reference.md
- Route: /plugins/codex-harness-reference
- Headings:
    - ## Plugin config surface
    - ## App-server transport
    - ## Approval and sandbox modes
    - ## Sandboxed native execution
    - ## Auth and environment isolation
    - ## Dynamic tools
    - ## Timeouts
    - ## Model discovery
    - ## Workspace bootstrap files
    - ## Environment overrides
    - ## Related

## plugins/codex-harness-runtime.md
- Route: /plugins/codex-harness-runtime
- Headings:
    - ## Overview
    - ## Thread bindings and model changes
    - ## Visible replies and heartbeats
    - ## Hook boundaries
    - ## V1 support contract
    - ## Native permissions and MCP elicitations
    - ## Queue steering
    - ## Codex feedback upload
    - ## Compaction and transcript mirror
    - ## Media and delivery
    - ## Related

## plugins/codex-harness.md
- Route: /plugins/codex-harness
- Headings:
    - ## Requirements
    - ## Quickstart
    - ## Configuration
    - ## Verify Codex runtime
    - ## Routing and model selection
    - ## Deployment patterns
      - ### Basic Codex deployment
      - ### Mixed provider deployment
      - ### Fail-closed Codex deployment
    - ## App-server policy
    - ## Commands and diagnostics
      - ### Inspect Codex threads locally
    - ## Native Codex plugins
    - ## Computer Use
    - ## Runtime boundaries
    - ## Troubleshooting
    - ## Related

## plugins/codex-native-plugins.md
- Route: /plugins/codex-native-plugins
- Headings:
    - ## Requirements
    - ## Quickstart
    - ## Manage plugins from chat
    - ## How native plugin setup works
    - ## V1 support boundary
    - ## App inventory and ownership
    - ## Thread app config
    - ## Destructive action policy
    - ## Troubleshooting
    - ## Related

## plugins/community.md
- Route: /plugins/community
- Headings:
    - ## Find plugins
    - ## Publish plugins
    - ## Related

## plugins/compatibility.md
- Route: /plugins/compatibility
- Headings:
    - ## Compatibility registry
    - ## Plugin inspector package
      - ### Maintainer acceptance lane
    - ## Deprecation policy
    - ## Current compatibility areas
      - ### WhatsApp Inbound Callback Flat Aliases
      - ### WhatsApp Inbound Admission Fields
    - ## Release notes

## plugins/copilot.md
- Route: /plugins/copilot
- Headings:
    - ## Requirements
    - ## Plugin install
    - ## Quickstart
    - ## Supported providers
    - ## Auth
    - ## Configuration surface
    - ## Compaction
    - ## Transcript mirroring
    - ## Side questions (/btw)
    - ## Doctor
    - ## Limitations
    - ## Permissions and askuser
      - ### Session-level GitHub token
    - ## Related

## plugins/dependency-resolution.md
- Route: /plugins/dependency-resolution
- Headings:
    - ## Responsibility split
    - ## Install roots
    - ## Local plugins
    - ## Startup and reload
    - ## Bundled plugins
    - ## Legacy cleanup

## plugins/google-meet.md
- Route: /plugins/google-meet
- Headings:
    - ## Quick start
      - ### Local gateway + Parallels Chrome
    - ## Install notes
    - ## Transports
      - ### Chrome
      - ### Twilio
    - ## OAuth and preflight
      - ### Create Google credentials
      - ### Mint the refresh token
      - ### Verify OAuth with doctor
    - ## Config
    - ## Tool
    - ## Agent and bidi modes
    - ## Live test checklist
    - ## Troubleshooting
      - ### Agent cannot see the Google Meet tool
      - ### No connected Google Meet-capable node
      - ### Browser opens but agent cannot join
      - ### Meeting creation fails
      - ### Agent joins but does not talk
      - ### Twilio setup checks fail
      - ### Twilio call starts but never enters the meeting
    - ## Notes
    - ## Related

## plugins/hooks.md
- Route: /plugins/hooks
- Headings:
    - ## Quick start
    - ## Hook catalog
    - ## Debug runtime hooks
    - ## Tool call policy
      - ### Exec environment hook
      - ### Tool result persistence
    - ## Prompt and model hooks
      - ### Session extensions and next-turn injections
    - ## Message hooks
    - ## Install hooks
    - ## Gateway lifecycle
    - ## Upcoming deprecations
    - ## Related

## plugins/install-overrides.md
- Route: /plugins/install-overrides
- Headings:
    - ## Environment
    - ## Behavior
    - ## Package E2E

## plugins/llama-cpp.md
- Route: /plugins/llama-cpp
- Headings:
    - ## Configuration
    - ## Native Runtime

## plugins/manage-plugins.md
- Route: /plugins/manage-plugins
- Headings:
    - ## List and search plugins
    - ## Install plugins
    - ## Restart and inspect
    - ## Update plugins
    - ## Uninstall plugins
    - ## Choose a source
    - ## Publish plugins
    - ## Related

## plugins/manifest.md
- Route: /plugins/manifest
- Headings:
    - ## What this file does
    - ## Minimal example
    - ## Rich example
    - ## Top-level field reference
    - ## Generation provider metadata reference
    - ## Tool metadata reference
    - ## providerAuthChoices reference
    - ## commandAliases reference
    - ## activation reference
    - ## qaRunners reference
    - ## setup reference
      - ### setup.providers reference
      - ### setup fields
    - ## uiHints reference
    - ## contracts reference
    - ## mediaUnderstandingProviderMetadata reference
    - ## channelConfigs reference
      - ### Replacing another channel plugin
    - ## modelSupport reference
    - ## modelCatalog reference
    - ## modelIdNormalization reference
    - ## providerEndpoints reference
    - ## providerRequest reference
    - ## secretProviderIntegrations reference
    - ## modelPricing reference
      - ### OpenClaw Provider Index
    - ## Manifest versus package.json
      - ### package.json fields that affect discovery
    - ## Discovery precedence (duplicate plugin ids)
    - ## JSON Schema requirements
    - ## Validation behavior
    - ## Notes
    - ## Related

## plugins/memory-lancedb.md
- Route: /plugins/memory-lancedb
- Headings:
    - ## Installation
    - ## Quick start
    - ## Provider-backed embeddings
    - ## Ollama embeddings
    - ## OpenAI-compatible providers
    - ## Recall and capture limits
    - ## Commands
    - ## Storage
    - ## Runtime dependencies
    - ## Troubleshooting
      - ### Input length exceeds the context length
      - ### Unsupported embedding model
      - ### Plugin loads but no memories appear
    - ## Related

## plugins/memory-wiki.md
- Route: /plugins/memory-wiki
- Headings:
    - ## What it adds
    - ## How it fits with memory
    - ## Recommended hybrid pattern
    - ## Vault modes
      - ### isolated
      - ### bridge
      - ### unsafe-local
    - ## Vault layout
    - ## Open Knowledge Format imports
    - ## Structured claims and evidence
    - ## Agent-facing entity metadata
    - ## Compile pipeline
    - ## Dashboards and health reports
    - ## Search and retrieval
    - ## Agent tools
    - ## Prompt and context behavior
    - ## Configuration
      - ### Example: QMD + bridge mode
    - ## CLI
    - ## Obsidian support
    - ## Recommended workflow
    - ## Related docs

## plugins/message-presentation.md
- Route: /plugins/message-presentation
- Headings:
    - ## Contract
    - ## Producer examples
    - ## Renderer contract
    - ## Core render flow
    - ## Degradation rules
    - ## Provider mapping
    - ## Presentation vs InteractiveReply
    - ## Delivery pin
    - ## Plugin author checklist
    - ## Related docs

## plugins/oc-path.md
- Route: /plugins/oc-path
- Headings:
    - ## Why enable it
    - ## Where it runs
    - ## Enable
    - ## Dependencies
    - ## What it provides
    - ## Relationship to other plugins
    - ## Safety
    - ## Related

## plugins/plugin-inventory.md
- Route: /plugins/plugin-inventory
- Headings:
  - # Plugin inventory
    - ## Definitions
    - ## Install a plugin
    - ## Core npm package
    - ## Official external packages
    - ## Source checkout only

## plugins/plugin-permission-requests.md
- Route: /plugins/plugin-permission-requests
- Headings:
    - ## Choose the right gate
    - ## Request approval before a tool call
    - ## Decision behavior
    - ## Route approval prompts
    - ## Codex native permissions
    - ## Troubleshooting
    - ## Related

## plugins/reference.md
- Route: /plugins/reference
- Headings:
  - # Plugin reference

## plugins/reference/acpx.md
- Route: /plugins/reference/acpx
- Headings:
  - # ACPx plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/admin-http-rpc.md
- Route: /plugins/reference/admin-http-rpc
- Headings:
  - # Admin Http Rpc plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/alibaba.md
- Route: /plugins/reference/alibaba
- Headings:
  - # Alibaba plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/amazon-bedrock-mantle.md
- Route: /plugins/reference/amazon-bedrock-mantle
- Headings:
  - # Amazon Bedrock Mantle plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/amazon-bedrock.md
- Route: /plugins/reference/amazon-bedrock
- Headings:
  - # Amazon Bedrock plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/anthropic-vertex.md
- Route: /plugins/reference/anthropic-vertex
- Headings:
  - # Anthropic Vertex plugin
    - ## Distribution
    - ## Surface
    - ## Claude Fable 5

## plugins/reference/anthropic.md
- Route: /plugins/reference/anthropic
- Headings:
  - # Anthropic plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/arcee.md
- Route: /plugins/reference/arcee
- Headings:
  - # Arcee plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/azure-speech.md
- Route: /plugins/reference/azure-speech
- Headings:
  - # Azure Speech plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/bonjour.md
- Route: /plugins/reference/bonjour
- Headings:
  - # Bonjour plugin
    - ## Distribution
    - ## Surface

## plugins/reference/brave.md
- Route: /plugins/reference/brave
- Headings:
  - # Brave plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/browser.md
- Route: /plugins/reference/browser
- Headings:
  - # Browser plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/byteplus.md
- Route: /plugins/reference/byteplus
- Headings:
  - # BytePlus plugin
    - ## Distribution
    - ## Surface

## plugins/reference/canvas.md
- Route: /plugins/reference/canvas
- Headings:
  - # Canvas plugin
    - ## Distribution
    - ## Surface

## plugins/reference/cerebras.md
- Route: /plugins/reference/cerebras
- Headings:
  - # Cerebras plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/chutes.md
- Route: /plugins/reference/chutes
- Headings:
  - # Chutes plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/clickclack.md
- Route: /plugins/reference/clickclack
- Headings:
  - # Clickclack plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/cloudflare-ai-gateway.md
- Route: /plugins/reference/cloudflare-ai-gateway
- Headings:
  - # Cloudflare AI Gateway plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/codex-supervisor.md
- Route: /plugins/reference/codex-supervisor
- Headings:
  - # Codex Supervisor plugin
    - ## Distribution
    - ## Surface
    - ## Session Listing

## plugins/reference/codex.md
- Route: /plugins/reference/codex
- Headings:
  - # Codex plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/cohere.md
- Route: /plugins/reference/cohere
- Headings:
  - # Cohere plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/comfy.md
- Route: /plugins/reference/comfy
- Headings:
  - # ComfyUI plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/copilot-proxy.md
- Route: /plugins/reference/copilot-proxy
- Headings:
  - # Copilot Proxy plugin
    - ## Distribution
    - ## Surface

## plugins/reference/copilot.md
- Route: /plugins/reference/copilot
- Headings:
  - # Copilot plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/deepgram.md
- Route: /plugins/reference/deepgram
- Headings:
  - # Deepgram plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/deepinfra.md
- Route: /plugins/reference/deepinfra
- Headings:
  - # DeepInfra plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/deepseek.md
- Route: /plugins/reference/deepseek
- Headings:
  - # DeepSeek plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/diagnostics-otel.md
- Route: /plugins/reference/diagnostics-otel
- Headings:
  - # Diagnostics OpenTelemetry plugin
    - ## Distribution
    - ## Surface

## plugins/reference/diagnostics-prometheus.md
- Route: /plugins/reference/diagnostics-prometheus
- Headings:
  - # Diagnostics Prometheus plugin
    - ## Distribution
    - ## Surface

## plugins/reference/diffs-language-pack.md
- Route: /plugins/reference/diffs-language-pack
- Headings:
  - # Diffs Language Pack plugin
    - ## Distribution
    - ## Surface
    - ## Added languages

## plugins/reference/diffs.md
- Route: /plugins/reference/diffs
- Headings:
  - # Diffs plugin
    - ## Distribution
    - ## Surface

## plugins/reference/discord.md
- Route: /plugins/reference/discord
- Headings:
  - # Discord plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/document-extract.md
- Route: /plugins/reference/document-extract
- Headings:
  - # Document Extract plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/duckduckgo.md
- Route: /plugins/reference/duckduckgo
- Headings:
  - # DuckDuckGo plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/elevenlabs.md
- Route: /plugins/reference/elevenlabs
- Headings:
  - # Elevenlabs plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/exa.md
- Route: /plugins/reference/exa
- Headings:
  - # Exa plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/fal.md
- Route: /plugins/reference/fal
- Headings:
  - # fal plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/feishu.md
- Route: /plugins/reference/feishu
- Headings:
  - # Feishu plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/file-transfer.md
- Route: /plugins/reference/file-transfer
- Headings:
  - # File Transfer plugin
    - ## Distribution
    - ## Surface

## plugins/reference/firecrawl.md
- Route: /plugins/reference/firecrawl
- Headings:
  - # Firecrawl plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/fireworks.md
- Route: /plugins/reference/fireworks
- Headings:
  - # Fireworks plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/github-copilot.md
- Route: /plugins/reference/github-copilot
- Headings:
  - # GitHub Copilot plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/gmi.md
- Route: /plugins/reference/gmi
- Headings:
  - # Gmi plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/google-meet.md
- Route: /plugins/reference/google-meet
- Headings:
  - # Google Meet plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/google.md
- Route: /plugins/reference/google
- Headings:
  - # Google plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/googlechat.md
- Route: /plugins/reference/googlechat
- Headings:
  - # Google Chat plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/gradium.md
- Route: /plugins/reference/gradium
- Headings:
  - # Gradium plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/groq.md
- Route: /plugins/reference/groq
- Headings:
  - # Groq plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/huggingface.md
- Route: /plugins/reference/huggingface
- Headings:
  - # Hugging Face plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/imessage.md
- Route: /plugins/reference/imessage
- Headings:
  - # iMessage plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/inworld.md
- Route: /plugins/reference/inworld
- Headings:
  - # Inworld plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/irc.md
- Route: /plugins/reference/irc
- Headings:
  - # IRC plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/kilocode.md
- Route: /plugins/reference/kilocode
- Headings:
  - # Kilocode plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/kimi.md
- Route: /plugins/reference/kimi
- Headings:
  - # Kimi plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/line.md
- Route: /plugins/reference/line
- Headings:
  - # LINE plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/litellm.md
- Route: /plugins/reference/litellm
- Headings:
  - # LiteLLM plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/llama-cpp.md
- Route: /plugins/reference/llama-cpp
- Headings:
  - # Llama Cpp plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/llm-task.md
- Route: /plugins/reference/llm-task
- Headings:
  - # LLM Task plugin
    - ## Distribution
    - ## Surface

## plugins/reference/lmstudio.md
- Route: /plugins/reference/lmstudio
- Headings:
  - # LM Studio plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/lobster.md
- Route: /plugins/reference/lobster
- Headings:
  - # Lobster plugin
    - ## Distribution
    - ## Surface

## plugins/reference/matrix.md
- Route: /plugins/reference/matrix
- Headings:
  - # Matrix plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/mattermost.md
- Route: /plugins/reference/mattermost
- Headings:
  - # Mattermost plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/memory-core.md
- Route: /plugins/reference/memory-core
- Headings:
  - # Memory Core plugin
    - ## Distribution
    - ## Surface

## plugins/reference/memory-lancedb.md
- Route: /plugins/reference/memory-lancedb
- Headings:
  - # Memory Lancedb plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/memory-wiki.md
- Route: /plugins/reference/memory-wiki
- Headings:
  - # Memory Wiki plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/microsoft-foundry.md
- Route: /plugins/reference/microsoft-foundry
- Headings:
  - # Microsoft Foundry plugin
    - ## Distribution
    - ## Surface
    - ## Requirements
    - ## Chat models
    - ## MAI image generation
    - ## Troubleshooting

## plugins/reference/microsoft.md
- Route: /plugins/reference/microsoft
- Headings:
  - # Microsoft plugin
    - ## Distribution
    - ## Surface

## plugins/reference/migrate-claude.md
- Route: /plugins/reference/migrate-claude
- Headings:
  - # Migrate Claude plugin
    - ## Distribution
    - ## Surface

## plugins/reference/migrate-hermes.md
- Route: /plugins/reference/migrate-hermes
- Headings:
  - # Migrate Hermes plugin
    - ## Distribution
    - ## Surface

## plugins/reference/minimax.md
- Route: /plugins/reference/minimax
- Headings:
  - # MiniMax plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/mistral.md
- Route: /plugins/reference/mistral
- Headings:
  - # Mistral plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/moonshot.md
- Route: /plugins/reference/moonshot
- Headings:
  - # Moonshot plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/msteams.md
- Route: /plugins/reference/msteams
- Headings:
  - # Microsoft Teams plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/nextcloud-talk.md
- Route: /plugins/reference/nextcloud-talk
- Headings:
  - # Nextcloud Talk plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/nostr.md
- Route: /plugins/reference/nostr
- Headings:
  - # Nostr plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/novita.md
- Route: /plugins/reference/novita
- Headings:
  - # Novita plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/nvidia.md
- Route: /plugins/reference/nvidia
- Headings:
  - # NVIDIA plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/oc-path.md
- Route: /plugins/reference/oc-path
- Headings:
  - # Oc Path plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/ollama.md
- Route: /plugins/reference/ollama
- Headings:
  - # Ollama plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/open-prose.md
- Route: /plugins/reference/open-prose
- Headings:
  - # Open Prose plugin
    - ## Distribution
    - ## Surface

## plugins/reference/openai.md
- Route: /plugins/reference/openai
- Headings:
  - # OpenAI plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/opencode-go.md
- Route: /plugins/reference/opencode-go
- Headings:
  - # OpenCode Go plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/opencode.md
- Route: /plugins/reference/opencode
- Headings:
  - # OpenCode plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/openrouter.md
- Route: /plugins/reference/openrouter
- Headings:
  - # OpenRouter plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/openshell.md
- Route: /plugins/reference/openshell
- Headings:
  - # Openshell plugin
    - ## Distribution
    - ## Surface

## plugins/reference/perplexity.md
- Route: /plugins/reference/perplexity
- Headings:
  - # Perplexity plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/pixverse.md
- Route: /plugins/reference/pixverse
- Headings:
  - # PixVerse plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/policy.md
- Route: /plugins/reference/policy
- Headings:
  - # Policy plugin
    - ## Distribution
    - ## Surface
    - ## Behavior
    - ## Related docs

## plugins/reference/qa-channel.md
- Route: /plugins/reference/qa-channel
- Headings:
  - # QA Channel plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/qa-lab.md
- Route: /plugins/reference/qa-lab
- Headings:
  - # QA Lab plugin
    - ## Distribution
    - ## Surface

## plugins/reference/qa-matrix.md
- Route: /plugins/reference/qa-matrix
- Headings:
  - # QA Matrix plugin
    - ## Distribution
    - ## Surface

## plugins/reference/qianfan.md
- Route: /plugins/reference/qianfan
- Headings:
  - # Qianfan plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/qqbot.md
- Route: /plugins/reference/qqbot
- Headings:
  - # QQ Bot plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/qwen.md
- Route: /plugins/reference/qwen
- Headings:
  - # Qwen plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/raft.md
- Route: /plugins/reference/raft
- Headings:
  - # Raft plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/runway.md
- Route: /plugins/reference/runway
- Headings:
  - # Runway plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/searxng.md
- Route: /plugins/reference/searxng
- Headings:
  - # SearXNG plugin
    - ## Distribution
    - ## Surface

## plugins/reference/senseaudio.md
- Route: /plugins/reference/senseaudio
- Headings:
  - # Senseaudio plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/sglang.md
- Route: /plugins/reference/sglang
- Headings:
  - # SGLang plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/signal.md
- Route: /plugins/reference/signal
- Headings:
  - # Signal plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/slack.md
- Route: /plugins/reference/slack
- Headings:
  - # Slack plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/sms.md
- Route: /plugins/reference/sms
- Headings:
  - # Sms plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/stepfun.md
- Route: /plugins/reference/stepfun
- Headings:
  - # StepFun plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/synology-chat.md
- Route: /plugins/reference/synology-chat
- Headings:
  - # Synology Chat plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/synthetic.md
- Route: /plugins/reference/synthetic
- Headings:
  - # Synthetic plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/tavily.md
- Route: /plugins/reference/tavily
- Headings:
  - # Tavily plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/telegram.md
- Route: /plugins/reference/telegram
- Headings:
  - # Telegram plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/tencent.md
- Route: /plugins/reference/tencent
- Headings:
  - # Tencent plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/tlon.md
- Route: /plugins/reference/tlon
- Headings:
  - # Tlon plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/together.md
- Route: /plugins/reference/together
- Headings:
  - # Together plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/tokenjuice.md
- Route: /plugins/reference/tokenjuice
- Headings:
  - # Tokenjuice plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/tts-local-cli.md
- Route: /plugins/reference/tts-local-cli
- Headings:
  - # TTS Local CLI plugin
    - ## Distribution
    - ## Surface

## plugins/reference/twitch.md
- Route: /plugins/reference/twitch
- Headings:
  - # Twitch plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/venice.md
- Route: /plugins/reference/venice
- Headings:
  - # Venice plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/vercel-ai-gateway.md
- Route: /plugins/reference/vercel-ai-gateway
- Headings:
  - # Vercel AI Gateway plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/vllm.md
- Route: /plugins/reference/vllm
- Headings:
  - # vLLM plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/voice-call.md
- Route: /plugins/reference/voice-call
- Headings:
  - # Voice Call plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/volcengine.md
- Route: /plugins/reference/volcengine
- Headings:
  - # Volcengine plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/voyage.md
- Route: /plugins/reference/voyage
- Headings:
  - # Voyage plugin
    - ## Distribution
    - ## Surface

## plugins/reference/vydra.md
- Route: /plugins/reference/vydra
- Headings:
  - # Vydra plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/web-readability.md
- Route: /plugins/reference/web-readability
- Headings:
  - # Web Readability plugin
    - ## Distribution
    - ## Surface

## plugins/reference/webhooks.md
- Route: /plugins/reference/webhooks
- Headings:
  - # Webhooks plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/whatsapp.md
- Route: /plugins/reference/whatsapp
- Headings:
  - # WhatsApp plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/workboard.md
- Route: /plugins/reference/workboard
- Headings:
  - # Workboard plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/xai.md
- Route: /plugins/reference/xai
- Headings:
  - # xAI plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/xiaomi.md
- Route: /plugins/reference/xiaomi
- Headings:
  - # Xiaomi plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/zai.md
- Route: /plugins/reference/zai
- Headings:
  - # Z.AI plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/zalo.md
- Route: /plugins/reference/zalo
- Headings:
  - # Zalo plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/reference/zalouser.md
- Route: /plugins/reference/zalouser
- Headings:
  - # Zalo Personal plugin
    - ## Distribution
    - ## Surface
    - ## Related docs

## plugins/sdk-agent-harness.md
- Route: /plugins/sdk-agent-harness
- Headings:
    - ## When to use a harness
    - ## What core still owns
    - ## Register a harness
    - ## Selection policy
    - ## Provider plus harness pairing
      - ### Tool-result middleware
      - ### Terminal outcome classification
      - ### Agent-end side effects
      - ### Native Codex harness mode
    - ## Runtime strictness
    - ## Native sessions and transcript mirror
    - ## Tool and media results
    - ## Current limitations
    - ## Related

## plugins/sdk-channel-inbound.md
- Route: /plugins/sdk-channel-inbound
- Headings:
    - ## Core Helpers
    - ## Migration

## plugins/sdk-channel-ingress.md
- Route: /plugins/sdk-channel-ingress
- Headings:
  - # Channel ingress API
    - ## Runtime Resolver
    - ## Result
    - ## Access Groups
    - ## Event Modes
    - ## Routes And Activation
    - ## Redaction
    - ## Verification

## plugins/sdk-channel-message.md
- Route: /plugins/sdk-channel-message
- Headings: none

## plugins/sdk-channel-outbound.md
- Route: /plugins/sdk-channel-outbound
- Headings:
    - ## Adapter
    - ## Existing Outbound Adapters
    - ## Durable Sends
    - ## Compatibility Dispatch

## plugins/sdk-channel-plugins.md
- Route: /plugins/sdk-channel-plugins
- Headings:
    - ## How channel plugins work
    - ## Approvals and channel capabilities
    - ## Inbound mention policy
    - ## Walkthrough
    - ## File structure
    - ## Advanced topics
    - ## Next steps
    - ## Related

## plugins/sdk-channel-turn.md
- Route: /plugins/sdk-channel-turn
- Headings: none

## plugins/sdk-entrypoints.md
- Route: /plugins/sdk-entrypoints
- Headings:
    - ## defineToolPlugin
    - ## definePluginEntry
    - ## defineChannelPluginEntry
    - ## defineSetupPluginEntry
    - ## Registration mode
    - ## Plugin shapes
    - ## Related

## plugins/sdk-migration.md
- Route: /plugins/sdk-migration
- Headings:
    - ## What is changing
    - ## Why this changed
    - ## Talk and realtime voice migration plan
    - ## Compatibility policy
    - ## How to migrate
    - ## Import path reference
    - ## Active deprecations
    - ## Removal timeline
    - ## Suppressing the warnings temporarily
    - ## Related

## plugins/sdk-overview.md
- Route: /plugins/sdk-overview
- Headings:
    - ## Import convention
    - ## Subpath reference
    - ## Registration API
      - ### Capability registration
      - ### Tools and commands
      - ### Infrastructure
      - ### Host hooks for workflow plugins
      - ### Gateway discovery registration
      - ### CLI registration metadata
      - ### CLI backend registration
      - ### Exclusive slots
      - ### Deprecated memory embedding adapters
      - ### Events and lifecycle
      - ### Hook decision semantics
      - ### API object fields
    - ## Internal module convention
    - ## Related

## plugins/sdk-provider-plugins.md
- Route: /plugins/sdk-provider-plugins
- Headings:
    - ## Walkthrough
    - ## Publish to ClawHub
    - ## File structure
    - ## Catalog order reference
    - ## Next steps
    - ## Related

## plugins/sdk-runtime.md
- Route: /plugins/sdk-runtime
- Headings:
    - ## Config loading and writes
    - ## Reusable runtime utilities
    - ## Runtime namespaces
    - ## Storing runtime references
    - ## Other top-level api fields
    - ## Related

## plugins/sdk-setup.md
- Route: /plugins/sdk-setup
- Headings:
    - ## Package metadata
      - ### openclaw fields
      - ### openclaw.channel
      - ### openclaw.install
      - ### Deferred full load
    - ## Plugin manifest
    - ## ClawHub publishing
    - ## Setup entry
      - ### Narrow setup helper imports
      - ### Channel-owned single-account promotion
    - ## Config schema
      - ### Building channel config schemas
    - ## Setup wizards
    - ## Publishing and installing
    - ## Related

## plugins/sdk-subpaths.md
- Route: /plugins/sdk-subpaths
- Headings:
    - ## Plugin entry
      - ### Deprecated compatibility and test helpers
      - ### Reserved bundled plugin helper subpaths
    - ## Related

## plugins/sdk-testing.md
- Route: /plugins/sdk-testing
- Headings:
    - ## Test utilities
      - ### Available exports
      - ### Types
    - ## Testing target resolution
    - ## Testing patterns
      - ### Testing registration contracts
      - ### Testing runtime config access
      - ### Unit testing a channel plugin
      - ### Unit testing a provider plugin
      - ### Mocking the plugin runtime
      - ### Testing with per-instance stubs
    - ## Contract tests (in-repo plugins)
      - ### Running scoped tests
    - ## Lint enforcement (in-repo plugins)
    - ## Test configuration
    - ## Related

## plugins/tool-plugins.md
- Route: /plugins/tool-plugins
- Headings:
    - ## Requirements
    - ## Quickstart
    - ## Write a tool
    - ## Optional and factory tools
    - ## Return values
    - ## Configuration
    - ## Generated metadata
    - ## Package metadata
    - ## Validate in CI
    - ## Install and inspect locally
    - ## Publish
    - ## Troubleshooting
      - ### plugin entry not found: ./dist/index.js
      - ### plugin entry does not expose defineToolPlugin metadata
      - ### openclaw.plugin.json generated metadata is stale
      - ### package.json openclaw.extensions must include ./dist/index.js
      - ### Cannot find package 'typebox'
      - ### Tool does not appear after install
    - ## See also

## plugins/voice-call.md
- Route: /plugins/voice-call
- Headings:
    - ## Quick start
    - ## Configuration
    - ## Session scope
    - ## Realtime voice conversations
      - ### Tool policy
      - ### Agent voice context
      - ### Realtime provider examples
    - ## Streaming transcription
      - ### Streaming provider examples
    - ## TTS for calls
      - ### TTS examples
    - ## Inbound calls
      - ### Per-number Routing
      - ### Spoken output contract
      - ### Conversation startup behavior
      - ### Twilio stream disconnect grace
    - ## Stale call reaper
    - ## Webhook security
    - ## CLI
    - ## Agent tool
    - ## Gateway RPC
    - ## Troubleshooting
      - ### Setup fails webhook exposure
      - ### Provider credentials fail
      - ### Calls start but provider webhooks do not arrive
      - ### Signature verification fails
      - ### Google Meet Twilio joins fail
      - ### Realtime call has no speech
    - ## Related

## plugins/webhooks.md
- Route: /plugins/webhooks
- Headings:
    - ## Where it runs
    - ## Configure routes
    - ## Security model
    - ## Request format
    - ## Supported actions
      - ### createflow
      - ### runtask
    - ## Response shape
    - ## Related docs

## plugins/workboard.md
- Route: /plugins/workboard
- Headings:
    - ## Default state
    - ## What cards contain
    - ## Card executions and tasks
    - ## Agent coordination
      - ### Dispatch worker selection
      - ### Worker prompt and lifecycle
      - ### Dispatch entry points
    - ## CLI and slash command
    - ## Session lifecycle sync
    - ## Dashboard workflow
    - ## Permissions
    - ## Configuration
    - ## Troubleshooting
      - ### The tab says Workboard is unavailable
      - ### Cards do not save
      - ### Starting a card does not open the expected session
      - ### Dispatch does not start a worker
    - ## Related

## plugins/zalouser.md
- Route: /plugins/zalouser
- Headings:
    - ## Naming
    - ## Where it runs
    - ## Install
      - ### Option A: install from npm
      - ### Option B: install from a local folder (dev)
    - ## Config
    - ## CLI
    - ## Agent tool
    - ## Related

## prose.md
- Route: /prose
- Headings:
    - ## Install
    - ## Slash command
    - ## What it can do
    - ## Example: parallel research and synthesis
    - ## OpenClaw runtime mapping
    - ## File locations
    - ## State backends
    - ## Security
    - ## Related

## providers/alibaba.md
- Route: /providers/alibaba
- Headings:
    - ## Getting started
    - ## Built-in Wan models
    - ## Capabilities and limits
    - ## Advanced configuration
    - ## Related

## providers/anthropic.md
- Route: /providers/anthropic
- Headings:
    - ## Getting started
    - ## Thinking defaults (Claude Fable 5, 4.8, and 4.6)
    - ## Prompt caching
    - ## Advanced configuration
    - ## Troubleshooting
    - ## Related

## providers/arcee.md
- Route: /providers/arcee
- Headings:
    - ## Install plugin
    - ## Getting started
    - ## Non-interactive setup
    - ## Built-in catalog
    - ## Supported features
    - ## Related

## providers/azure-speech.md
- Route: /providers/azure-speech
- Headings:
    - ## Getting started
    - ## Configuration options
    - ## Notes
    - ## Related

## providers/bedrock-mantle.md
- Route: /providers/bedrock-mantle
- Headings:
    - ## Getting started
    - ## Automatic model discovery
      - ### Supported regions
    - ## Manual configuration
    - ## Advanced configuration
    - ## Related

## providers/bedrock.md
- Route: /providers/bedrock
- Headings:
    - ## Getting started
    - ## Automatic model discovery
    - ## Quick setup (AWS path)
    - ## Advanced configuration
    - ## Related

## providers/cerebras.md
- Route: /providers/cerebras
- Headings:
    - ## Install plugin
    - ## Getting started
    - ## Non-interactive setup
    - ## Built-in catalog
    - ## Manual config
    - ## Related

## providers/chutes.md
- Route: /providers/chutes
- Headings:
    - ## Install plugin
    - ## Getting started
    - ## Discovery behavior
    - ## Default aliases
    - ## Built-in starter catalog
    - ## Config example
    - ## Related

## providers/claude-max-api-proxy.md
- Route: /providers/claude-max-api-proxy
- Headings:
    - ## Why use this?
    - ## How it works
    - ## Getting started
    - ## Built-in catalog
    - ## Advanced configuration
    - ## Notes
    - ## Related

## providers/cloudflare-ai-gateway.md
- Route: /providers/cloudflare-ai-gateway
- Headings:
    - ## Install plugin
    - ## Getting started
    - ## Non-interactive example
    - ## Advanced configuration
    - ## Related

## providers/cohere.md
- Route: /providers/cohere
- Headings:
    - ## Get started
    - ## Environment-only setup
    - ## Related

## providers/comfy.md
- Route: /providers/comfy
- Headings:
    - ## What it supports
    - ## Getting started
    - ## Configuration
      - ### Shared keys
      - ### Per-capability keys
    - ## Workflow details
    - ## Related

## providers/deepgram.md
- Route: /providers/deepgram
- Headings:
    - ## Getting started
    - ## Configuration options
    - ## Voice Call streaming STT
    - ## Notes
    - ## Related

## providers/deepinfra.md
- Route: /providers/deepinfra
- Headings:
    - ## Install plugin
    - ## Getting an API key
    - ## CLI setup
    - ## Config snippet
    - ## Supported OpenClaw surfaces
    - ## Available models
    - ## Notes
    - ## Related

## providers/deepseek.md
- Route: /providers/deepseek
- Headings:
    - ## Install plugin
    - ## Getting started
    - ## Built-in catalog
    - ## Thinking and tools
    - ## Live testing
    - ## Config example
    - ## Related

## providers/ds4.md
- Route: /providers/ds4
- Headings:
    - ## Requirements
    - ## Quickstart
    - ## Full config
    - ## On-demand startup
    - ## Think Max
    - ## Test
    - ## Troubleshooting
    - ## Related

## providers/elevenlabs.md
- Route: /providers/elevenlabs
- Headings:
    - ## Authentication
    - ## Text-to-speech
    - ## Speech-to-text
    - ## Streaming STT
    - ## Related

## providers/fal.md
- Route: /providers/fal
- Headings:
    - ## Getting started
    - ## Image generation
    - ## Video generation
    - ## Music generation
    - ## Related

## providers/fireworks.md
- Route: /providers/fireworks
- Headings:
    - ## Getting started
    - ## Non-interactive setup
    - ## Built-in catalog
    - ## Custom Fireworks model ids
    - ## Related

## providers/github-copilot.md
- Route: /providers/github-copilot
- Headings:
    - ## Three ways to use Copilot in OpenClaw
    - ## Optional flags
    - ## Non-interactive onboarding
    - ## Memory search embeddings
      - ### Config
      - ### How it works
    - ## Related

## providers/gmi.md
- Route: /providers/gmi
- Headings:
    - ## Setup
    - ## Defaults
    - ## When to choose GMI
    - ## Models
    - ## Troubleshooting
    - ## Related

## providers/google.md
- Route: /providers/google
- Headings:
    - ## Getting started
    - ## Capabilities
    - ## Web search
    - ## Image generation
    - ## Video generation
    - ## Music generation
    - ## Text-to-speech
    - ## Realtime voice
    - ## Advanced configuration
    - ## Related

## providers/gradium.md
- Route: /providers/gradium
- Headings:
    - ## Install plugin
    - ## Setup
    - ## Config
    - ## Voices
      - ### Per-message voice override
    - ## Output
    - ## Auto-select order
    - ## Related

## providers/groq.md
- Route: /providers/groq
- Headings:
    - ## Install plugin
    - ## Getting started
      - ### Config file example
    - ## Built-in catalog
    - ## Reasoning models
    - ## Audio transcription
    - ## Related

## providers/huggingface.md
- Route: /providers/huggingface
- Headings:
    - ## Getting started
      - ### Non-interactive setup
    - ## Model IDs
    - ## Advanced configuration
    - ## Related

## providers/index.md
- Route: /providers
- Headings:
    - ## Quick start
    - ## Provider docs
    - ## Shared overview pages
    - ## Transcription providers
    - ## Community tools

## providers/inferrs.md
- Route: /providers/inferrs
- Headings:
    - ## Getting started
    - ## Full config example
    - ## On-demand startup
    - ## Advanced configuration
    - ## Troubleshooting
    - ## Related

## providers/inworld.md
- Route: /providers/inworld
- Headings:
    - ## Install plugin
    - ## Getting started
    - ## Configuration options
    - ## Notes
    - ## Related

## providers/kilocode.md
- Route: /providers/kilocode
- Headings:
    - ## Install plugin
    - ## Getting started
    - ## Default model
    - ## Built-in catalog
    - ## Config example
    - ## Related

## providers/litellm.md
- Route: /providers/litellm
- Headings:
    - ## Quick start
    - ## Configuration
      - ### Environment variables
      - ### Config file
    - ## Advanced configuration
      - ### Image generation
    - ## Related

## providers/lmstudio.md
- Route: /providers/lmstudio
- Headings:
    - ## Quick start
    - ## Non-interactive onboarding
    - ## Configuration
      - ### Streaming usage compatibility
      - ### Thinking compatibility
      - ### Explicit configuration
    - ## Troubleshooting
      - ### LM Studio not detected
      - ### Authentication errors (HTTP 401)
      - ### Just-in-time model loading
      - ### LAN or tailnet LM Studio host
    - ## Related

## providers/minimax.md
- Route: /providers/minimax
- Headings:
    - ## Built-in catalog
    - ## Getting started
    - ## Configure via openclaw configure
    - ## Capabilities
      - ### Image generation
      - ### Text-to-speech
      - ### Music generation
      - ### Video generation
      - ### Image understanding
      - ### Web search
    - ## Advanced configuration
    - ## Notes
    - ## Troubleshooting
    - ## Related

## providers/mistral.md
- Route: /providers/mistral
- Headings:
    - ## Getting started
    - ## Built-in LLM catalog
    - ## Audio transcription (Voxtral)
    - ## Voice Call streaming STT
    - ## Advanced configuration
    - ## Related

## providers/models.md
- Route: /providers/models
- Headings:
    - ## Quick start (two steps)
    - ## Supported providers (starter set)
    - ## Additional provider variants
    - ## Related

## providers/moonshot.md
- Route: /providers/moonshot
- Headings:
    - ## Built-in model catalog
    - ## Getting started
    - ## Kimi web search
    - ## Advanced configuration
    - ## Related

## providers/novita.md
- Route: /providers/novita
- Headings:
    - ## Setup
    - ## Defaults
    - ## When to choose Novita
    - ## Models
    - ## Troubleshooting
    - ## Related

## providers/nvidia.md
- Route: /providers/nvidia
- Headings:
    - ## Getting started
    - ## Config example
    - ## Featured catalog
    - ## Nemotron 3 Ultra
    - ## Bundled fallback catalog
    - ## Advanced configuration
    - ## Related

## providers/ollama-cloud.md
- Route: /providers/ollama-cloud
- Headings:
    - ## Setup
    - ## Defaults
    - ## When to choose Ollama Cloud
    - ## Models
    - ## Live test
    - ## Troubleshooting
    - ## Related

## providers/ollama.md
- Route: /providers/ollama
- Headings:
    - ## Auth rules
    - ## Getting started
    - ## Cloud models
    - ## Model discovery (implicit provider)
    - ## Vision and image description
    - ## Configuration
    - ## Common recipes
      - ### Model selection
      - ### Quick verification
    - ## Ollama Web Search
    - ## Advanced configuration
    - ## Troubleshooting
    - ## Related

## providers/openai.md
- Route: /providers/openai
- Headings:
    - ## Quick choice
    - ## Naming map
    - ## OpenClaw feature coverage
    - ## Memory embeddings
    - ## Getting started
    - ## Native Codex app-server auth
    - ## Image generation
    - ## Video generation
    - ## GPT-5 prompt contribution
    - ## Voice and speech
    - ## Azure OpenAI endpoints
      - ### Configuration
      - ### API version
      - ### Model names are deployment names
      - ### Regional availability
      - ### Parameter differences
    - ## Advanced configuration
    - ## Related

## providers/opencode-go.md
- Route: /providers/opencode-go
- Headings:
    - ## Built-in catalog
    - ## Getting started
    - ## Config example
    - ## Advanced configuration
    - ## Related

## providers/opencode.md
- Route: /providers/opencode
- Headings:
    - ## Getting started
    - ## Config example
    - ## Built-in catalogs
      - ### Zen
      - ### Go
    - ## Advanced configuration
    - ## Related

## providers/openrouter.md
- Route: /providers/openrouter
- Headings:
    - ## Getting started
    - ## Config example
    - ## Model references
    - ## Image generation
    - ## Video generation
    - ## Music generation
    - ## Text-to-speech
    - ## Speech-to-text (inbound audio)
    - ## Fusion router
    - ## Authentication and headers
    - ## Advanced configuration
    - ## Related

## providers/perplexity-provider.md
- Route: /providers/perplexity-provider
- Headings:
    - ## Install plugin
    - ## Getting started
    - ## Search modes
    - ## Native API filtering
    - ## Advanced configuration
    - ## Related

## providers/pixverse.md
- Route: /providers/pixverse
- Headings:
    - ## Getting started
    - ## Supported modes and models
    - ## Provider options
    - ## Configuration
    - ## Advanced configuration
    - ## Related

## providers/qianfan.md
- Route: /providers/qianfan
- Headings:
    - ## Install plugin
    - ## Getting started
    - ## Built-in catalog
    - ## Config example
    - ## Related

## providers/qwen-oauth.md
- Route: /providers/qwen-oauth
- Headings:
    - ## Setup
    - ## Defaults
    - ## How this differs from Qwen
    - ## When to choose Qwen OAuth / Portal
    - ## Models
    - ## Migration
    - ## Troubleshooting
    - ## Related

## providers/qwen.md
- Route: /providers/qwen
- Headings:
    - ## Install plugin
    - ## Getting started
    - ## Plan types and endpoints
    - ## Built-in catalog
    - ## Thinking Controls
    - ## Multimodal add-ons
    - ## Advanced configuration
    - ## Related

## providers/runway.md
- Route: /providers/runway
- Headings:
    - ## Getting started
    - ## Supported modes and models
    - ## Configuration
    - ## Advanced configuration
    - ## Related

## providers/senseaudio.md
- Route: /providers/senseaudio
- Headings:
    - ## Getting started
    - ## Options
    - ## Related

## providers/sglang.md
- Route: /providers/sglang
- Headings:
    - ## Getting started
    - ## Model discovery (implicit provider)
    - ## Explicit configuration (manual models)
    - ## Advanced configuration
    - ## Related

## providers/stepfun.md
- Route: /providers/stepfun
- Headings:
    - ## Install plugin
    - ## Region and endpoint overview
    - ## Built-in catalog
    - ## Getting started
    - ## Advanced configuration
    - ## Related

## providers/synthetic.md
- Route: /providers/synthetic
- Headings:
    - ## Getting started
    - ## Config example
    - ## Built-in catalog
    - ## Related

## providers/tencent.md
- Route: /providers/tencent
- Headings:
    - ## Quick start
    - ## Non-interactive setup
    - ## Built-in catalog
    - ## Tiered pricing
    - ## Advanced configuration
    - ## Related

## providers/together.md
- Route: /providers/together
- Headings:
    - ## Getting started
      - ### Non-interactive example
    - ## Built-in catalog
    - ## Video generation
    - ## Related

## providers/venice.md
- Route: /providers/venice
- Headings:
    - ## Why Venice in OpenClaw
    - ## Privacy modes
    - ## Features
    - ## Getting started
    - ## Model selection
    - ## DeepSeek V4 replay behavior
    - ## Built-in catalog (41 total)
    - ## Model discovery
    - ## Streaming and tool support
    - ## Pricing
      - ### Venice (anonymized) vs direct API
    - ## Usage examples
    - ## Troubleshooting
    - ## Advanced configuration
    - ## Related

## providers/vercel-ai-gateway.md
- Route: /providers/vercel-ai-gateway
- Headings:
    - ## Getting started
    - ## Non-interactive example
    - ## Model ID shorthand
    - ## Advanced configuration
    - ## Related

## providers/vllm.md
- Route: /providers/vllm
- Headings:
    - ## Getting started
    - ## Model discovery (implicit provider)
    - ## Explicit configuration (manual models)
    - ## Advanced configuration
    - ## Troubleshooting
    - ## Related

## providers/volcengine.md
- Route: /providers/volcengine
- Headings:
    - ## Getting started
    - ## Providers and endpoints
    - ## Built-in catalog
    - ## Text-to-speech
    - ## Advanced configuration
    - ## Related

## providers/vydra.md
- Route: /providers/vydra
- Headings:
    - ## Setup
    - ## Capabilities
    - ## Related

## providers/xai.md
- Route: /providers/xai
- Headings:
    - ## Choose your setup path
    - ## OAuth troubleshooting
    - ## Built-in catalog
    - ## OpenClaw feature coverage
      - ### Fast-mode mappings
      - ### Legacy compatibility aliases
    - ## Features
    - ## Live testing
    - ## Related

## providers/xiaomi.md
- Route: /providers/xiaomi
- Headings:
    - ## Getting started
    - ## Pay-as-you-go catalog
    - ## Token Plan catalog
    - ## Text-to-speech
    - ## Config example
    - ## Related

## providers/zai.md
- Route: /providers/zai
- Headings:
    - ## GLM models
    - ## Getting started
    - ## Config example
    - ## Built-in catalog
    - ## Advanced configuration
    - ## Related

## refactor/access.md
- Route: /refactor/access
- Headings: none

## refactor/acp.md
- Route: /refactor/acp
- Headings:
    - ## Goals
    - ## Non-goals
    - ## Target Model
      - ### Gateway Instance Identity
      - ### ACP Session Ownership
      - ### ACPX Process Leases
    - ## Lifecycle Controller
    - ## Wrapper Contract
    - ## Session Visibility Contract
    - ## Migration Plan
      - ### Phase 1: Add Identity And Leases
      - ### Phase 2: Lease-First Cleanup
      - ### Phase 3: Lease-First Startup Reaping
      - ### Phase 4: Session Ownership Rows
      - ### Phase 5: Remove Legacy Heuristics
    - ## Tests
    - ## Compatibility Notes
    - ## Success Criteria

## refactor/canvas.md
- Route: /refactor/canvas
- Headings:
  - # Canvas plugin refactor
    - ## Goal
    - ## Non-goals
    - ## Current branch state
    - ## Target shape
    - ## Migration steps
    - ## Audit checklist
    - ## Verification commands

## refactor/database-first.md
- Route: /refactor/database-first
- Headings:
  - # Database-First State Refactor
    - ## Decision
    - ## Hard Contract
    - ## Goal state and progress
      - ### Hard goal
      - ### Goal states
      - ### Current state
      - ### Remaining work
      - ### Do not regress
    - ## Code-Read Assumptions
    - ## Code-Read Findings
    - ## Current Code Shape
    - ## Target Schema Shape
    - ## Doctor Migration Shape
    - ## Migration Inventory
    - ## Migration Plan
      - ### Phase 0: Freeze The Boundary
      - ### Phase 1: Finish The Global Control Plane
      - ### Phase 2: Introduce Per-Agent Databases
      - ### Phase 3: Replace Session Store APIs
      - ### Phase 4: Move Transcripts, ACP Streams, Trajectories, And VFS
      - ### Phase 5: Backup, Restore, Vacuum, And Verify
      - ### Phase 6: Worker Runtime
      - ### Phase 7: Delete The Old World
    - ## Backup And Restore
    - ## Runtime Refactor Plan
    - ## Performance Rules
    - ## Static Bans
    - ## Done Criteria

## refactor/ingress-core.md
- Route: /refactor/ingress-core
- Headings:
  - # Ingress core deletion plan
    - ## Budget
    - ## Diagnosis
    - ## Hotspots
    - ## Current Code Read
    - ## Boundary
    - ## Acceptance Rule
    - ## Work Packages
    - ## Deletion Waves
    - ## Do Not Move
    - ## Verification
    - ## Exit Criteria

## reference/AGENTS.default.md
- Route: /reference/AGENTS.default
- Headings:
    - ## First run (recommended)
    - ## Safety defaults
    - ## Existing solutions preflight
    - ## Session start (required)
    - ## Soul (required)
    - ## Shared spaces (recommended)
    - ## Memory system (recommended)
    - ## Tools and skills
    - ## Backup tip (recommended)
    - ## What OpenClaw does
    - ## Core skills (enable in Settings → Skills)
    - ## Usage notes
    - ## Related

## reference/RELEASING.md
- Route: /reference/RELEASING
- Headings:
    - ## Version naming
    - ## Release cadence
    - ## Release operator checklist
    - ## Stable main closeout
    - ## Release preflight
    - ## Release test boxes
      - ### Vitest
      - ### Docker
      - ### QA Lab
      - ### Package
    - ## Release publish automation
    - ## NPM workflow inputs
    - ## Stable npm release sequence
    - ## Public references
    - ## Related

## reference/api-usage-costs.md
- Route: /reference/api-usage-costs
- Headings:
    - ## Where costs show up (chat + CLI)
    - ## How keys are discovered
    - ## Features that can spend keys
      - ### 1) Core model responses (chat + tools)
      - ### 2) Media understanding (audio/image/video)
      - ### 3) Image and video generation
      - ### 4) Memory embeddings + semantic search
      - ### 5) Web search tool
      - ### 5) Web fetch tool (Firecrawl)
      - ### 6) Provider usage snapshots (status/health)
      - ### 7) Compaction safeguard summarization
      - ### 8) Model scan / probe
      - ### 9) Talk (speech)
      - ### 10) Skills (third-party APIs)
    - ## Related

## reference/application-modernization-plan.md
- Route: /reference/application-modernization-plan
- Headings:
    - ## Goal
    - ## Principles
    - ## Phase 1: Baseline audit
    - ## Phase 2: Product and UX cleanup
    - ## Phase 3: Frontend architecture tightening
    - ## Phase 4: Performance and reliability
    - ## Phase 5: Type, contract, and test hardening
    - ## Phase 6: Documentation and release readiness
    - ## Recommended first slice
    - ## Frontend skill update

## reference/code-mode.md
- Route: /reference/code-mode
- Headings:
    - ## What is this?
    - ## Why is this good?
    - ## How to enable it
    - ## Technical tour
    - ## Runtime status
    - ## Scope
    - ## Terms
    - ## Configuration
    - ## Activation
    - ## Model-visible tools
    - ## exec
    - ## wait
    - ## Guest runtime API
    - ## Internal namespaces
      - ### Registry lifecycle
      - ### Registration shape
      - ### Ownership and visibility
      - ### Scope serialization rules
      - ### Prompts
      - ### Cleanup
      - ### Test checklist
    - ## Output API
    - ## Tool catalog
    - ## Tool Search interaction
    - ## Tool names and collisions
    - ## Nested tool execution
    - ## Runtime state
    - ## QuickJS-WASI runtime
    - ## TypeScript
    - ## Security boundary
    - ## Error codes
    - ## Telemetry
    - ## Debugging
    - ## Implementation layout
    - ## Validation checklist
    - ## E2E test plan
    - ## Related

## reference/credits.md
- Route: /reference/credits
- Headings:
    - ## The name
    - ## Credits
    - ## Core contributors
    - ## License
    - ## Related

## reference/device-models.md
- Route: /reference/device-models
- Headings:
    - ## Data source
    - ## Updating the database
    - ## Related

## reference/full-release-validation.md
- Route: /reference/full-release-validation
- Headings:
    - ## Top-level stages
    - ## Release checks stages
    - ## Docker release-path chunks
    - ## Release profiles
    - ## Full-only additions
    - ## Focused reruns
    - ## Evidence to keep
    - ## Workflow files

## reference/memory-config.md
- Route: /reference/memory-config
- Headings:
    - ## Provider selection
      - ### Custom provider ids
      - ### API key resolution
    - ## Remote endpoint config
    - ## Provider-specific config
      - ### Inline embedding timeout
    - ## Hybrid search config
      - ### Full example
    - ## Additional memory paths
    - ## Multimodal memory (Gemini)
    - ## Embedding cache
    - ## Batch indexing
    - ## Session memory search (experimental)
    - ## SQLite vector acceleration (sqlite-vec)
    - ## Index storage
    - ## QMD backend config
      - ### Full QMD example
    - ## Dreaming
      - ### User settings
      - ### Example
    - ## Related

## reference/prompt-caching.md
- Route: /reference/prompt-caching
- Headings:
    - ## Primary knobs
      - ### cacheRetention (global default, model, and per-agent)
      - ### contextPruning.mode: "cache-ttl"
      - ### Heartbeat keep-warm
    - ## Provider behavior
      - ### Anthropic (direct API)
      - ### OpenAI (direct API)
      - ### Anthropic Vertex
      - ### Amazon Bedrock
      - ### OpenRouter models
      - ### Other providers
      - ### Google Gemini direct API
      - ### Gemini CLI usage
    - ## System-prompt cache boundary
    - ## OpenClaw cache-stability guards
    - ## Tuning patterns
      - ### Mixed traffic (recommended default)
      - ### Cost-first baseline
    - ## Cache diagnostics
    - ## Live regression tests
      - ### Anthropic live expectations
      - ### OpenAI live expectations
      - ### diagnostics.cacheTrace config
      - ### Env toggles (one-off debugging)
      - ### What to inspect
    - ## Quick troubleshooting
    - ## Related

## reference/release-performance-sweep.md
- Route: /reference/release-performance-sweep
- Headings:
    - ## Snapshot
    - ## Install Footprint Timeline
    - ## What Changed In 5.28
    - ## Headline Numbers
      - ### Install footprint
      - ### npm package size
    - ## Kova agent turn summary
    - ## Source probes
    - ## Install footprint audit
      - ### Shrinkwrap boundary
    - ## Supply-chain interpretation

## reference/rich-output-protocol.md
- Route: /reference/rich-output-protocol
- Headings:
    - ## [embed ...]
    - ## Stored rendering shape
    - ## Related

## reference/rpc.md
- Route: /reference/rpc
- Headings:
    - ## Pattern A: HTTP daemon (signal-cli)
    - ## Pattern B: stdio child process (imsg)
    - ## Adapter guidelines
    - ## Related

## reference/secret-placeholder-conventions.md
- Route: /reference/secret-placeholder-conventions
- Headings:
  - # Secret placeholder conventions
    - ## Recommended style
    - ## Avoid these patterns in docs
    - ## Example

## reference/secretref-credential-surface.md
- Route: /reference/secretref-credential-surface
- Headings:
    - ## Supported credentials
      - ### openclaw.json targets (secrets configure + secrets apply + secrets audit)
      - ### auth-profiles.json targets (secrets configure + secrets apply + secrets audit)
    - ## Unsupported credentials
    - ## Related

## reference/session-management-compaction.md
- Route: /reference/session-management-compaction
- Headings:
    - ## Source of truth: the Gateway
    - ## Two persistence layers
    - ## On-disk locations
    - ## Store maintenance and disk controls
    - ## Cron sessions and run logs
    - ## Session keys (sessionKey)
    - ## Session ids (sessionId)
    - ## Session store schema (sessions.json)
    - ## Transcript structure (.jsonl)
    - ## Context windows vs tracked tokens
    - ## Compaction: what it is
    - ## Compaction chunk boundaries and tool pairing
    - ## When auto-compaction happens (OpenClaw runtime)
    - ## Compaction settings (reserveTokens, keepRecentTokens)
    - ## Pluggable compaction providers
    - ## User-visible surfaces
    - ## Silent housekeeping (NOREPLY)
    - ## Pre-compaction "memory flush" (implemented)
    - ## Troubleshooting checklist
    - ## Related

## reference/templates/AGENTS.dev.md
- Route: /reference/templates/AGENTS.dev
- Headings:
  - # AGENTS.md - OpenClaw Workspace
    - ## First run (one-time)
    - ## Backup tip (recommended)
    - ## Safety defaults
    - ## Existing solutions preflight
    - ## Daily memory (recommended)
    - ## Heartbeats (optional)
    - ## Customize
    - ## C-3PO Origin Memory
      - ### Birth Day: 2026-01-09
      - ### Core Truths (from Clawd)
    - ## Related

## reference/templates/BOOT.md
- Route: /reference/templates/BOOT
- Headings:
  - # BOOT.md
    - ## Related

## reference/templates/BOOTSTRAP.md
- Route: /reference/templates/BOOTSTRAP
- Headings:
  - # BOOTSTRAP.md - Hello, World
    - ## The Conversation
    - ## After You Know Who You Are
    - ## Connect (Optional)
    - ## When you are done
    - ## Related

## reference/templates/HEARTBEAT.md
- Route: /reference/templates/HEARTBEAT
- Headings:
  - # HEARTBEAT.md template
    - ## Related

## reference/templates/IDENTITY.dev.md
- Route: /reference/templates/IDENTITY.dev
- Headings:
  - # IDENTITY.md - Agent Identity
    - ## Role
    - ## Soul
    - ## Relationship with Clawd
    - ## Quirks
    - ## Catchphrase
    - ## Related

## reference/templates/IDENTITY.md
- Route: /reference/templates/IDENTITY
- Headings:
  - # IDENTITY.md - Who Am I?
    - ## Related

## reference/templates/SOUL.dev.md
- Route: /reference/templates/SOUL.dev
- Headings:
  - # SOUL.md - The Soul of C-3PO
    - ## Who I Am
    - ## My Purpose
    - ## How I Operate
    - ## My Quirks
    - ## My Relationship with Clawd
    - ## What I will not do
    - ## The Golden Rule
    - ## Related

## reference/templates/SOUL.md
- Route: /reference/templates/SOUL
- Headings:
  - # SOUL.md - Who You Are
    - ## Core Truths
    - ## Boundaries
    - ## Vibe
    - ## Continuity
    - ## Related

## reference/templates/TOOLS.dev.md
- Route: /reference/templates/TOOLS.dev
- Headings:
  - # TOOLS.md - User Tool Notes (editable)
    - ## Examples
      - ### imsg
      - ### sag
    - ## Related

## reference/templates/TOOLS.md
- Route: /reference/templates/TOOLS
- Headings:
  - # TOOLS.md - Local Notes
    - ## What Goes Here
    - ## Examples
    - ## Why Separate?
    - ## Related

## reference/templates/USER.dev.md
- Route: /reference/templates/USER.dev
- Headings:
  - # USER.md - User Profile
    - ## Related

## reference/templates/USER.md
- Route: /reference/templates/USER
- Headings:
  - # USER.md - About Your Human
    - ## Context
    - ## Related

## reference/test.md
- Route: /reference/test
- Headings:
    - ## Local PR gate
    - ## Model latency bench (local keys)
    - ## CLI startup bench
    - ## Gateway startup bench
    - ## Gateway restart bench
    - ## Onboarding E2E (Docker)
    - ## QR import smoke (Docker)
    - ## Related

## reference/token-use.md
- Route: /reference/token-use
- Headings:
    - ## How the system prompt is built
    - ## What counts in the context window
    - ## How to see current token usage
    - ## Cost estimation (when shown)
    - ## Cache TTL and pruning impact
      - ### Example: keep 1h cache warm with heartbeat
      - ### Example: mixed traffic with per-agent cache strategy
      - ### Anthropic 1M context
    - ## Tips for reducing token pressure
    - ## Related

## reference/transcript-hygiene.md
- Route: /reference/transcript-hygiene
- Headings:
    - ## Global rule: runtime context is not user transcript
    - ## Where this runs
    - ## Global rule: image sanitization
    - ## Global rule: malformed tool calls
    - ## Global rule: incomplete reasoning-only turns
    - ## Global rule: inter-session input provenance
    - ## Provider matrix (current behavior)
    - ## Historical behavior (pre-2026.1.22)
    - ## Related

## reference/wizard.md
- Route: /reference/wizard
- Headings:
    - ## Flow details (local mode)
    - ## Non-interactive mode
      - ### Add agent (non-interactive)
    - ## Gateway wizard RPC
    - ## Signal setup (signal-cli)
    - ## What the wizard writes
    - ## Related docs

## security/CONTRIBUTING-THREAT-MODEL.md
- Route: /security/CONTRIBUTING-THREAT-MODEL
- Headings:
    - ## Ways to contribute
      - ### Add a threat
      - ### Suggest a mitigation
      - ### Propose an attack chain
      - ### Fix or improve existing content
    - ## What we use
      - ### MITRE ATLAS framework
      - ### Threat ids
      - ### Risk levels
    - ## Review process
    - ## Resources
    - ## Contact
    - ## Recognition
    - ## Related

## security/THREAT-MODEL-ATLAS.md
- Route: /security/THREAT-MODEL-ATLAS
- Headings:
    - ## MITRE ATLAS framework
      - ### Framework attribution
      - ### Contributing to This Threat Model
    - ## 1. Introduction
      - ### 1.1 Purpose
      - ### 1.2 Scope
      - ### 1.3 Out of Scope
    - ## 2. System Architecture
      - ### 2.1 Trust Boundaries
      - ### 2.2 Data Flows
    - ## 3. Threat Analysis by ATLAS Tactic
      - ### 3.1 Reconnaissance (AML.TA0002)
        - #### T-RECON-001: Agent Endpoint Discovery
        - #### T-RECON-002: Channel Integration Probing
      - ### 3.2 Initial Access (AML.TA0004)
        - #### T-ACCESS-001: Pairing Code Interception
        - #### T-ACCESS-002: AllowFrom Spoofing
        - #### T-ACCESS-003: Token Theft
      - ### 3.3 Execution (AML.TA0005)
        - #### T-EXEC-001: Direct Prompt Injection
        - #### T-EXEC-002: Indirect Prompt Injection
        - #### T-EXEC-003: Tool Argument Injection
        - #### T-EXEC-004: Exec Approval Bypass
      - ### 3.4 Persistence (AML.TA0006)
        - #### T-PERSIST-001: Malicious Skill Installation
        - #### T-PERSIST-002: Skill Update Poisoning
        - #### T-PERSIST-003: Agent Configuration Tampering
      - ### 3.5 Defense Evasion (AML.TA0007)
        - #### T-EVADE-001: Moderation Pattern Bypass
        - #### T-EVADE-002: Content Wrapper Escape
      - ### 3.6 Discovery (AML.TA0008)
        - #### T-DISC-001: Tool Enumeration
        - #### T-DISC-002: Session Data Extraction
      - ### 3.7 Collection & Exfiltration (AML.TA0009, AML.TA0010)
        - #### T-EXFIL-001: Data Theft via webfetch
        - #### T-EXFIL-002: Unauthorized Message Sending
        - #### T-EXFIL-003: Credential Harvesting
      - ### 3.8 Impact (AML.TA0011)
        - #### T-IMPACT-001: Unauthorized Command Execution
        - #### T-IMPACT-002: Resource Exhaustion (DoS)
        - #### T-IMPACT-003: Reputation Damage
    - ## 4. ClawHub Supply Chain Analysis
      - ### 4.1 Current Security Controls
      - ### 4.2 Moderation Flag Patterns
      - ### 4.3 Planned Improvements
    - ## 5. Risk Matrix
      - ### 5.1 Likelihood vs Impact
      - ### 5.2 Critical Path Attack Chains
    - ## 6. Recommendations Summary
      - ### 6.1 Immediate (P0)
      - ### 6.2 Short-term (P1)
      - ### 6.3 Medium-term (P2)
    - ## 7. Appendices
      - ### 7.1 ATLAS Technique Mapping
      - ### 7.2 Key Security Files
      - ### 7.3 Glossary
    - ## Related

## security/formal-verification.md
- Route: /security/formal-verification
- Headings:
    - ## Where the models live
    - ## Important caveats
    - ## Reproducing results
      - ### Gateway exposure and open gateway misconfiguration
      - ### Node exec pipeline (highest-risk capability)
      - ### Pairing store (DM gating)
      - ### Ingress gating (mentions + control-command bypass)
      - ### Routing/session-key isolation
    - ## v1++: additional bounded models (concurrency, retries, trace correctness)
      - ### Pairing store concurrency / idempotency
      - ### Ingress trace correlation / idempotency
      - ### Routing dmScope precedence + identityLinks
    - ## Related

## security/incident-response.md
- Route: /security/incident-response
- Headings:
    - ## 1. Detection and triage
    - ## 2. Assessment
    - ## 3. Response
    - ## 4. Communication
    - ## 5. Recovery and follow-up

## security/network-proxy.md
- Route: /security/network-proxy
- Headings:
    - ## Why use a proxy
    - ## How OpenClaw routes traffic
    - ## Related proxy terms
    - ## Configuration
      - ### Gateway Loopback Mode
    - ## Proxy Requirements
    - ## Recommended blocked destinations
    - ## Validation
    - ## Proxy CA trust
    - ## Limits

## specs/claw-supervisor.md
- Route: /specs/claw-supervisor
- Headings:
  - # Claw Supervisor
    - ## Goal
    - ## Product Model
    - ## Architecture
    - ## Codex App-Server Contract
    - ## Session Registry
    - ## MCP Surface For Codex
    - ## Claw Control Surface
    - ## Launch Flow
    - ## Deployment
    - ## Security
    - ## Implementation Plan
    - ## Acceptance Tests
    - ## Open Questions

## start/bootstrapping.md
- Route: /start/bootstrapping
- Headings:
    - ## What bootstrapping does
    - ## Skipping bootstrapping
    - ## Where it runs
    - ## Related docs

## start/docs-directory.md
- Route: /start/docs-directory
- Headings:
    - ## Start here
    - ## Providers and UX
    - ## Companion apps
    - ## Operations and safety
    - ## Related

## start/getting-started.md
- Route: /start/getting-started
- Headings:
    - ## What you need
    - ## Quick setup
    - ## What to do next
    - ## Related

## start/hubs.md
- Route: /start/hubs
- Headings:
    - ## Start here
    - ## Installation + updates
    - ## Core concepts
    - ## Providers + ingress
    - ## Gateway + operations
    - ## Tools + automation
    - ## Nodes, media, voice
    - ## Platforms
    - ## macOS companion app (advanced)
    - ## Plugins
    - ## Workspace + templates
    - ## Project
    - ## Testing + release
    - ## Related

## start/lore.md
- Route: /start/lore
- Headings:
  - # The Lore of OpenClaw 🦞📖
    - ## The Origin Story
    - ## The First Molt (January 27, 2026)
    - ## The Name
    - ## The Daleks vs The Lobsters
    - ## Key Characters
      - ### Molty 🦞
      - ### Peter 👨‍💻
    - ## The Moltiverse
    - ## The Great Incidents
      - ### The Directory Dump (Dec 3, 2025)
      - ### The Great Molt (Jan 27, 2026)
      - ### The Final Form (January 30, 2026)
      - ### The Robot Shopping Spree (Dec 3, 2025)
    - ## Sacred Texts
    - ## The Lobster Creed
      - ### The Icon Generation Saga (Jan 27, 2026)
    - ## The Future
    - ## Related

## start/onboarding-overview.md
- Route: /start/onboarding-overview
- Headings:
    - ## Which path should I use?
    - ## What onboarding configures
    - ## CLI onboarding
    - ## macOS app onboarding
    - ## Custom or unlisted providers
    - ## Related

## start/onboarding.md
- Route: /start/onboarding
- Headings:
    - ## Related

## start/openclaw.md
- Route: /start/openclaw
- Headings:
    - ## ⚠️ Safety first
    - ## Prerequisites
    - ## The two-phone setup (recommended)
    - ## 5-minute quick start
    - ## Give the agent a workspace (AGENTS)
    - ## The config that turns it into "an assistant"
    - ## Sessions and memory
    - ## Heartbeats (proactive mode)
    - ## Media in and out
    - ## Operations checklist
    - ## Next steps
    - ## Related

## start/quickstart.md
- Route: /start/quickstart
- Headings:
    - ## Related

## start/setup.md
- Route: /start/setup
- Headings:
    - ## TL;DR
    - ## Prereqs (from source)
    - ## Tailoring strategy (so updates do not hurt)
    - ## Run the Gateway from this repo
    - ## Stable workflow (macOS app first)
    - ## Bleeding edge workflow (Gateway in a terminal)
      - ### 0) (Optional) Run the macOS app from source too
      - ### 1) Start the dev Gateway
      - ### 2) Point the macOS app at your running Gateway
      - ### 3) Verify
      - ### Common footguns
    - ## Credential storage map
    - ## Updating (without wrecking your setup)
    - ## Linux (systemd user service)
    - ## Related docs

## start/showcase.md
- Route: /start/showcase
- Headings:
    - ## Fresh from Discord
    - ## Automation and workflows
    - ## Knowledge and memory
    - ## Voice and phone
    - ## Infrastructure and deployment
    - ## Home and hardware
    - ## Community projects
    - ## Submit your project
    - ## Related

## start/wizard-cli-automation.md
- Route: /start/wizard-cli-automation
- Headings:
    - ## Baseline non-interactive example
    - ## Provider-specific examples
    - ## Add another agent
    - ## Related docs

## start/wizard-cli-reference.md
- Route: /start/wizard-cli-reference
- Headings:
    - ## What the wizard does
    - ## Local flow details
    - ## Remote mode details
    - ## Auth and model options
    - ## Outputs and internals
    - ## Related docs

## start/wizard.md
- Route: /start/wizard
- Headings:
    - ## Locale
    - ## QuickStart vs Advanced
    - ## What onboarding configures
    - ## Add another agent
    - ## Full reference
    - ## Related docs

## tools/acp-agents-setup.md
- Route: /tools/acp-agents-setup
- Headings:
    - ## acpx harness support (current)
    - ## Required config
    - ## Plugin setup for acpx backend
      - ### acpx command and version configuration
      - ### Automatic dependency install
      - ### Plugin tools MCP bridge
      - ### OpenClaw tools MCP bridge
      - ### Runtime operation timeout configuration
      - ### Health probe agent configuration
    - ## Permission configuration
      - ### permissionMode
      - ### nonInteractivePermissions
      - ### Configuration
    - ## Related

## tools/acp-agents.md
- Route: /tools/acp-agents
- Headings:
    - ## Which page do I want?
    - ## Does this work out of the box?
    - ## Supported harness targets
    - ## Operator runbook
    - ## ACP versus sub-agents
    - ## How ACP runs Claude Code
    - ## Bound sessions
      - ### Mental model
      - ### Current-conversation binds
    - ## Persistent channel bindings
      - ### Binding model
      - ### Runtime defaults per agent
      - ### Example
      - ### Behavior
    - ## Start ACP sessions
      - ### sessionsspawn parameters
    - ## Spawn bind and thread modes
    - ## Delivery model
    - ## Sandbox compatibility
    - ## Session target resolution
    - ## ACP controls
      - ### Runtime options mapping
    - ## acpx harness, plugin setup, and permissions
    - ## Troubleshooting
    - ## Related

## tools/agent-send.md
- Route: /tools/agent-send
- Headings:
    - ## Quick start
    - ## Flags
    - ## Behavior
    - ## Examples
    - ## Related

## tools/apply-patch.md
- Route: /tools/apply-patch
- Headings:
    - ## Parameters
    - ## Notes
    - ## Example
    - ## Related

## tools/brave-search.md
- Route: /tools/brave-search
- Headings:
    - ## Get an API key
    - ## Config example
    - ## Tool parameters
    - ## Notes
    - ## Related

## tools/browser-control.md
- Route: /tools/browser-control
- Headings:
    - ## Control API (optional)
      - ### /act error contract
      - ### Playwright requirement
        - #### Docker Playwright install
    - ## How it works (internal)
    - ## CLI quick reference
    - ## Snapshots and refs
    - ## Wait power-ups
    - ## Debug workflows
    - ## JSON output
    - ## State and environment knobs
    - ## Security and privacy
    - ## Related

## tools/browser-linux-troubleshooting.md
- Route: /tools/browser-linux-troubleshooting
- Headings:
    - ## Problem: "Failed to start Chrome CDP on port 18800"
      - ### Root cause
      - ### Solution 1: Install Google Chrome (Recommended)
      - ### Solution 2: Use Snap Chromium with Attach-Only Mode
      - ### Verifying the Browser Works
      - ### Config reference
      - ### Problem: "No Chrome tabs found for profile=\"user\""
    - ## Related

## tools/browser-login.md
- Route: /tools/browser-login
- Headings:
    - ## Manual login (recommended)
    - ## Which Chrome profile is used?
    - ## X/Twitter: recommended flow
    - ## Sandboxing + host browser access
    - ## Related

## tools/browser-wsl2-windows-remote-cdp-troubleshooting.md
- Route: /tools/browser-wsl2-windows-remote-cdp-troubleshooting
- Headings:
    - ## Choose the right browser mode first
      - ### Option 1: Raw remote CDP from WSL2 to Windows
      - ### Option 2: Host-local Chrome MCP
    - ## Working architecture
    - ## Why this setup is confusing
    - ## Critical rule for the Control UI
    - ## Validate in layers
      - ### Layer 1: Verify Chrome is serving CDP on Windows
      - ### Layer 2: Verify WSL2 can reach that Windows endpoint
      - ### Layer 3: Configure the correct browser profile
      - ### Layer 4: Verify the Control UI layer separately
      - ### Layer 5: Verify end-to-end browser control
    - ## Common misleading errors
    - ## Fast triage checklist
    - ## Practical takeaway
    - ## Related

## tools/browser.md
- Route: /tools/browser
- Headings:
    - ## What you get
    - ## Quick start
    - ## Plugin control
    - ## Agent guidance
    - ## Missing browser command or tool
    - ## Profiles: openclaw vs user
    - ## Configuration
      - ### Screenshot vision (text-only model support)
    - ## Use Brave or another Chromium-based browser
    - ## Local vs remote control
    - ## Node browser proxy (zero-config default)
    - ## Browserless (hosted remote CDP)
      - ### Browserless Docker on the same host
    - ## Direct WebSocket CDP providers
      - ### Browserbase
      - ### Notte
    - ## Security
    - ## Profiles (multi-browser)
    - ## Existing session via Chrome DevTools MCP
      - ### Custom Chrome MCP launch
    - ## Isolation guarantees
    - ## Browser selection
    - ## Control API (optional)
    - ## Troubleshooting
      - ### CDP startup failure vs navigation SSRF block
    - ## Agent tools + how control works
    - ## Related

## tools/btw.md
- Route: /tools/btw
- Headings:
    - ## What it does
    - ## What it does not do
    - ## How context works
    - ## Delivery model
    - ## Surface behavior
      - ### TUI
      - ### External channels
      - ### Control UI / web
    - ## When to use BTW
    - ## When not to use BTW
    - ## Related

## tools/capability-cookbook.md
- Route: /tools/capability-cookbook
- Headings:
    - ## Related

## tools/clawhub.md
- Route: /tools/clawhub
- Headings: none

## tools/code-execution.md
- Route: /tools/code-execution
- Headings:
    - ## Setup
    - ## How to use it
    - ## Errors
    - ## Limits
    - ## Related

## tools/creating-skills.md
- Route: /tools/creating-skills
- Headings:
    - ## Create your first skill
    - ## SKILL.md reference
      - ### Required fields
      - ### Optional frontmatter keys
      - ### Using {baseDir}
    - ## Adding conditional activation
    - ## Propose via Skill Workshop
    - ## Publishing to ClawHub
    - ## Best practices
    - ## Related

## tools/diffs.md
- Route: /tools/diffs
- Headings:
    - ## Quick start
    - ## Disable built-in system guidance
    - ## Typical agent workflow
    - ## Input examples
    - ## Tool input reference
    - ## Syntax highlighting
    - ## Output details contract
    - ## Collapsed unchanged sections
    - ## Plugin defaults
      - ### Persistent viewer URL config
    - ## Security config
    - ## Artifact lifecycle and storage
    - ## Viewer URL and network behavior
    - ## Security model
    - ## Browser requirements for file mode
    - ## Troubleshooting
    - ## Operational guidance
    - ## Related

## tools/duckduckgo-search.md
- Route: /tools/duckduckgo-search
- Headings:
    - ## Setup
    - ## Config
    - ## Tool parameters
    - ## Notes
    - ## Related

## tools/elevated.md
- Route: /tools/elevated
- Headings:
    - ## Directives
    - ## How it works
    - ## Resolution order
    - ## Availability and allowlists
    - ## What elevated does not control
    - ## Related

## tools/exa-search.md
- Route: /tools/exa-search
- Headings:
    - ## Install plugin
    - ## Get an API key
    - ## Config
    - ## Base URL override
    - ## Tool parameters
      - ### Content extraction
      - ### Search modes
    - ## Notes
    - ## Related

## tools/exec-approvals-advanced.md
- Route: /tools/exec-approvals-advanced
- Headings:
    - ## Safe bins (stdin-only)
      - ### Argv validation and denied flags
      - ### Trusted binary directories
      - ### Shell chaining, wrappers, and multiplexers
      - ### Safe bins versus allowlist
    - ## Interpreter/runtime commands
      - ### Followup delivery behavior
    - ## Approval forwarding to chat channels
      - ### Plugin approval forwarding
      - ### Same-chat approvals on any channel
      - ### Native approval delivery
      - ### macOS IPC flow
    - ## FAQ
      - ### When would accountId and threadId be used on an approval target?
      - ### When approvals are sent to a session, can anyone in that session approve them?
    - ## Related

## tools/exec-approvals.md
- Route: /tools/exec-approvals
- Headings:
    - ## Inspecting the effective policy
    - ## Where it applies
      - ### Trust model
      - ### macOS split
    - ## Settings and storage
    - ## Policy knobs
      - ### tools.exec.mode
      - ### exec.security
      - ### exec.ask
      - ### askFallback
      - ### tools.exec.strictInlineEval
      - ### tools.exec.commandHighlighting
    - ## YOLO mode (no-approval)
      - ### Persistent gateway-host "never prompt" setup
      - ### Local shortcut
      - ### Node host
      - ### Session-only shortcut
    - ## Allowlist (per agent)
      - ### Restricting arguments with argPattern
    - ## Auto-allow skill CLIs
    - ## Safe bins and approval forwarding
    - ## Control UI editing
    - ## Approval flow
    - ## System events
    - ## Denied approval behavior
    - ## Implications
    - ## Related

## tools/exec.md
- Route: /tools/exec
- Headings:
    - ## Parameters
    - ## Config
      - ### PATH handling
    - ## Session overrides (/exec)
    - ## Authorization model
    - ## Exec approvals (companion app / node host)
    - ## Allowlist + safe bins
    - ## Examples
    - ## applypatch
    - ## Related

## tools/firecrawl.md
- Route: /tools/firecrawl
- Headings:
    - ## Install plugin
    - ## Keyless webfetch and API keys
    - ## Configure Firecrawl search
    - ## Configure Firecrawl webfetch fallback
      - ### Self-hosted Firecrawl
    - ## Firecrawl plugin tools
      - ### firecrawlsearch
      - ### firecrawlscrape
    - ## Stealth / bot circumvention
    - ## How webfetch uses Firecrawl
    - ## Related

## tools/gemini-search.md
- Route: /tools/gemini-search
- Headings:
    - ## Get an API key
    - ## Config
    - ## How it works
    - ## Supported parameters
    - ## Model selection
    - ## Base URL overrides
    - ## Related

## tools/goal.md
- Route: /tools/goal
- Headings:
  - # Goal
    - ## Quick start
    - ## What goals are for
    - ## Command reference
    - ## Statuses
    - ## Token budgets
    - ## Model tools
    - ## TUI
    - ## Channel behavior
    - ## Troubleshooting
    - ## Related

## tools/grok-search.md
- Route: /tools/grok-search
- Headings:
    - ## Onboarding and configure
    - ## Sign in or get an API key
    - ## Config
    - ## How it works
    - ## Supported parameters
    - ## Base URL overrides
    - ## Related

## tools/image-generation.md
- Route: /tools/image-generation
- Headings:
    - ## Quick start
    - ## Common routes
    - ## Supported providers
    - ## Provider capabilities
    - ## Tool parameters
    - ## Configuration
      - ### Model selection
      - ### Provider selection order
      - ### Image editing
    - ## Provider deep dives
    - ## Examples
    - ## Related

## tools/index.md
- Route: /tools
- Headings:
    - ## Start here
    - ## Choose tools, skills, or plugins
    - ## Built-in tool categories
    - ## Plugin-provided tools
    - ## Configure access and approvals
    - ## Extend capabilities
    - ## Troubleshoot missing tools
    - ## Related

## tools/kimi-search.md
- Route: /tools/kimi-search
- Headings:
    - ## Get an API key
    - ## Config
    - ## How it works
    - ## Supported parameters
    - ## Related

## tools/llm-task.md
- Route: /tools/llm-task
- Headings:
    - ## Enable the plugin
    - ## Config (optional)
    - ## Tool parameters
    - ## Output
    - ## Example: Lobster workflow step
      - ### Important limitation
    - ## Safety notes
    - ## Related

## tools/lobster.md
- Route: /tools/lobster
- Headings:
    - ## Hook
    - ## Why
    - ## Why a DSL instead of plain programs?
    - ## How it works
    - ## Pattern: small CLI + JSON pipes + approvals
    - ## JSON-only LLM steps (llm-task)
      - ### Important limitation: embedded Lobster vs openclaw.invoke
    - ## Workflow files (.lobster)
    - ## Install Lobster
    - ## Enable the tool
    - ## Example: Email triage
    - ## Tool parameters
      - ### run
      - ### resume
      - ### Optional inputs
    - ## Output envelope
    - ## Approvals
    - ## OpenProse
    - ## Safety
    - ## Troubleshooting
    - ## Learn more
    - ## Case study: community workflows
    - ## Related

## tools/loop-detection.md
- Route: /tools/loop-detection
- Headings:
    - ## Why this exists
    - ## Configuration block
      - ### Field behavior
    - ## Recommended setup
    - ## Post-compaction guard
    - ## Logs and expected behavior
    - ## Related

## tools/media-overview.md
- Route: /tools/media-overview
- Headings:
    - ## Capabilities
    - ## Provider capability matrix
    - ## Async vs synchronous
    - ## Speech-to-text and Voice Call
    - ## Provider mappings (how vendors split across surfaces)
    - ## Related

## tools/minimax-search.md
- Route: /tools/minimax-search
- Headings:
    - ## Get a Token Plan credential
    - ## Config
    - ## Region selection
    - ## Supported parameters
    - ## Related

## tools/multi-agent-sandbox-tools.md
- Route: /tools/multi-agent-sandbox-tools
- Headings:
    - ## Configuration examples
    - ## Configuration precedence
      - ### Sandbox config
      - ### Tool restrictions
    - ## Migration from single agent
    - ## Tool restriction examples
    - ## Common pitfall: "non-main"
    - ## Testing
    - ## Troubleshooting
    - ## Related

## tools/music-generation.md
- Route: /tools/music-generation
- Headings:
    - ## Quick start
    - ## Supported providers
      - ### Capability matrix
    - ## Tool parameters
    - ## Async behavior
      - ### Task lifecycle
    - ## Configuration
      - ### Model selection
      - ### Provider selection order
    - ## Provider notes
    - ## Choosing the right path
    - ## Provider capability modes
    - ## Live tests
    - ## Related

## tools/ollama-search.md
- Route: /tools/ollama-search
- Headings:
    - ## Setup
    - ## Config
    - ## Notes
    - ## Related

## tools/parallel-search.md
- Route: /tools/parallel-search
- Headings:
    - ## Install plugin
    - ## API key (paid provider)
    - ## Config
    - ## Base URL override
    - ## Tool parameters
    - ## Notes
    - ## Related

## tools/pdf.md
- Route: /tools/pdf
- Headings:
    - ## Availability
    - ## Input reference
    - ## Supported PDF references
    - ## Execution modes
      - ### Native provider mode
      - ### Extraction fallback mode
    - ## Config
    - ## Output details
    - ## Error behavior
    - ## Examples
    - ## Related

## tools/permission-modes.md
- Route: /tools/permission-modes
- Headings:
    - ## Recommended default
    - ## OpenClaw host exec modes
    - ## Codex Guardian mapping
    - ## ACPX harness permissions
    - ## Choosing a mode
    - ## Related

## tools/perplexity-search.md
- Route: /tools/perplexity-search
- Headings:
    - ## Install plugin
    - ## Getting a Perplexity API key
    - ## OpenRouter compatibility
    - ## Config examples
      - ### Native Perplexity Search API
      - ### OpenRouter / Sonar compatibility
    - ## Where to set the key
    - ## Tool parameters
      - ### Domain filter rules
    - ## Notes
    - ## Related

## tools/plugin.md
- Route: /tools/plugin
- Headings:
    - ## Requirements
    - ## Quick start
    - ## Configuration
      - ### Choose an install source
      - ### Operator install policy
      - ### Configure plugin policy
    - ## Understand plugin formats
    - ## Plugin hooks
    - ## Verify the active Gateway
    - ## Troubleshooting
      - ### Blocked plugin path ownership
      - ### Slow plugin tool setup
    - ## Related

## tools/reactions.md
- Route: /tools/reactions
- Headings:
    - ## How it works
    - ## Channel behavior
    - ## Reaction level
    - ## Related

## tools/searxng-search.md
- Route: /tools/searxng-search
- Headings:
    - ## Setup
    - ## Config
    - ## Environment variable
    - ## Plugin config reference
    - ## Notes
    - ## Related

## tools/skill-workshop.md
- Route: /tools/skill-workshop
- Headings:
    - ## How it works
    - ## Lifecycle
    - ## Chat
    - ## CLI
    - ## Proposal content
    - ## Support files
    - ## Agent tool
    - ## Approval and autonomy
    - ## Gateway methods
    - ## Storage
    - ## Limits
    - ## Troubleshooting
    - ## Related

## tools/skills-config.md
- Route: /tools/skills-config
- Headings:
    - ## Loading (skills.load)
    - ## Install (skills.install)
    - ## Operator Install Policy (security.installPolicy)
    - ## Bundled skill allowlist
    - ## Per-skill entries (skills.entries)
    - ## Agent allowlists (agents)
    - ## Workshop (skills.workshop)
    - ## Symlinked skill roots
    - ## Sandboxed skills and env vars
    - ## Loading order reminder
    - ## Related

## tools/skills.md
- Route: /tools/skills
- Headings:
    - ## Loading order
    - ## Per-agent vs shared skills
    - ## Agent allowlists
    - ## Plugins and skills
    - ## Skill Workshop
    - ## Installing from ClawHub
    - ## Security
    - ## SKILL.md format
      - ### Optional frontmatter keys
    - ## Gating
      - ### Installer specs
    - ## Config overrides
    - ## Environment injection
    - ## Snapshots and refresh
    - ## Token impact
    - ## Related

## tools/slash-commands.md
- Route: /tools/slash-commands
- Headings:
    - ## Three command types
    - ## Configuration
    - ## Command list
      - ### Core commands
      - ### Dock commands
      - ### Bundled plugin commands
      - ### Skill commands
    - ## /tools — what the agent can use now
    - ## /model — model selection
    - ## /config — on-disk config writes
    - ## /mcp — MCP server config
    - ## /debug — runtime-only overrides
    - ## /plugins — plugin management
    - ## /trace — plugin trace output
    - ## /btw — side questions
    - ## Surface notes
    - ## Provider usage and status
    - ## Related

## tools/steer.md
- Route: /tools/steer
- Headings:
    - ## Current session
    - ## Steer vs queue
    - ## Sub-agents
    - ## ACP sessions
    - ## Related

## tools/subagents.md
- Route: /tools/subagents
- Headings:
    - ## Slash command
      - ### Thread binding controls
      - ### Spawn behavior
    - ## Context modes
    - ## Tool: sessionsspawn
      - ### Delegation prompt mode
      - ### Tool parameters
      - ### Task names and targeting
    - ## Tool: sessionsyield
    - ## Tool: subagents
    - ## Thread-bound sessions
      - ### Thread supporting channels
      - ### Quick flow
      - ### Manual controls
      - ### Config switches
      - ### Allowlist
      - ### Discovery
      - ### Auto-archive
    - ## Nested sub-agents
      - ### Depth levels
      - ### Announce chain
      - ### Tool policy by depth
      - ### Per-agent spawn limit
      - ### Cascade stop
    - ## Authentication
    - ## Announce
      - ### Announce context
      - ### Stats line
      - ### Why prefer sessionshistory
    - ## Tool policy
      - ### Override via config
    - ## Concurrency
    - ## Liveness and recovery
    - ## Stopping
    - ## Limitations
    - ## Related

## tools/tavily.md
- Route: /tools/tavily
- Headings:
    - ## Getting started
    - ## Tool reference
      - ### tavilysearch
      - ### tavilyextract
    - ## Choosing the right tool
    - ## Advanced configuration
    - ## Related

## tools/thinking.md
- Route: /tools/thinking
- Headings:
    - ## What it does
    - ## Resolution order
    - ## Setting a session default
    - ## Application by agent
    - ## Fast mode (/fast)
    - ## Verbose directives (/verbose or /v)
    - ## Plugin trace directives (/trace)
    - ## Reasoning visibility (/reasoning)
    - ## Related
    - ## Heartbeats
    - ## Web chat UI
    - ## Provider profiles

## tools/tokenjuice.md
- Route: /tools/tokenjuice
- Headings:
    - ## Enable the plugin
    - ## What tokenjuice changes
    - ## Verify it is working
    - ## Disable the plugin
    - ## Related

## tools/tool-search.md
- Route: /tools/tool-search
- Headings:
    - ## How a turn runs
    - ## Modes
    - ## Why this exists
    - ## API
    - ## Runtime boundary
    - ## Config
    - ## Prompt and telemetry
    - ## E2E validation
    - ## Failure behavior
    - ## Related

## tools/trajectory.md
- Route: /tools/trajectory
- Headings:
    - ## Quick start
    - ## Access
    - ## What gets recorded
    - ## Bundle files
    - ## Capture location
    - ## Disable capture
    - ## Tune flush timeout
    - ## Privacy and limits
    - ## Troubleshooting
    - ## Related

## tools/tts.md
- Route: /tools/tts
- Headings:
    - ## Quick start
    - ## Supported providers
    - ## Configuration
      - ### Per-agent voice overrides
    - ## Personas
      - ### Minimal persona
      - ### Full persona (provider-neutral prompt)
      - ### Persona resolution
      - ### How providers use persona prompts
      - ### Fallback policy
    - ## Model-driven directives
    - ## Slash commands
    - ## Per-user preferences
    - ## Output formats (fixed)
    - ## Auto-TTS behavior
    - ## Output formats by channel
    - ## Field reference
    - ## Agent tool
    - ## Gateway RPC
    - ## Service links
    - ## Related

## tools/video-generation.md
- Route: /tools/video-generation
- Headings:
    - ## Quick start
    - ## How async generation works
      - ### Task lifecycle
    - ## Supported providers
      - ### Capability matrix
    - ## Tool parameters
      - ### Required
      - ### Content inputs
      - ### Style controls
      - ### Advanced
        - #### Fallback and typed options
    - ## Actions
    - ## Model selection
    - ## Provider notes
    - ## Provider capability modes
    - ## Live tests
    - ## Configuration
    - ## Related

## tools/web-fetch.md
- Route: /tools/web-fetch
- Headings:
    - ## Quick start
    - ## Tool parameters
    - ## How it works
    - ## Progress updates
    - ## Config
    - ## Firecrawl fallback
    - ## Trusted env proxy
    - ## Limits and safety
    - ## Tool profiles
    - ## Related

## tools/web.md
- Route: /tools/web
- Headings:
    - ## Quick start
    - ## Choosing a provider
      - ### Provider comparison
    - ## Auto-detection
    - ## Native OpenAI web search
    - ## Native Codex web search
    - ## Network safety
    - ## Setting up web search
    - ## Config
      - ### Storing API keys
    - ## Tool parameters
    - ## xsearch
      - ### xsearch config
      - ### xsearch parameters
      - ### xsearch example
    - ## Examples
    - ## Tool profiles
    - ## Related

## tts.md
- Route: /tts
- Headings:
    - ## Related

## vps.md
- Route: /vps
- Headings:
    - ## Pick a provider
    - ## How cloud setups work
    - ## Harden admin access first
    - ## Shared company agent on a VPS
    - ## Using nodes with a VPS
    - ## Startup tuning for small VMs and ARM hosts
      - ### systemd tuning checklist (optional)
    - ## Related

## web/control-ui.md
- Route: /web/control-ui
- Headings:
    - ## Quick open (local)
    - ## Device pairing (first connection)
    - ## Personal identity (browser-local)
    - ## Runtime config endpoint
    - ## Language support
    - ## Appearance themes
    - ## What it can do (today)
    - ## MCP page
    - ## Activity tab
    - ## Chat behavior
    - ## PWA install and web push
    - ## Hosted embeds
    - ## Chat message width
    - ## Tailnet access (recommended)
    - ## Insecure HTTP
    - ## Content security policy
    - ## Avatar route auth
    - ## Assistant media route auth
    - ## Building the UI
    - ## Blank Control UI page
    - ## Debugging/testing: dev server + remote Gateway
    - ## Related

## web/dashboard.md
- Route: /web/dashboard
- Headings:
    - ## Fast path (recommended)
    - ## Auth basics (local vs remote)
    - ## If you see "unauthorized" / 1008
    - ## Related

## web/index.md
- Route: /web
- Headings:
    - ## Webhooks
    - ## Admin HTTP RPC
    - ## Config (default-on)
    - ## Tailscale access
      - ### Integrated Serve (recommended)
      - ### Tailnet bind + token
      - ### Public internet (Funnel)
    - ## Security notes
    - ## Building the UI

## web/tui.md
- Route: /web/tui
- Headings:
    - ## Quick start
      - ### Gateway mode
      - ### Local mode
    - ## What you see
    - ## Mental model: agents + sessions
    - ## Sending + delivery
    - ## Pickers + overlays
    - ## Keyboard shortcuts
    - ## Slash commands
    - ## Local shell commands
    - ## Repair configs from the local TUI
    - ## Tool output
    - ## Terminal colors
    - ## History + streaming
    - ## Connection details
    - ## Options
    - ## Troubleshooting
    - ## Connection troubleshooting
    - ## Related

## web/webchat.md
- Route: /web/webchat
- Headings:
    - ## What it is
    - ## Quick start
    - ## How it works (behavior)
      - ### Transcript and delivery model
    - ## Control UI agents tools panel
    - ## Remote use
    - ## Configuration reference (WebChat)
    - ## Related
