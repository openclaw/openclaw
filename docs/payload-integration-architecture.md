# OpenClaw + Payload CMS Integration Architecture

## Executive Summary

This document outlines the architecture for integrating Payload CMS with OpenClaw to create a user-friendly web application for managing multiple clawbots simultaneously.

## Design Goals

1. **Multi-Bot Management**: Deploy and manage multiple OpenClaw bots from a single web interface
2. **User-Friendly GUI**: Non-technical users can configure bots through forms and wizards
3. **Error-Proof**: Comprehensive validation, helpful error messages, and guided setup
4. **Real-Time Monitoring**: Live status dashboard for all bots and channels
5. **Scalable Architecture**: Support for enterprise deployments with multiple bots and users

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   Payload CMS Layer                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   Admin UI   │  │  REST API    │  │  Collections │  │
│  │  (React)     │  │  (Auto-gen)  │  │  (Database)  │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└────────────────────┬────────────────────────────────────┘
                     │
          ┌──────────▼─────────────┐
          │  OpenClaw Adapter      │
          │  (Plugin Layer)        │
          └──────────┬─────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│              OpenClaw Gateway Layer                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Bot 1       │  │  Bot 2       │  │  Bot N       │  │
│  │  Gateway     │  │  Gateway     │  │  Gateway     │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
┌───────▼────────┐    ┌──────────▼─────────┐
│  Telegram      │    │   Discord          │
│  WhatsApp      │    │   Slack            │
│  Signal        │    │   ...              │
└────────────────┘    └────────────────────┘
```

## Core Components

### 1. Payload CMS Foundation

**Technology Stack:**
- **Framework**: Next.js 14+ (App Router)
- **Database**: PostgreSQL (primary) / MongoDB (optional)
- **Language**: TypeScript with strict mode
- **UI**: Payload Admin Panel + Custom React Server Components

**Collections Schema:**

#### `bots` Collection
```typescript
{
  name: string              // Display name (e.g., "Customer Support Bot")
  agentId: string          // Unique identifier (slug)
  status: 'active' | 'inactive' | 'error'
  model: string            // Claude model (sonnet-4-5, opus-4-5, etc.)
  systemPrompt: text       // Bot personality/instructions
  avatar: upload           // Bot profile image
  gateway: {
    port: number           // Gateway port
    bind: 'loopback' | 'lan' | 'public'
    authToken: string      // Gateway auth token (encrypted)
  }
  channels: relationship[] // Reference to botChannels
  bindings: relationship[] // Reference to botBindings
  sessions: {
    scope: 'per-sender' | 'global'
    resetMode: 'daily' | 'idle'
  }
  tools: {
    bash: boolean
    browser: boolean
    media: boolean
    customSkills: json
  }
  createdBy: relationship  // User who created bot
  createdAt: date
  updatedAt: date
}
```

#### `botChannels` Collection
```typescript
{
  bot: relationship        // Reference to bots
  channel: 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'signal'
  accountId: string        // Channel account identifier
  credentials: json        // Encrypted channel credentials
  config: {
    dmPolicy: 'all' | 'allowlist' | 'none'
    groupPolicy: 'all' | 'allowlist' | 'none'
    allowlist: string[]    // Peer IDs
    autoReply: boolean
    mentionPolicy: string
  }
  status: 'connected' | 'disconnected' | 'error'
  lastSeen: date
  errorMessage: text
}
```

#### `botBindings` Collection
```typescript
{
  bot: relationship        // Reference to bots
  channel: string
  accountId: string
  peer: {
    kind: 'dm' | 'group' | 'channel'
    id: string
  }
  guildId?: string         // Discord-specific
  teamId?: string          // MS Teams-specific
  priority: number         // Routing priority
}
```

#### `sessions` Collection
```typescript
{
  bot: relationship
  sessionKey: string
  channel: string
  peer: string
  lastMessage: date
  messageCount: number
  deliveryContext: json
  transcript: text         // Last N messages
  metadata: json
}
```

#### `users` Collection (Payload built-in, extended)
```typescript
{
  email: string
  password: string         // Hashed
  role: 'admin' | 'operator' | 'viewer'
  assignedBots: relationship[] // Bots this user can manage
  preferences: json
}
```

### 2. OpenClaw Adapter Plugin

**Location**: `/extensions/payload-adapter/`

**Responsibilities:**
1. **Config Sync**: Bidirectional sync between Payload DB ↔ OpenClaw JSON5
2. **Gateway Management**: Start/stop/restart bot gateways
3. **Process Orchestration**: Manage multiple gateway processes
4. **Status Monitoring**: Poll gateway health and channel status
5. **WebSocket Bridge**: Forward gateway events to Payload admin UI

**Key Files:**
```
extensions/payload-adapter/
├── src/
│   ├── plugin.ts               # Main plugin entry point
│   ├── collections/            # Payload collection definitions
│   │   ├── Bots.ts
│   │   ├── BotChannels.ts
│   │   ├── BotBindings.ts
│   │   └── Sessions.ts
│   ├── components/             # Custom admin UI components
│   │   ├── BotDashboard.tsx
│   │   ├── ChannelSetupWizard.tsx
│   │   ├── BotConfigForm.tsx
│   │   └── StatusMonitor.tsx
│   ├── hooks/                  # Payload lifecycle hooks
│   │   ├── syncToGateway.ts    # After bot update
│   │   ├── validateConfig.ts   # Before bot save
│   │   └── cleanupSessions.ts
│   ├── gateway/                # Gateway management
│   │   ├── orchestrator.ts     # Multi-gateway process manager
│   │   ├── config-sync.ts      # DB ↔ JSON5 sync
│   │   ├── health-monitor.ts   # Status polling
│   │   └── websocket-bridge.ts # Real-time events
│   ├── endpoints/              # Custom API endpoints
│   │   ├── start-bot.ts
│   │   ├── stop-bot.ts
│   │   ├── test-channel.ts
│   │   └── export-config.ts
│   └── utils/
│       ├── encryption.ts       # Credential encryption
│       ├── validation.ts       # Config validation
│       └── types.ts
├── package.json
└── README.md
```

### 3. Multi-Gateway Orchestration

**Challenge**: OpenClaw currently runs one gateway per config file.
**Solution**: Process manager to run multiple isolated gateways.

**Orchestrator Design:**

```typescript
class GatewayOrchestrator {
  private processes: Map<string, ChildProcess> = new Map()

