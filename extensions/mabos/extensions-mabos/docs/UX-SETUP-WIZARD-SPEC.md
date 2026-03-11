# UX Setup Wizard Specification

**Version:** 1.0  
**Date:** 2026-02-17  
**Purpose:** Remove technical complexity from OpenClaw setup through guided, self-healing wizard flow

---

## 1. Problem Statement

### Current State: Technical Barriers

OpenClaw onboarding currently requires extensive technical knowledge and manual configuration:

- **Token Management:** Users must manually generate, store, and configure API tokens for each channel (Telegram bot tokens, Discord app secrets, etc.)
- **System Administration:** Requires systemd commands, service unit management, and daemon lifecycle understanding
- **Configuration Editing:** Direct YAML/JSON editing of gateway configuration files
- **Channel Wiring:** Manual channel setup with complex authentication flows
- **Version Management:** No automated detection or resolution of version mismatches
- **Service Health:** No visibility into service status or automatic remediation

### Business Impact

- High abandonment rate during onboarding
- Support burden from configuration issues
- Lost potential users due to technical complexity
- Time-to-value delays for business users
- Recurring issues with service degradation

---

## 2. Design Principles

### Zero-Config Defaults

- **Sensible Defaults:** Every step should have intelligent defaults that work for 80% of users
- **Optional Configuration:** Advanced options are available but not required for basic functionality
- **Auto-Generation:** System generates what can be generated (IDs, tokens, configurations)

### Progressive Disclosure

- **Layered Complexity:** Start simple, reveal complexity only when needed
- **Context-Aware:** Show relevant options based on user selections and current state
- **Help When Needed:** Contextual help and explanations without overwhelming the UI

### Self-Healing Infrastructure

- **Health Monitoring:** Continuous background checks of system state
- **Auto-Remediation:** Fix common issues automatically without user intervention
- **Graceful Degradation:** When auto-fix isn't possible, provide clear guidance

### Business-User Friendly

- **Domain Language:** Use business terms instead of technical jargon
- **Role-Based Flow:** Tailor experience to user role (CEO, marketer, developer)
- **Visual Feedback:** Clear progress indicators and status visualization
- **Confidence Building:** Success indicators and verification steps

---

## 3. Setup Wizard Flow

### Pre-Flight State Detection

Before starting the wizard, detect current system state:

- Gateway service status
- Existing business configurations
- Channel connections
- Plugin status
- Version compatibility

### Step 1: Welcome & Identity

**Purpose:** Establish user context and personalize the experience

**UI Elements:**

- Welcome message with value proposition
- User information form:
  - Full Name (required)
  - Role/Position (dropdown: CEO, Founder, CTO, Marketing Director, Operations Manager, Other)
  - Company Name (optional, for context)
  - Timezone (auto-detected, confirmable)
- Experience Level (Beginner, Intermediate, Advanced) — affects verbosity of explanations

**Outputs:**

- User profile stored for personalization
- Timezone configuration for scheduling
- Experience level for UI adaptation

### Step 2: Channel Setup

**Purpose:** Connect communication channels with guided authentication

**Flow:**

1. **Channel Selection**
   - Present channel options with business use cases:
     - Telegram: "Customer support, team communication"
     - Discord: "Community building, team collaboration"
     - Slack: "Internal team communication"
     - WhatsApp: "Direct customer messaging"
     - Signal: "Secure communication"
   - Allow multiple selection
   - Show "Skip for now" option

2. **Per-Channel Guided Auth**
   For each selected channel:
   - **Telegram:**
     - Show step-by-step bot creation guide with screenshots
     - BotFather interaction walkthrough
     - Token input with validation
     - Test message sending
   - **Discord:**
     - App creation guide
     - Bot token and permissions setup
     - Server invitation flow
     - Test connection
   - **Others:** Similar guided flows

