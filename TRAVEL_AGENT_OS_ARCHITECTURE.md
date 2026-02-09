# Travel Agent OS - High-Level Architecture

## Based on OpenClaw/ClawDBot Architecture

This document provides a high-level architectural diagram and replication guide for building a Travel Agent OS based on the OpenClaw architecture.

---

## 🏗️ Core Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         TRAVEL AGENT OS ARCHITECTURE                    │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                          EXTERNAL INTERFACES                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │   WhatsApp   │  │   Telegram   │  │    Email     │  │   WebChat   │ │
│  │   (Baileys)  │  │   (grammY)   │  │   (IMAP/SMTP)│  │   (React)   │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘ │
│         │                  │                  │                  │         │
│  ┌──────┴──────────────────┴──────────────────┴──────────────────┴───────┐ │
│  │                    TRAVEL-SPECIFIC CHANNELS                          │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │ │
│  │  │   Booking    │  │   Customer    │  │   Supplier   │              │ │
│  │  │   Platforms  │  │   Portal      │  │   APIs        │              │ │
│  │  │  (Amadeus,   │  │  (Custom CRM) │  │  (GDS, etc.)  │              │ │
│  │  │   Sabre,     │  │               │  │               │              │ │
│  │  │   Travelport)│  │               │  │               │              │ │
│  │  └──────────────┘  └───────────────┘  └───────────────┘              │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         GATEWAY (Control Plane)                            │
│                    WebSocket Server (ws://127.0.0.1:18789)                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                    GATEWAY CORE                                       │ │
│  │  • WebSocket Protocol Handler                                         │ │
│  │  • Request/Response Router                                            │ │
│  │  • Event Emitter (agent, chat, presence, health, cron)                │ │
│  │  • Connection Manager (clients, nodes, operators)                     │ │
│  │  • Authentication & Pairing                                           │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                    CHANNEL MANAGER                                   │ │
│  │  • Channel Registry (WhatsApp, Telegram, Email, Booking APIs)       │ │
│  │  • Message Router (inbound → agent, outbound → channels)             │ │
│  │  • Allowlist/Pairing (security, DM policies)                       │ │
│  │  • Typing Indicators & Presence                                     │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                    SESSION MANAGER                                   │ │
│  │  • Session Store (~/.travelagent/agents/<agentId>/sessions/)       │ │
│  │  • Session Routing (main, groups, channels, threads)               │ │
│  │  • Session Isolation (per-customer, per-booking)                    │ │
│  │  • Context Management (conversation history)                        │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                    CONFIGURATION MANAGER                              │ │
│  │  • Config Store (~/.travelagent/travelagent.json)                   │ │
│  │  • Schema Validation (TypeBox/Zod)                                  │ │
│  │  • Hot Reload (config.apply, config.patch)                          │ │
│  │  • Multi-Environment Support                                        │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                    CRON SCHEDULER                                    │ │
│  │  • Job Store (~/.travelagent/cron/)                                 │ │
│  │  • Schedule Types (at, every, cron expression)                       │ │
│  │  • Execution Modes (main session, isolated)                         │ │
│  │  • Travel-Specific Jobs:                                            │ │
│  │    - Price monitoring                                               │ │
│  │    - Booking reminders                                               │ │
│  │    - Supplier sync                                                   │ │
│  │    - Customer follow-ups                                             │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                    ROUTING ENGINE                                    │ │
│  │  • Agent Routing (per-customer, per-booking, per-channel)         │ │
│  │  • Multi-Agent Support (specialized agents)                        │ │
│  │  • Broadcast Groups (parallel agent execution)                      │ │
│  │  • Fallback Routing                                                 │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AGENT RUNTIME (Pi Agent)                            │
│                    Embedded AI Agent with Tool Execution                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                    AGENT CORE                                        │ │
│  │  • Model Integration (Claude, GPT, etc.)                             │ │
│  │  • Session Context Assembly                                          │ │
│  │  • Tool Execution Loop                                               │ │
│  │  • Streaming (assistant, tool, lifecycle events)                      │ │
│  │  • Queue Management (steer, followup, collect)                      │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                    TRAVEL-SPECIFIC TOOLS                             │ │
│  │                                                                       │ │
│  │  ┌──────────────────────────────────────────────────────────────┐  │ │
│  │  │  BOOKING TOOLS                                                │  │ │
│  │  │  • search_flights (Amadeus, Sabre, Travelport)               │  │ │
│  │  │  • search_hotels (Booking.com, Expedia, GDS)                 │  │ │
│  │  │  • search_cars (Hertz, Avis, etc.)                           │  │ │
│  │  │  • create_booking (reservation creation)                     │  │ │
│  │  │  • cancel_booking (cancellation handling)                    │  │ │
│  │  │  • modify_booking (changes, upgrades)                         │  │ │
│  │  │  • check_availability (real-time inventory)                  │  │ │
│  │  └──────────────────────────────────────────────────────────────┘  │ │
│  │                                                                       │ │
│  │  ┌──────────────────────────────────────────────────────────────┐  │ │
│  │  │  CRM TOOLS                                                     │  │ │
│  │  │  • get_customer (customer lookup)                            │  │ │
│  │  │  • create_customer (new customer registration)                │  │ │
│  │  │  • update_customer (profile updates)                         │  │ │
│  │  │  • get_booking_history (past bookings)                       │  │ │
│  │  │  • create_lead (lead management)                             │  │ │
│  │  │  • add_note (customer notes)                                  │  │ │
│  │  └──────────────────────────────────────────────────────────────┘  │ │
│  │                                                                       │ │
│  │  ┌──────────────────────────────────────────────────────────────┐  │ │
│  │  │  AUTOMATION TOOLS                                             │  │ │
│  │  │  • cron (scheduled tasks)                                    │  │ │
│  │  │  • webhook (external triggers)                                │  │ │
│  │  │  • email_send (customer communications)                       │  │ │
│  │  │  • sms_send (SMS notifications)                               │  │ │
│  │  └──────────────────────────────────────────────────────────────┘  │ │
│  │                                                                       │ │
│  │  ┌──────────────────────────────────────────────────────────────┐  │ │
│  │  │  SYSTEM TOOLS                                                 │  │ │
│  │  │  • read (file access)                                        │  │ │
│  │  │  • write (file creation)                                     │  │ │
│  │  │  • exec (command execution)                                  │  │ │
│  │  │  • browser (web automation)                                  │  │ │
│  │  │  • sessions_list/send (multi-agent coordination)            │  │ │
│  │  └──────────────────────────────────────────────────────────────┘  │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                    SKILLS SYSTEM                                     │ │
│  │  • Bundled Skills (~/.travelagent/skills/)                         │ │
│  │  • Workspace Skills (<workspace>/skills/)                           │ │
│  │  • Travel Skills:                                                  │ │
│  │    - Flight booking workflows                                      │ │
│  │    - Hotel recommendations                                         │ │
│  │    - Visa processing                                               │ │
│  │    - Travel insurance                                              │ │
│  │    - Customer onboarding                                           │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CLIENTS & INTERFACES                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │     CLI      │  │   Web UI     │  │  Mobile App  │  │  Desktop App  │  │
│  │  (Node.js)   │  │  (React/Vue) │  │  (React      │  │  (Electron/   │  │
│  │              │  │              │  │   Native)    │  │   Tauri)      │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                  │                  │                  │         │
│         └──────────────────┴──────────────────┴──────────────────┘         │
│                              │                                               │
│                              ▼                                               │
│                    ┌─────────────────────┐                                  │
│                    │  WebSocket Client   │                                  │
│                    │  (Gateway Protocol) │                                  │
│                    └─────────────────────┘                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DATA PERSISTENCE                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐        │
│  │  Session Store   │  │  Config Store    │  │  Cron Jobs Store  │        │
│  │  (JSONL files)   │  │  (JSON5)         │  │  (JSON files)    │        │
│  │                  │  │                  │  │                  │        │
│  │  ~/.travelagent/ │  │  ~/.travelagent/ │  │  ~/.travelagent/ │        │
│  │  agents/<id>/    │  │  travelagent.json│  │  cron/            │        │
│  │  sessions/       │  │                  │  │                  │        │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘        │
│                                                                              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐        │
│  │  Workspace       │  │  Credentials      │  │  Skills Store     │        │
│  │  (Code/Data)     │  │  (Encrypted)       │  │  (Skills/         │        │
│  │                  │  │                  │  │   Templates)       │        │
│  │  ~/.travelagent/ │  │  ~/.travelagent/  │  │  ~/.travelagent/  │        │
│  │  workspace/     │  │  credentials/     │  │  skills/          │        │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Data Flow

### Inbound Message Flow

```
1. External Channel (WhatsApp/Telegram/Email/Booking API)
   ↓
2. Channel Adapter (converts to internal format)
   ↓
3. Gateway Channel Manager (routing, allowlist check)
   ↓
4. Routing Engine (determines agent + session)
   ↓
5. Session Manager (loads/creates session context)
   ↓
6. Agent Runtime (processes with AI model)
   ↓
7. Tool Execution (booking tools, CRM tools, etc.)
   ↓
8. Response Generation (AI generates reply)
   ↓
9. Gateway Channel Manager (routes back to channel)
   ↓
10. Channel Adapter (formats for external channel)
   ↓
11. External Channel (delivers to customer)
```

### Cron Job Flow

```
1. Cron Scheduler (checks due jobs)
   ↓
2. Job Execution (main session or isolated)
   ↓
3. Agent Runtime (runs with job context)
   ↓
4. Tool Execution (booking checks, price monitoring, etc.)
   ↓
5. Result Delivery (optional: channel delivery or summary)
```

---

## 📋 Key Components Breakdown

### 1. Gateway (Control Plane)

**Purpose**: Central orchestration hub for all operations

**Key Responsibilities**:

- WebSocket server for client connections
- Channel lifecycle management
- Session routing and isolation
- Configuration management
- Cron job scheduling
- Event broadcasting

**Technology Stack**:

- Node.js/TypeScript
- WebSocket (ws library)
- TypeBox for schema validation
- JSON5 for configuration

### 2. Channel Integrations

**Purpose**: Connect to external communication platforms

**Core Channels** (from OpenClaw):

- WhatsApp (Baileys)
- Telegram (grammY)
- Slack (Bolt)
- Discord (discord.js)
- Email (IMAP/SMTP)
- WebChat (custom React UI)

**Travel-Specific Channels** (to add):

- Booking Platform APIs (Amadeus, Sabre, Travelport)
- Customer Portal (custom CRM integration)
- Supplier APIs (hotels, airlines, car rentals)
- Payment Gateways (Stripe, PayPal, etc.)

### 3. Agent Runtime

**Purpose**: AI-powered conversation and task execution

**Core Features**:

- Model integration (Claude, GPT, etc.)
- Tool execution framework
- Session context management
- Streaming responses
- Multi-turn conversations

**Travel-Specific Enhancements**:

- Booking workflow tools
- CRM integration tools
- Price monitoring tools
- Customer service tools

### 4. Configuration System

**Purpose**: Centralized, validated configuration management

**Key Features**:

- JSON5 format (comments, trailing commas)
- Schema validation (TypeBox/Zod)
- Hot reload (config.apply, config.patch)
- Multi-environment support
- Plugin/extensions config

**Travel-Specific Config**:

```json5
{
  agents: {
    defaults: {
      workspace: "~/.travelagent/workspace",
    },
    list: [
      {
        id: "booking-agent",
        identity: "Travel booking specialist",
        workspace: "~/.travelagent/workspace/booking",
      },
      {
        id: "customer-service",
        identity: "Customer service agent",
        workspace: "~/.travelagent/workspace/service",
      },
    ],
  },
  channels: {
    whatsapp: {
      allowFrom: ["+1234567890"],
      groups: { "*": { requireMention: true } },
    },
    booking: {
      amadeus: {
        apiKey: "...",
        apiSecret: "...",
      },
      sabre: {
        clientId: "...",
        clientSecret: "...",
      },
    },
    crm: {
      provider: "custom",
      apiUrl: "https://crm.example.com/api",
      apiKey: "...",
    },
  },
  cron: {
    enabled: true,
    jobs: [
      {
        name: "Price Monitoring",
        schedule: { kind: "every", everyMs: 3600000 },
        payload: {
          kind: "agentTurn",
          message: "Check price changes for active bookings",
        },
        sessionTarget: "isolated",
      },
    ],
  },
}
```

### 5. Cron Scheduler

**Purpose**: Automated, scheduled task execution

**Key Features**:

- Persistent job store
- Multiple schedule types (at, every, cron)
- Main session vs isolated execution
- Job history and logging

**Travel-Specific Cron Jobs**:

- Price monitoring (check for price drops)
- Booking reminders (upcoming trips)
- Supplier sync (inventory updates)
- Customer follow-ups (post-trip surveys)
- Payment reminders (outstanding invoices)

### 6. Tools Framework

**Purpose**: Extensible tool system for agent capabilities

**Core Tools** (from OpenClaw):

- `read`, `write`, `edit` (file operations)
- `exec` (command execution)
- `browser` (web automation)
- `cron` (scheduled tasks)
- `sessions_*` (multi-agent coordination)

**Travel-Specific Tools** (to implement):

- `search_flights` (flight search across GDS)
- `search_hotels` (hotel availability)
- `create_booking` (reservation creation)
- `cancel_booking` (cancellation handling)
- `get_customer` (CRM lookup)
- `create_customer` (customer registration)
- `check_availability` (real-time inventory)
- `send_email` (customer communications)
- `send_sms` (SMS notifications)

---

## 🚀 Implementation Roadmap

### Phase 1: Core Infrastructure (Weeks 1-4)

1. **Gateway Setup**
   - WebSocket server implementation
   - Protocol definition (TypeBox schemas)
   - Authentication and pairing
   - Event system

2. **Configuration System**
   - JSON5 config parser
   - Schema validation
   - Hot reload mechanism
   - Config API (get, apply, patch)

3. **Session Management**
   - Session store (JSONL files)
   - Session routing logic
   - Context assembly
   - Session isolation

### Phase 2: Channel Integrations (Weeks 5-8)

1. **Core Channels**
   - WhatsApp (Baileys)
   - Telegram (grammY)
   - Email (IMAP/SMTP)
   - WebChat (React UI)

2. **Travel Channels**
   - Booking API adapters (Amadeus, Sabre)
   - CRM integration
   - Supplier API connectors

### Phase 3: Agent Runtime (Weeks 9-12)

1. **Pi Agent Integration**
   - Embedded agent runner
   - Model integration (Claude/GPT)
   - Tool execution framework
   - Streaming support

2. **Travel Tools**
   - Booking tools (search, create, cancel)
   - CRM tools (customer management)
   - Automation tools (email, SMS)

### Phase 4: Automation (Weeks 13-16)

1. **Cron Scheduler**
   - Job store implementation
   - Schedule evaluation
   - Execution engine
   - Job history

2. **Travel Automation**
   - Price monitoring jobs
   - Booking reminders
   - Customer follow-ups

### Phase 5: Skills & Workflows (Weeks 17-20)

1. **Skills System**
   - Skill loader
   - Skill registry
   - Travel-specific skills

2. **Workflows**
   - Flight booking workflow
   - Hotel booking workflow
   - Customer onboarding
   - Visa processing

### Phase 6: UI & Clients (Weeks 21-24)

1. **Web UI**
   - Control dashboard
   - Chat interface
   - Configuration editor
   - Cron job manager

2. **CLI**
   - Gateway commands
   - Agent commands
   - Config commands
   - Cron commands

---

## 🔧 Technology Stack Recommendations

### Backend

- **Runtime**: Node.js 22+ (TypeScript)
- **WebSocket**: `ws` library
- **Schema**: TypeBox + Zod
- **Config**: JSON5 parser
- **Agent**: Pi-agent-core (or custom)
- **Models**: Anthropic Claude, OpenAI GPT

### Frontend

- **Web UI**: React + Vite
- **Mobile**: React Native or Flutter
- **Desktop**: Electron or Tauri

### Data Storage

- **Sessions**: JSONL files
- **Config**: JSON5 files
- **Credentials**: Encrypted JSON files
- **Optional**: SQLite for complex queries

### External Integrations

- **Booking APIs**: Amadeus, Sabre, Travelport SDKs
- **CRM**: REST API clients
- **Email**: `nodemailer` + IMAP libraries
- **SMS**: Twilio, AWS SNS

---

## 📁 Directory Structure

```
travel-agent-os/
├── src/
│   ├── gateway/           # Gateway core
│   │   ├── server.ts      # WebSocket server
│   │   ├── protocol.ts    # Protocol definitions
│   │   ├── methods/       # RPC methods
│   │   └── events.ts      # Event system
│   ├── channels/          # Channel integrations
│   │   ├── whatsapp/
│   │   ├── telegram/
│   │   ├── email/
│   │   ├── booking/       # Booking API adapters
│   │   └── crm/           # CRM integration
│   ├── agents/            # Agent runtime
│   │   ├── runner.ts      # Agent execution
│   │   ├── tools/         # Tool implementations
│   │   │   ├── booking.ts
│   │   │   ├── crm.ts
│   │   │   └── automation.ts
│   │   └── skills/        # Skills loader
│   ├── config/            # Configuration system
│   │   ├── loader.ts
│   │   ├── validator.ts
│   │   └── schema.ts
│   ├── cron/              # Cron scheduler
│   │   ├── service.ts
│   │   ├── jobs.ts
│   │   └── executor.ts
│   ├── sessions/           # Session management
│   │   ├── store.ts
│   │   ├── router.ts
│   │   └── context.ts
│   ├── routing/            # Routing engine
│   │   └── resolver.ts
│   └── cli/                # CLI commands
│       ├── gateway.ts
│       ├── agent.ts
│       ├── config.ts
│       └── cron.ts
├── ui/                     # Web UI
│   ├── dashboard/
│   ├── chat/
│   └── config/
├── skills/                 # Travel skills
│   ├── flight-booking/
│   ├── hotel-booking/
│   └── customer-onboarding/
├── docs/                   # Documentation
└── package.json
```

---

## 🔐 Security Considerations

1. **Authentication**
   - Gateway token authentication
   - Device pairing for nodes
   - Channel-specific credentials (encrypted)

2. **Authorization**
   - Allowlists for channels
   - Tool execution policies
   - Session isolation

3. **Data Protection**
   - Encrypted credential storage
   - Secure API key management
   - PII handling in sessions

4. **Network Security**
   - TLS for WebSocket (remote)
   - SSH tunnels for remote access
   - Tailscale/VPN support

---

## 📊 Monitoring & Observability

1. **Logging**
   - Structured logging (JSON)
   - Log levels (debug, info, warn, error)
   - Channel-specific logging

2. **Metrics**
   - Message throughput
   - Agent response times
   - Tool execution metrics
   - Cron job success rates

3. **Health Checks**
   - Gateway health endpoint
   - Channel connectivity status
   - Agent availability

---

## 🎯 Key Differences from OpenClaw

1. **Domain Focus**
   - Travel-specific tools and workflows
   - Booking platform integrations
   - CRM integration (not just messaging)

2. **Channel Extensions**
   - Booking API adapters (not just messaging)
   - Customer portal integration
   - Supplier API connectors

3. **Automation Priorities**
   - Price monitoring
   - Booking management
   - Customer lifecycle automation

4. **Multi-Agent Scenarios**
   - Specialized agents (booking, service, sales)
   - Agent handoffs (booking → service)
   - Parallel agent execution for complex queries

---

## 📚 Next Steps

1. **Study OpenClaw Codebase**
   - Review gateway implementation
   - Understand channel architecture
   - Study agent runtime
   - Review cron scheduler

2. **Design Travel-Specific Components**
   - Booking tool interfaces
   - CRM integration patterns
   - Workflow definitions

3. **Prototype Core Components**
   - Gateway WebSocket server
   - Basic channel adapter
   - Simple agent runner

4. **Iterate and Extend**
   - Add travel tools incrementally
   - Build out channel integrations
   - Implement automation workflows

---

## 🔗 Reference Links

- OpenClaw Repository: https://github.com/openclaw/openclaw
- OpenClaw Documentation: https://docs.openclaw.ai
- Pi Agent Core: https://github.com/badlogic/pi-mono
- TypeBox: https://github.com/sinclairzx81/typebox
- Baileys (WhatsApp): https://github.com/WhiskeySockets/Baileys
- grammY (Telegram): https://grammy.dev

---

**Note**: This architecture is based on the OpenClaw/ClawDBot codebase. Adapt the components to your specific travel agent requirements while maintaining the core architectural patterns.