  async startBot(botId: string) {
    // 1. Generate bot-specific config.json5 from Payload DB
    const config = await this.generateBotConfig(botId)
    const configPath = `/var/openclaw/bots/${botId}/config.json5`
    await fs.writeFile(configPath, config)

    // 2. Start gateway with isolated config
    const process = spawn('openclaw', [
      'gateway', 'run',
      '--config', configPath,
      '--port', await this.allocatePort(botId),
      '--bind', 'loopback'
    ])

    // 3. Track process and health
    this.processes.set(botId, process)
    this.monitorHealth(botId, process)
  }

  async stopBot(botId: string) {
    const process = this.processes.get(botId)
    if (process) {
      process.kill('SIGTERM')
      this.processes.delete(botId)
    }
  }

  async restartBot(botId: string) {
    await this.stopBot(botId)
    await this.startBot(botId)
  }
}
```

**Port Allocation Strategy:**
- Base port: 18789
- Bot 1: 18789, Bot 2: 18790, Bot 3: 18791, etc.
- Store port mapping in Payload DB

**Process Isolation:**
- Each bot gets its own:
  - Config file: `/var/openclaw/bots/{botId}/config.json5`
  - Sessions: `/var/openclaw/bots/{botId}/sessions.json`
  - Credentials: `/var/openclaw/bots/{botId}/credentials/`
  - Logs: `/var/openclaw/bots/{botId}/logs/`

### 4. User Interface Components

#### A. Bot Setup Wizard (Multi-Step Form)

**Step 1: Bot Basics**
- Bot name (required, unique)
- Agent ID (auto-generated slug)
- System prompt (textarea with examples)
- Model selection (dropdown with descriptions)
- Avatar upload

**Step 2: Channel Configuration**
- Channel type selector (cards with icons)
- Per-channel setup wizard:
  - Telegram: Bot token
  - Discord: Bot token + application ID
  - WhatsApp: QR code pairing
  - Slack: OAuth flow
- Test connection button (real-time validation)

**Step 3: Access Control**
- DM policy (radio: All / Allowlist / None)
- Group policy (radio: All / Allowlist / None)
- Allowlist editor (chip input with validation)
- Mention policy settings

**Step 4: Advanced Settings**
- Session scope (dropdown with explanations)
- Session reset mode
- Tool permissions (checkboxes with warnings)
- Gateway settings (collapsible advanced section)

**Step 5: Review & Launch**
- Summary of all settings
- Validation status indicators
- "Create Bot" or "Save Draft" buttons

#### B. Bot Dashboard (Main View)

**Layout:**
```
┌─────────────────────────────────────────────────┐
│  OpenClaw Management Dashboard                  │
├─────────────────────────────────────────────────┤
│  [+ New Bot]  [Import Config]  [Settings]       │
├─────────────────────────────────────────────────┤
│                                                  │
│  ┌──────────────┐  ┌──────────────┐             │
│  │   Bot Card   │  │   Bot Card   │  ...        │
│  │              │  │              │             │
│  │  🟢 Active   │  │  🔴 Error    │             │
│  │  3 channels  │  │  2 channels  │             │
│  │  45 sessions │  │  0 sessions  │             │
│  │              │  │              │             │
│  │  [Start/Stop]│  │  [Restart]   │             │
│  │  [Configure] │  │  [Configure] │             │
│  │  [View Logs] │  │  [View Logs] │             │
│  └──────────────┘  └──────────────┘             │
│                                                  │
└─────────────────────────────────────────────────┘
```

**Bot Card Features:**
- Real-time status indicator (green/yellow/red)
- Channel status icons
- Active session count
- Last activity timestamp
- Quick actions (start, stop, restart, configure, logs)
- Click to expand detailed view

#### C. Bot Detail View

**Tabs:**
1. **Overview**: Status, uptime, message counts, charts
2. **Channels**: List of connected channels with status
3. **Sessions**: Active conversations with preview
4. **Configuration**: Edit bot settings (form)
5. **Logs**: Real-time log viewer with filtering
6. **Analytics**: Message volume, response times, errors

#### D. Channel Setup UI

**Per-Channel Components:**

**Telegram Setup:**
```tsx
<TelegramChannelSetup>
  <TextField
    name="botToken"
    label="Bot Token"
    hint="Get from @BotFather"
    validation={validateTelegramToken}
    secure
  />
  <Button onClick={testConnection}>Test Connection</Button>