3. **Verification**
   - Send test messages to each configured channel
   - Show real-time status (green checkmarks, red X's)
   - Retry mechanisms for failures

**UI Mockup (Text Description):**

```
┌─ Channel Setup ─────────────────────────────┐
│ Select channels to connect:                  │
│                                             │
│ ☐ Telegram    Customer support & alerts     │
│ ☐ Discord     Community & team chat        │
│ ☐ Slack       Internal communications      │
│ ☐ WhatsApp    Direct customer messaging    │
│ ☐ Signal      Secure communications        │
│                                             │
│ [Continue] [Skip for now]                   │
└─────────────────────────────────────────────┘
```

### Step 3: Business Registration

**Purpose:** Create business entity and initialize MABOS agents

**Integration with Existing `onboard_business` Tool:**

- Reuse existing business onboarding logic
- Present form fields in user-friendly way:
  - Business Name (required)
  - Legal Name (auto-filled from Business Name, editable)
  - Business Type (dropdown with descriptions)
  - Description (text area with character count)
  - Value Propositions (dynamic list, add/remove)
  - Customer Segments (dynamic list)
  - Revenue Streams (dynamic list)

**Business Type Descriptions:**

- E-commerce: "Sell products online"
- SaaS: "Software as a Service"
- Consulting: "Professional services"
- Marketplace: "Connect buyers and sellers"
- Retail: "Physical or online store"

**UI Mockup (Text Description):**

```
┌─ Business Setup ────────────────────────────┐
│ What kind of business are you running?       │
│                                             │
│ Business Name: [___________________]         │
│ Type: [E-commerce ▼]                        │
│                                             │
│ Description:                                │
│ [________________________________]         │
│ [________________________________] 250/500 │
│                                             │
│ Value Propositions:                         │
│ • [____________________] [×]                │
│ • [____________________] [×]                │
│ [+ Add another]                             │
│                                             │
│ [Back] [Continue]                           │
└─────────────────────────────────────────────┘
```

### Step 4: Security & Auth

**Purpose:** Configure authentication without exposing raw tokens

**Approach:**

- Auto-generate API keys and tokens where possible
- Store securely in encrypted configuration
- Show user-friendly confirmations instead of raw values
- Provide "regenerate" and "test" options

**Elements:**

- Gateway authentication setup
- Inter-agent communication security
- Channel token storage confirmation
- Admin access configuration

**UI Mockup (Text Description):**

```
┌─ Security Configuration ────────────────────┐
│ ✅ Gateway authentication configured         │
│ ✅ Channel tokens stored securely           │
│ ✅ Agent communication encrypted            │
│                                             │
│ Admin Access:                               │
│ 🔐 Access Key: ●●●●●●●●-●●●●-●●●●           │
│     [Regenerate] [Copy to Clipboard]        │
│                                             │
│ ⚠️  Save this key! You'll need it to        │
│     access admin features later.            │
│                                             │
│ [Back] [Continue]                           │
└─────────────────────────────────────────────┘
```

### Step 5: Health Check & Verification

**Purpose:** Verify all systems are working and provide final confidence

**Checks:**

- Gateway service running
- Channel connectivity
- Agent spawning successful
- Business entities created
- Configuration files valid
- Version compatibility

**UI Mockup (Text Description):**

```
┌─ System Verification ───────────────────────┐
│ Checking your setup...                      │
│                                             │
│ ✅ Gateway service      Running             │
│ ✅ Telegram bot         Connected           │
│ ✅ Discord bot          Connected           │
│ ✅ Business agents      9 agents spawned    │
│ ✅ Configuration        Valid               │
│ ⚠️  Service version     Update recommended  │
│                                             │
│ [Fix Issues] [Continue Anyway] [Finish]     │
└─────────────────────────────────────────────┘
```

---

## 4. Managed Infrastructure

### Auto Gateway Lifecycle

- **Service Management:** Start/stop/restart gateway without systemd commands
- **Process Monitoring:** Detect when gateway process dies and auto-restart
- **Port Management:** Handle port conflicts and automatic port assignment
- **Log Rotation:** Manage log files and prevent disk space issues

### Version Mismatch Detection & Fix

- **Compatibility Matrix:** Define compatible versions of components
- **Auto-Update:** Update plugins and extensions automatically when safe
- **Migration Scripts:** Run database/config migrations between versions
- **Rollback Capability:** Revert to previous working configuration if needed

### Token Rotation

- **Scheduled Rotation:** Automatically rotate API tokens on schedule
- **Expiry Detection:** Detect expired tokens and renew proactively
- **Backup Tokens:** Maintain backup tokens during rotation to prevent downtime
- **Notification:** Alert users of token changes that might affect external integrations

### Service Unit Regeneration

- **Template Updates:** Regenerate systemd units when configuration changes
- **Permission Fixes:** Correct file permissions automatically
- **Environment Variables:** Update environment configuration
- **Dependency Management:** Ensure proper service dependencies

---

## 5. Canvas UI Mockups

### Setup Wizard Screens

#### Welcome Screen

```html
<!-- Dark theme, modern styling -->
<div class="wizard-container">
  <header class="wizard-header">
    <h1>Welcome to OpenClaw</h1>
    <p>Let's get your AI agents up and running in minutes</p>
    <div class="progress-bar">
      <div class="step active">1</div>
      <div class="step">2</div>
      <div class="step">3</div>
      <div class="step">4</div>
      <div class="step">5</div>
    </div>
  </header>

  <main class="wizard-content">
    <!-- User form here -->
  </main>

  <footer class="wizard-footer">
    <button class="btn-secondary">Skip Setup</button>
    <button class="btn-primary">Get Started</button>
  </footer>
</div>
```

#### Status Dashboard

```html
<!-- Real-time system status -->
<div class="dashboard">
  <header class="dashboard-header">
    <h2>System Status</h2>
    <span class="status-badge healthy">All Systems Healthy</span>
  </header>

  <div class="status-grid">
    <div class="status-card">
      <h3>Gateway</h3>
      <span class="status online">Online</span>
      <div class="details">v2.1.0 • Uptime: 3d 12h</div>
    </div>

    <div class="status-card">
      <h3>Channels</h3>
      <span class="status connected">3 Connected</span>
      <div class="channel-list">
        <span class="channel telegram">Telegram</span>
        <span class="channel discord">Discord</span>
        <span class="channel slack">Slack</span>
      </div>
    </div>

    <div class="status-card">
      <h3>Agents</h3>
      <span class="status active">12 Active</span>
      <div class="details">3 businesses • 9 core + 3 domain</div>
    </div>
  </div>
</div>
```

### Channel Management Panel

```html
<!-- Channel configuration and management -->
<div class="channel-manager">
  <header>
    <h2>Channel Management</h2>
    <button class="btn-primary">Add Channel</button>
  </header>

  <div class="channel-list">
    <div class="channel-item">
      <div class="channel-info">
        <img src="telegram-icon.svg" class="channel-icon" />
        <div class="channel-details">
          <h3>Customer Support Bot</h3>
          <p>@mycompany_support_bot</p>
        </div>
      </div>
      <div class="channel-status">
        <span class="status-dot online"></span>
        <span>Connected</span>
      </div>
      <div class="channel-actions">
        <button class="btn-icon">⚙️</button>
        <button class="btn-icon">📊</button>
        <button class="btn-icon">🔧</button>
      </div>
    </div>
  </div>
</div>
```

---

## 6. Self-Healing Features

### Auto-Fixed Issues

**System automatically resolves:**

- Gateway service crashes (auto-restart)
- Configuration file corruption (restore from backup)
- Channel token expiry (automatic renewal where possible)
- Service unit outdated (regenerate and reload)
- Port conflicts (find and assign alternative ports)
- Plugin version mismatches (update to compatible versions)
- Log file size issues (rotate and compress)
- File permission problems (fix ownership and permissions)

### User-Surfaced Issues

**Requires user intervention:**

- Manual token renewal (when auto-renewal not supported)
- Major version incompatibilities (breaking changes)
- Channel authentication revocation (user must re-authorize)
- Business logic conflicts (agent goal contradictions)
- External service outages (third-party dependencies)
- Security policy violations (require manual review)

### Health Check Categories

1. **Critical:** System cannot function (red alert, immediate action required)
2. **Warning:** Degraded functionality (yellow alert, action recommended)
3. **Info:** Optimization opportunity (blue badge, action optional)

---

## 7. API Design

### Tool Specifications

#### `setup_wizard_start`

**Purpose:** Initialize setup wizard and assess current state

**Parameters:**

```typescript
{
  force_reset?: boolean,  // Reset existing configuration
  skip_checks?: string[]  // Skip specific health checks
}
```

**Returns:**

```typescript
{
  current_state: {
    gateway_running: boolean,
    channels_configured: string[],
    businesses_count: number,
    agents_count: number,
    issues: Issue[]
  },
  next_steps: string[],
  estimated_time_minutes: number
}
```

#### `setup_channel`

**Purpose:** Configure and test channel connection

**Parameters:**

```typescript
{
  channel_type: 'telegram' | 'discord' | 'signal' | 'slack' | 'whatsapp',
  credentials: {
    // Channel-specific fields
    telegram?: { bot_token: string },
    discord?: { bot_token: string, application_id: string },
    // ... other channel types
  },
  test_connection: boolean = true
}
```

**Returns:**

```typescript
{
  success: boolean,
  channel_id: string,
  test_results?: {
    connection_ok: boolean,
    test_message_sent: boolean,
    error?: string
  },
  next_steps: string[]
}
```

#### `setup_health_check`

**Purpose:** Comprehensive system health assessment

**Parameters:**

```typescript
{
  include_channels?: boolean,
  include_agents?: boolean,
  include_version_check?: boolean,
  fix_automatically?: boolean
}
```

**Returns:**

```typescript
{
  overall_health: 'healthy' | 'warning' | 'critical',
  checks: {
    gateway: HealthStatus,
    channels: ChannelHealth[],
    agents: AgentHealth[],
    versions: VersionHealth,
    configuration: ConfigHealth
  },
  auto_fixable_issues: string[],
  manual_issues: string[]
}
```

#### `setup_auto_fix`

**Purpose:** Automatically remediate known issues

**Parameters:**

```typescript
{
  issue_type: 'service_unit_stale' | 'token_mismatch' | 'config_drift' | 'permission_error',
  dry_run?: boolean,
  force?: boolean
}
```

**Returns:**

```typescript
{
  actions_taken: string[],
  success: boolean,
  remaining_issues: string[],
  requires_restart: boolean,
  user_action_needed?: string[]
}
```

#### `setup_status_dashboard`

**Purpose:** Generate HTML dashboard for Canvas display

**Parameters:**

```typescript
{
  theme?: 'dark' | 'light',
  refresh_interval?: number,
  show_details?: boolean
}
```

**Returns:**

```typescript
{
  html: string,
  css: string,
  refresh_needed: boolean,
  last_updated: string
}
```

### Error Handling Strategy

- **Graceful Degradation:** Partial success states when some operations fail
- **Retry Logic:** Automatic retries for transient failures
- **User Feedback:** Clear error messages with suggested remediation
- **Rollback Support:** Ability to undo configuration changes

### Integration Points

- **Existing Tools:** Leverage `onboard_business`, channel tools, agent management
- **System Services:** Interface with systemd, file system, process management
- **External APIs:** Channel provider APIs for validation and testing
- **Configuration Management:** Read/write gateway and plugin configurations

---

This specification provides a comprehensive foundation for building a user-friendly setup wizard that removes technical barriers while maintaining the power and flexibility of OpenClaw's multi-agent architecture.