</TelegramChannelSetup>
```

**WhatsApp Setup:**
```tsx
<WhatsAppChannelSetup>
  <QRCodeDisplay
    onScan={() => pollLoginStatus()}
    refreshInterval={5000}
  />
  <StatusMessage>Scan QR code with WhatsApp app</StatusMessage>
  <Timer>Code expires in 2:45</Timer>
</WhatsAppChannelSetup>
```

**Discord Setup:**
```tsx
<DiscordChannelSetup>
  <TextField name="token" label="Bot Token" secure />
  <TextField name="applicationId" label="Application ID" />
  <GuildSelector
    onConnect={loadGuilds}
    guilds={connectedGuilds}
  />
  <InviteLinkGenerator botId={bot.id} />
</DiscordChannelSetup>
```

### 5. Validation & Error Prevention

**Validation Layers:**

1. **Client-Side (React Forms)**
   - Required field checks
   - Format validation (URLs, tokens, IDs)
   - Real-time feedback
   - Helpful error messages

2. **Payload Collection Hooks**
   - `beforeValidate`: Sanitize inputs
   - `validate`: Business logic validation
   - `beforeChange`: Check for conflicts (e.g., port in use)

3. **OpenClaw Adapter**
   - Gateway config validation (reuse existing Zod schemas)
   - Channel credential testing
   - Port availability checks

4. **Gateway-Level**
   - Existing OpenClaw validation
   - Channel connection tests

**Error Handling Strategy:**

```typescript
// Example: Friendly error messages
const errorMessages = {
  'EADDRINUSE': 'Port {port} is already in use. Try a different port or stop the conflicting bot.',
  'TELEGRAM_AUTH_FAILED': 'Invalid Telegram bot token. Get a valid token from @BotFather.',
  'WHATSAPP_QR_TIMEOUT': 'QR code scan timed out. Click "Generate New Code" to try again.',
  'CONFIG_VALIDATION_ERROR': 'Configuration error: {details}. Please check your settings.',
}
```

**Validation UI Components:**

```tsx
<ValidationStatus>
  {validating && <Spinner />}
  {valid && <SuccessIcon /> "Configuration valid"}
  {error && (
    <>
      <ErrorIcon />
      <ErrorMessage>{friendlyErrorMessage(error)}</ErrorMessage>
      <HelpLink>View troubleshooting guide</HelpLink>
    </>
  )}
</ValidationStatus>
```

### 6. Real-Time Monitoring

**WebSocket Integration:**

```typescript
// In Payload admin UI
const useGatewayStatus = (botId: string) => {
  const [status, setStatus] = useState<GatewayStatus>()

  useEffect(() => {
    const ws = new WebSocket(`ws://localhost:18789`)
    ws.send(JSON.stringify({
      method: 'subscribe',
      params: { botId, events: ['status', 'message', 'error'] }
    }))

    ws.onmessage = (event) => {
      const frame = JSON.parse(event.data)
      if (frame.type === 'event') {
        setStatus(frame.payload)
      }
    }

    return () => ws.close()
  }, [botId])

  return status
}
```

**Status Dashboard Features:**
- Live connection status per channel
- Message throughput graph (messages/min)
- Error rate alerts
- Active session count
- Memory and CPU usage (per gateway process)

### 7. Deployment Architecture

**Production Deployment Options:**

#### Option A: All-in-One (Small Scale)
```
┌─────────────────────────────────────┐
│         Single Server               │
│                                     │
│  ┌─────────────────────────────┐   │
│  │  Payload CMS (Next.js)      │   │
│  │  - Admin UI                 │   │
│  │  - REST API                 │   │
│  │  - PostgreSQL               │   │
│  └─────────────────────────────┘   │
│                                     │
│  ┌─────────────────────────────┐   │
│  │  OpenClaw Orchestrator      │   │
│  │  - Gateway Manager          │   │
│  └─────────────────────────────┘   │
│                                     │
│  ┌───┐ ┌───┐ ┌───┐               │
│  │GW1│ │GW2│ │GW3│ ...            │
│  └───┘ └───┘ └───┘               │
└─────────────────────────────────────┘
```

#### Option B: Distributed (Enterprise Scale)
```
┌────────────────┐
│   Load         │
│   Balancer     │
└───────┬────────┘
        │
   ┌────┴─────┐
   │          │
┌──▼──┐   ┌──▼──┐
│Web  │   │Web  │  (Payload Next.js)
│Node1│   │Node2│
└──┬──┘   └──┬──┘
   │          │
   └────┬─────┘
        │
   ┌────▼────────┐
   │ PostgreSQL  │
   │  (Primary)  │
   └─────────────┘

┌─────────────────────────────────┐
│  Gateway Cluster                │
│                                 │
│  ┌───┐ ┌───┐ ┌───┐ ┌───┐      │
│  │GW1│ │GW2│ │GW3│ │GW4│ ...   │
│  └───┘ └───┘ └───┘ └───┘      │
└─────────────────────────────────┘
```

**Environment Variables:**
```bash
# Payload CMS
DATABASE_URL=postgresql://...
PAYLOAD_SECRET=...
NEXT_PUBLIC_SERVER_URL=https://admin.example.com

# OpenClaw
OPENCLAW_BASE_PATH=/var/openclaw
OPENCLAW_BASE_PORT=18789
OPENCLAW_MAX_BOTS=50

# Credentials encryption
ENCRYPTION_KEY=...
```

### 8. Migration Strategy

**Phase 1: Parallel Operation**
- Payload CMS deployed alongside existing OpenClaw setups
- Manual import of existing configs
- Users can choose between file-based or Payload management

**Phase 2: Gradual Migration**
- Migration tool: `openclaw migrate-to-payload`
- Reads existing `config.json5` → creates Payload records
- Preserves all settings, channels, bindings
- Validates migrated config

**Phase 3: Full Integration**
- Payload becomes primary config source
- File-based config deprecated (but still supported)
- Documentation updated

### 9. Security Considerations

**Authentication:**
- Payload built-in auth (JWT + HTTP-only cookies)
- Role-based access control (admin, operator, viewer)
- Per-bot access control (users assigned to specific bots)

**Credential Storage:**
- Encrypt channel credentials at rest
- Use Node.js `crypto` module with AES-256-GCM
- Store encryption key in environment variable (never in DB)
- Rotate encryption keys periodically

**Gateway Security:**
- Each bot gateway uses unique auth token
- Gateways bind to loopback by default
- Payload adapter uses local RPC (no network exposure)
- Optional: mTLS for distributed deployments

**API Security:**
- Rate limiting on Payload API endpoints
- CSRF protection (enabled by default)
- Input sanitization and validation
- Audit logging for all config changes

## Implementation Roadmap

### Milestone 1: Foundation (Week 1-2)
- [ ] Set up Payload project structure
- [ ] Define Payload collections (Bots, BotChannels, BotBindings)
- [ ] Create basic admin UI (CRUD for bots)
- [ ] Implement encryption utilities

### Milestone 2: Gateway Integration (Week 3-4)
- [ ] Build gateway orchestrator (start/stop/restart)
- [ ] Implement config sync (Payload DB → OpenClaw JSON5)
- [ ] Port allocation and process management
- [ ] Health monitoring and status polling

### Milestone 3: User Experience (Week 5-6)
- [ ] Bot setup wizard (multi-step form)
- [ ] Channel configuration UIs (per-channel components)
- [ ] Validation and error handling
- [ ] Real-time status dashboard

### Milestone 4: Advanced Features (Week 7-8)
- [ ] Session viewer and management
- [ ] Log viewer with filtering
- [ ] Analytics dashboard
- [ ] Import/export configuration

### Milestone 5: Testing & Polish (Week 9-10)
- [ ] Comprehensive testing (unit, integration, e2e)
- [ ] Error handling and edge cases
- [ ] Performance optimization
- [ ] Documentation and user guides

### Milestone 6: Deployment (Week 11-12)
- [ ] Deployment guides (Docker, Vercel, VPS)
- [ ] Migration tool from file-based config
- [ ] Production hardening (security, monitoring)
- [ ] Beta release and user feedback

## Success Metrics

1. **Usability**: Non-technical user can set up a bot in < 5 minutes
2. **Reliability**: 99.9% uptime for gateway orchestrator
3. **Scalability**: Support 50+ concurrent bots on single server
4. **Performance**: Bot startup time < 10 seconds
5. **Adoption**: 80% of users prefer Payload UI over file editing

## Open Questions

1. **Session Storage**: Keep file-based or migrate to Payload DB?
   - **Recommendation**: Hybrid approach (hot sessions in memory, archive in Payload)

2. **Real-Time Updates**: WebSocket vs. Server-Sent Events vs. Polling?
   - **Recommendation**: WebSocket for status, SSE for logs, polling as fallback

3. **Multi-Tenancy**: Single Payload instance for multiple orgs?
   - **Recommendation**: Yes, use Payload's tenant field + row-level security

4. **Backward Compatibility**: Support file-based config indefinitely?
   - **Recommendation**: Yes, maintain dual-mode operation

## Conclusion

This architecture provides a robust foundation for transforming OpenClaw into a user-friendly, multi-bot management platform while preserving its powerful CLI and file-based workflows. The Payload integration adds a professional admin UI, multi-user support, and enterprise-grade features without compromising OpenClaw's flexibility and extensibility.
