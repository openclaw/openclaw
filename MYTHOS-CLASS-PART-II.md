# 🦞 OpenClaw → Mythos-Class — PART II
## Wire Protocols, Session Engine, Context Assembly, Voice Stack, Rust Crate APIs & Deployment

**Version**: 1.0.0 — 2026-07-20  
**Companion to**: `MYTHOS-CLASS-ARCHITECTURE-SPEC.md` (Part I)

---

## TABLE OF CONTENTS

1. [Gateway Protocol — Wire-Level Full Specification](#i-gateway-protocol--wire-level-full-specification)
2. [Session Management — Deep Code Paths](#ii-session-management--deep-code-paths)
3. [Context Engine — Complete Assembly Pipeline](#iii-context-engine--complete-assembly-pipeline)
4. [Configuration System — Full Type Hierarchy](#iv-configuration-system--full-type-hierarchy)
5. [Voice/Talk Stack — Complete Architecture](#v-voicetalk-stack--complete-architecture)
6. [Hook System — Lifecycle Events & Bundled Hooks](#vi-hook-system--lifecycle-events--bundled-hooks)
7. [Webhooks Plugin — External System Bridge](#vii-webhooks-plugin--external-system-bridge)
8. [Browser Automation — Complete Architecture](#viii-browser-automation--complete-architecture)
9. [Rust Crate API Specifications (NAPI-RS Bindings)](#ix-rust-crate-api-specifications)
10. [Deployment Architecture — Docker, K8s, Fleet](#x-deployment-architecture)

---

## I. GATEWAY PROTOCOL — WIRE-LEVEL FULL SPECIFICATION

### Transport Layer

- **Protocol**: WebSocket (text frames only, JSON payloads)
- **Port**: 18789 (default)
- **Co-located HTTP**: Same port serves REST API, Control UI, health checks
- **Protocol Version**: Integer, minimum 1

### Frame Types (TypeBox Schemas)

All frames are JSON objects. The `type` field discriminates:

```typescript
// src/gateway/protocol/schema/frames.ts

// ─── REQUEST FRAME ──────────────────────────────────────────
type RequestFrame = {
  type: "req";
  id: string;           // Unique request ID (client-generated)
  method: string;       // RPC method name
  params?: unknown;     // Method-specific parameters
};

// ─── RESPONSE FRAME ─────────────────────────────────────────
type ResponseFrame = {
  type: "res";
  id: string;           // Matches request ID
  ok?: unknown;         // Success payload
  error?: ErrorShape;   // Error payload
};

type ErrorShape = {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};

// ─── EVENT FRAME ────────────────────────────────────────────
type EventFrame = {
  type: "event";
  event: string;        // Event name
  data: unknown;        // Event payload
};
```

### Handshake Protocol (Full)

```typescript
// 1. CLIENT → SERVER: Connect Request
{
  type: "req",
  id: "<uuid>",
  method: "connect",
  params: {
    // Protocol negotiation
    minProtocol: 3,
    maxProtocol: 3,

    // Client identity
    client: {
      id: "<client-id>",
      displayName?: "My iPhone",
      version: "2026.5.10",
      platform: "ios",           // "ios" | "android" | "macos" | "linux" | "windows" | "web"
      deviceFamily?: "iPhone",
      modelIdentifier?: "iPhone15,2",
      mode: "operator",          // "operator" | "node"
      instanceId?: "<uuid>",
    },

    // Node capabilities (role: "node" only)
    caps?: ["camera", "canvas", "screen", "location", "voice"],
    commands?: ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    permissions?: { "operator.admin": true },

    // Authentication
    role?: "operator" | "node",
    scopes?: ["operator.admin", "operator.write", "operator.read"],
    auth?: {
      token?: "<OPENCLAW_GATEWAY_TOKEN>",
      bootstrapToken?: "<one-time-setup-code>",
      deviceToken?: "<previously-issued-device-token>",
      password?: "<password>",
    },

    // Device identity (for pairing)
    device?: {
      id: "<device-uuid>",
      publicKey: "<base64-ed25519-public-key>",
      signature: "<base64-ed25519-signature>",
      signedAt: 1711000000000,    // Unix ms
      nonce: "<random-nonce>",
    },

    // Environment
    pathEnv?: "/usr/local/bin:/usr/bin",
    locale?: "en-US",
    userAgent?: "OpenClaw-iOS/2026.5.10",
  }
}

// 2. SERVER → CLIENT: Hello OK (on success)
{
  type: "hello-ok",
  protocol: 3,                    // Negotiated protocol version
  server: {
    version: "2026.5.10-beta.1",
    connId: "<server-connection-id>",
  },
  features: {
    methods: ["health", "status", "send", "agent", "sessions.list", ...],
    events: ["tick", "agent", "presence", "shutdown", "chat", ...],
  },
  snapshot: {
    // Current gateway state snapshot
    sessions: SessionEntry[],
    agents: AgentSummary[],
    channels: ChannelStatus[],
    nodes: NodePresence[],
  },
  pluginSurfaceUrls: {
    "browser": "http://127.0.0.1:18790/browser",
    "canvas": "http://127.0.0.1:18793",
  },
  auth: {
    deviceToken: "<issued-device-token>",
    role: "operator",
    scopes: ["operator.admin"],
    issuedAtMs: 1711000000000,
  },
  policy: {
    maxPayload: 1048576,          // 1MB max frame size
    maxBufferedBytes: 4194304,    // 4MB buffer
    tickIntervalMs: 30000,        // 30s heartbeat
  },
}

// 3. SERVER → CLIENT: Presence Event (immediately after hello-ok)
{
  type: "event",
  event: "presence",
  data: { /* connected clients, nodes, agents */ }
}

// 4. SERVER → CLIENT: Periodic Tick
{
  type: "event",
  event: "tick",
  data: { ts: 1711000030000 }
}
```

### Device Authentication Payload v3

```typescript
// src/gateway/device-auth.ts
// buildDeviceAuthPayloadV3() constructs the signing payload:

type DeviceAuthPayloadV3 = {
  device: string;        // Device UUID
  client: string;        // Client ID
  role: string;          // "operator" | "node"
  scopes: string[];      // Requested scopes
  token: string;         // Auth token (or hash)
  nonce: string;         // Server-issued nonce
  platform: string;      // "ios" | "android" | "macos" | ...
  deviceFamily: string;  // "iPhone" | "Pixel" | "Mac" | ...
};

// Signature: Ed25519 over canonical JSON encoding of payload
// Server verifies against stored public key for paired device
// Paired metadata is PINNED on reconnect — metadata changes require re-pairing
```

### Server Methods (Complete Registry)

```
src/gateway/server-methods-list.ts defines all registered methods:

CONTROL PLANE:
  health              — Gateway health check
  status              — Detailed status (sessions, agents, channels, nodes)
  system-presence     — System-wide presence update

SESSION MANAGEMENT:
  sessions.list       — List sessions (with filters)
  sessions.create     — Create new session
  sessions.delete     — Delete session
  sessions.send       — Send message to session
  sessions.resolve    — Resolve session by key/id
  sessions.describe   — Get session details
  sessions.cleanup    — Cleanup stale sessions
  sessions.preview    — Preview session messages
  sessions.messages.subscribe   — Subscribe to session messages
  sessions.messages.unsubscribe — Unsubscribe

AGENT:
  agent               — Run agent on session (main RPC)
  agent.identity      — Get/set agent identity
  agent.wait          — Wait for agent completion

MESSAGING:
  send                — Send message to channel target
  message.action      — Execute channel message action (react, edit, etc.)
  poll                — Create poll on channel
  wake                — Wake heartbeat

CONFIG:
  config.get          — Get full config
  config.set          — Set config (full replace)
  config.apply        — Apply config patch
  config.patch        — Patch config (merge)
  config.schema       — Get config schema
  config.schema.lookup — Lookup specific schema path

CHANNELS:
  channels.start      — Start channel adapter
  channels.stop       — Stop channel adapter
  channels.logout     — Logout channel (e.g., WhatsApp QR)

NODES:
  nodes.list          — List paired nodes
  nodes.describe      — Get node details
  nodes.invoke        — Invoke node command
  nodes.pair.request  — Request pairing
  nodes.pair.approve  — Approve pairing
  nodes.pair.reject   — Reject pairing
  nodes.pair.remove   — Remove paired node
  nodes.pending.ack   — Acknowledge pending work

DEVICES:
  device.pair.list       — List device pairings
  device.pair.approve    — Approve device
  device.pair.remove     — Remove device
  device.token.rotate    — Rotate device token
  device.token.revoke    — Revoke device token

EXEC APPROVALS:
  exec-approvals.get       — Get approval config
  exec-approvals.set       — Set approval config
  exec-approval.get        — Get pending approval
  exec-approval.request    — Request approval
  exec-approval.resolve    — Resolve approval (approve/deny)

PLUGINS:
  plugins.list         — List installed plugins
  plugins.enable       — Enable plugin
  plugins.disable      — Disable plugin

SKILLS:
  skills.search        — Search ClawHub
  skills.install       — Install skill
  skills.update        — Update skill
  skills.verify        — Verify skill trust
  skills.status        — Get skill status
  skills.detail        — Get skill detail
  skills.upload.begin  — Begin upload
  skills.upload.chunk  — Upload chunk
  skills.upload.commit — Commit upload

MODELS:
  models.list          — List available models
  agents.list          — List configured agents
  agents.create        — Create agent
  agents.update        — Update agent
  agents.delete        — Delete agent
  tools.catalog        — Get tool catalog
  tools.invoke         — Invoke tool directly

TALK/VOICE:
  talk.config          — Get talk config
  talk.catalog         — List talk providers
  talk.client.create   — Create client talk session
  talk.client.toolCall — Client tool call
  talk.session.steer   — Steer voice session
  talk.session.create  — Create talk session
  talk.session.appendAudio — Append audio
  talk.session.close   — Close talk session

CRON:
  cron.list            — List cron jobs
  cron.get             — Get cron job
  cron.add             — Add cron job
  cron.update          — Update cron job
  cron.remove          — Remove cron job

TASKS:
  tasks.list           — List tasks
  tasks.get            — Get task details
  tasks.dismiss        — Dismiss task
  tasks.flow.list      — List task flows
  tasks.flow.create    — Create task flow
  tasks.flow.advance   — Advance flow
  tasks.flow.cancel    — Cancel flow

ARTIFACTS:
  artifacts.list       — List artifacts
  artifacts.get        — Get artifact
  artifacts.download   — Download artifact

MCP:
  (via HTTP endpoints, not WS)

UPDATE:
  update.status        — Check update status
  update.run           — Run update
```

### Event Types

```
tick              — Periodic heartbeat (ts)
agent             — Agent streaming events (runId, seq, stream, data)
presence          — Client/node presence changes
shutdown          — Gateway shutting down (reason, restartExpectedMs)
chat              — Chat message events
health            — Health status changes
heartbeat         — Heartbeat events
cron              — Cron job events
payload.large     — Oversized frame diagnostic
exec.approval.requested  — Exec approval needed
exec.approval.resolved   — Exec approval resolved
node.pair.request        — Node pairing request
node.event               — Node event result
talk.*                     — Talk/voice events
```

### Agent Event Schema (Streaming)

```typescript
// src/gateway/protocol/schema/agent.ts
type AgentEvent = {
  runId: string;        // Unique run identifier
  seq: number;          // Sequence number (0-based, per run)
  stream: string;       // Stream type: "text" | "tool" | "thinking" | "error"
  ts: number;           // Timestamp (ms)
  spawnedBy?: string;   // Parent run ID (for sub-agents)
  data: Record<string, unknown>;  // Stream-specific payload
};

// Agent run completion includes:
type AgentInternalEvent = {
  type: "task-completion";
  source: "subagent" | "cron" | "taskflow";
  childSessionKey: string;
  childSessionId?: string;
  announceType: string;
  taskLabel: string;
  status: "completed" | "failed" | "cancelled";
  statusLabel: string;
  result: string;
  mediaUrls?: string[];
  statsLine?: string;
  replyInstruction: string;
};
```

---

## II. SESSION MANAGEMENT — DEEP CODE PATHS

### Session Key Architecture

```typescript
// src/routing/session-key.js
// Session key format:
//   agent:<agentId>:<channel>:<kind>:<id>
//
// Examples:
//   agent:main:main                              — Main session (no channel)
//   agent:main:telegram:dm:123456                — Telegram DM
//   agent:main:discord:channel:789               — Discord channel
//   agent:mythos-code:subagent:uuid-abc          — Sub-agent session
//   agent:main:cron:daily-brief                  — Cron session
//   agent:main:whatsapp:group:120363xxx@g.us     — WhatsApp group

// Parsing utilities:
function parseAgentSessionKey(key: string): {
  agentId: string;
  channel?: string;
  kind?: string;
  id?: string;
}

function classifySessionKey(key: string):
  "main" | "persistent" | "synthetic" | "unknown"
```

### Session Store Architecture

```typescript
// src/config/sessions/ — Session persistence

// Dual-layer persistence:
// Layer 1: sessions.json (index/store)
//   Maps sessionKey → SessionEntry metadata
//   { sessionKey, sessionId, model, label, deliveryContext, ... }

// Layer 2: .jsonl transcript files (per session)
//   ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
//   Each line: { role, content, toolCalls?, toolResults?, ts }

// Key files:
// sessions.ts              — Session store CRUD
// sessions/transcript.ts   — Transcript read/write (reverse streaming)
// sessions/transcript-append.ts — Atomic append (sequential writes)
```

### Session Transcript Format (JSONL)

```jsonl
{"role":"user","content":"What's the weather?","ts":1711000000000}
{"role":"assistant","content":"","toolCalls":[{"name":"web_search","args":{"query":"weather today"},"id":"tc_1"}],"ts":1711000001000}
{"role":"tool","id":"tc_1","content":"Sunny, 24°C"}
{"role":"assistant","content":"It's sunny and 24°C today!","ts":1711000002000}
```

### Context Compaction Pipeline

```typescript
// src/agents/pi-embedded-runner/compact.ts + compact.runtime.ts

// Three strategies (applied in order):
// 1. SUMMARIZE — Replace older messages with AI-generated summary
//    Triggered when token count exceeds threshold
//    Summary replaces all messages before a cutoff point

// 2. PRUNE — Remove transient tool outputs
//    Keeps tool call names and results but removes intermediate noise
//    Reduces token count without losing information

// 3. MEMORY FLUSH — Promote important facts before clearing
//    Triggers a silent agent turn: "Write important facts to memory"
//    Only fires once per compaction cycle
//    Skipped if workspace is read-only

// Compaction checkpoints:
type CompactionCheckpoint = {
  checkpointId: string;
  sessionKey: string;
  sessionId: string;
  createdAt: number;
  reason: "manual" | "auto-threshold" | "overflow-retry" | "timeout-retry";
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
  firstKeptEntryId?: string;
  preCompaction: { sessionId, sessionFile, leafId, entryId };
  postCompaction: { sessionId, sessionFile, leafId, entryId };
};
```

### Session Branching (April 2026)

```
Main Session (linear):
  T1 ── T2 ── T3 ── T4 ── T5

With Branching (fork at T3):
  T1 ── T2 ── T3 ─┬── T4-A (branch: risky action)
                   │      └── FAIL → restore to T3
                   └── T4-B (main: safe continuation)

// Implementation: TranscriptRewriteRequest
type TranscriptRewriteRequest = {
  replacements: TranscriptRewriteReplacement[];
};
type TranscriptRewriteReplacement = {
  entryId: string;      // Existing entry to replace
  message: AgentMessage; // Replacement message
};

// Result:
type TranscriptRewriteResult = {
  branchChanged: boolean;  // Whether active branch changed
  newBranchId?: string;    // New branch identifier
};
```

---

## III. CONTEXT ENGINE — COMPLETE ASSEMBLY PIPELINE

### Context Engine Interface

```typescript
// src/context-engine/types.ts

// The ContextEngine is the central abstraction for managing what goes
// into the model's context window. It's pluggable — plugins can register
// custom engines.

type ContextEngine = {
  info: ContextEngineInfo;

  // Lifecycle
  bootstrap(params): Promise<BootstrapResult>;
  maintain(params): Promise<void>;

  // Ingestion
  ingest(params): Promise<IngestResult>;
  ingestBatch(params): Promise<IngestBatchResult>;

  // Assembly — THE CRITICAL METHOD
  assemble(params): Promise<AssembleResult>;

  // Compaction
  compact(params): Promise<CompactResult>;

  // Turn hooks
  afterTurn(params): Promise<void>;

  // Sub-agent support
  prepareSubagentSpawn?(params): Promise<SubagentSpawnPreparation>;
  endSubagent?(params, reason: SubagentEndReason): Promise<void>;

  // Session branching
  rewriteTranscript?(request: TranscriptRewriteRequest): Promise<TranscriptRewriteResult>;
};

type AssembleResult = {
  messages: AgentMessage[];     // Ordered messages for model context
  estimatedTokens: number;      // Token estimate
  promptAuthority?: "assembled" | "preassembly_may_overflow";
  systemPromptAddition?: string; // Additional system prompt text
};

type ContextEngineInfo = {
  id: string;
  name: string;
  version?: string;
  ownsCompaction?: boolean;
  turnMaintenanceMode?: "foreground" | "background";
};
```

### Context Engine Registry

```typescript
// src/context-engine/registry.ts

// Engines are registered by plugins:
type ContextEngineFactory = (ctx: ContextEngineFactoryContext) =>
  ContextEngine | Promise<ContextEngine>;

type ContextEngineFactoryContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
};

// Resolution:
function resolveContextEngine(sessionKey: string): ContextEngine
function resolveContextEngineOwnerPluginId(engine: ContextEngine): string

// Default engine: Legacy context engine (built-in, non-plugin)
// Registered at startup by src/context-engine/legacy.ts
```

### System Prompt Construction Pipeline

```typescript
// src/agents/pi-embedded-runner/system-prompt.ts
// buildEmbeddedSystemPrompt() — THE most consequential function

// The system prompt is assembled from these components IN ORDER:

// 1. BASE PROMPT
//    - Hardcoded agent identity & behavioral rules
//    - Tool usage instructions
//    - Safety constraints
//    - Silent reply handling

// 2. CONTEXT FILES (bootstrap files from workspace)
//    - SOUL.md    — Personality, values, tone (FIRST)
//    - AGENTS.md  — Operating instructions
//    - USER.md    — Human profile
//    - TOOLS.md   — Environment-specific tool info
//    - MEMORY.md  — Long-term curated memory
//    - IDENTITY.md — Name, emoji, avatar
//    - HEARTBEAT.md — Periodic task instructions
//    - BOOT.md    — Startup hook actions

// 3. SKILLS LIST (compact — names + descriptions + paths ONLY)
//    - Not full skill content — agent reads SKILL.md on demand
//    - Lazy loading at the semantic level

// 4. RUNTIME INFO
//    - Agent ID, host, OS, architecture
//    - Current model & provider
//    - Channel info & capabilities
//    - Active process sessions (e.g., tmux)

// 5. TOOL LIST
//    - Names of all available tools
//    - Model alias lines (for /model switching)

// 6. ENVIRONMENTAL CONTEXT
//    - User timezone
//    - Current time (formatted)
//    - Sandbox info (if sandboxed)

// 7. OPTIONAL SECTIONS
//    - TTS hints (voice reply guidance)
//    - Reaction guidance (minimal/extensive)
//    - Workspace notes
//    - Reasoning/thinking level hints
//    - Provider-specific prompt contributions
//    - ACP routing guidance
//    - Native command guidance
//    - Memory citations mode

// BUDGET CONSTRAINTS:
// bootstrapMaxChars:        20,000 (per file)
// bootstrapTotalMaxChars:   60,000 (all files combined)
// Large files are TRUNCATED with notice
```

---

## IV. CONFIGURATION SYSTEM — FULL TYPE HIERARCHY

### OpenClawConfig Root Type

```typescript
// src/config/types.openclaw.ts

type OpenClawConfig = {
  $schema?: string;
  meta?: {
    lastTouchedVersion?: string;
    lastTouchedAt?: string;
  };

  // ─── AUTH ─────────────────────────────────────────────
  auth?: AuthConfig;
  // Token resolution: env vars, file refs, exec commands
  // Supports: OPENCLAW_GATEWAY_TOKEN, device tokens, passwords

  // ─── ACCESS CONTROL ───────────────────────────────────
  accessGroups?: AccessGroupsConfig;
  // Group-based access control for multi-user deployments

  // ─── ACP ──────────────────────────────────────────────
  acp?: AcpConfig;
  // Agent Client Protocol configuration
  // Harness selection, session isolation, provenance

  // ─── ENVIRONMENT ──────────────────────────────────────
  env?: {
    shellEnv?: { enabled?: boolean; timeoutMs?: number };
    vars?: Record<string, string>;
    [key: string]: string | Record<string, string> | ...;
  };

  // ─── WIZARD STATE ─────────────────────────────────────
  wizard?: {
    lastRunAt?: string;
    lastRunVersion?: string;
    lastRunCommit?: string;
    lastRunCommand?: string;
    lastRunMode?: "local" | "remote";
  };

  // ─── DIAGNOSTICS & LOGGING ────────────────────────────
  diagnostics?: DiagnosticsConfig;
  logging?: LoggingConfig;
  cli?: CliConfig;

  // ─── BROWSER ──────────────────────────────────────────
  browser?: BrowserConfig;
  // profiles, SSRF policy, Playwright config

  // ─── UI ───────────────────────────────────────────────
  ui?: {
    seamColor?: string;
    assistant?: { name?: string; avatar?: string };
  };

  // ─── SECRETS ──────────────────────────────────────────
  secrets?: SecretsConfig;
  // Secret resolution: env, file, exec, vault

  // ─── SKILLS ───────────────────────────────────────────
  skills?: SkillsConfig;
  // Installation controls, extra dirs, allowlists

  // ─── PLUGINS ──────────────────────────────────────────
  plugins?: PluginsConfig;
  // Plugin enable/disable, per-plugin config, install records

  // ─── MODELS ───────────────────────────────────────────
  models?: ModelsConfig;
  // Provider configs, model selection, auth profiles, failover chains

  // ─── NODE HOST ────────────────────────────────────────
  nodeHost?: NodeHostConfig;
  // Node capability management

  // ─── AGENTS ───────────────────────────────────────────
  agents?: AgentsConfig;
  // Per-agent config: workspace, model, tools, memory, sandbox

  // ─── TOOLS ────────────────────────────────────────────
  tools?: ToolsConfig;
  // Tool profiles, allowlists, denylists, alsoAllow

  // ─── BINDINGS ─────────────────────────────────────────
  bindings?: AgentBinding[];
  // Channel → Agent routing bindings

  // ─── MESSAGING ────────────────────────────────────────
  broadcast?: BroadcastConfig;
  audio?: AudioConfig;
  media?: { preserveFilenames?: boolean; retentionWindow?: ... };

  // ─── CHANNELS ─────────────────────────────────────────
  channels?: ChannelsConfig;
  // Per-channel config: allowlists, mention gating, typing

  // ─── GATEWAY ──────────────────────────────────────────
  gateway?: GatewayConfig;
  // Port, bind, auth, TLS, discovery, Talk config

  // ─── CRON ─────────────────────────────────────────────
  cron?: CronConfig;
  // Schedule timezone, retention

  // ─── HOOKS ────────────────────────────────────────────
  hooks?: HooksConfig;
  // Internal hooks, hook directories, module paths

  // ─── MCP ──────────────────────────────────────────────
  mcpServers?: McpConfig;
  // MCP server definitions (stdio, HTTP/SSE)

  // ─── MEMORY ───────────────────────────────────────────
  memory?: MemoryConfig;
  // Backend (builtin/qmd), search config, dreaming

  // ─── COMMITMENTS ──────────────────────────────────────
  commitments?: CommitmentsConfig;
  // Inferred commitment settings

  // ─── UPDATE ───────────────────────────────────────────
  update?: {
    channel?: "stable" | "beta" | "dev";
    checkOnStart?: boolean;
    auto?: { enabled?: boolean; stableDelayHours?: number; ... };
  };

  // ─── PROXY ────────────────────────────────────────────
  // ProxyConfig (zod-schema.proxy.ts)
  // HTTP/HTTPS proxy settings
};
```

### Config I/O Pipeline

```typescript
// src/config/io.ts — Config read/write with full safety

// READ PIPELINE:
// 1. resolveConfigPath()           — Find config file
// 2. readConfigFileSnapshot()      — Read raw JSON5
// 3. resolveConfigIncludes()       — Process $include directives
// 4. applyConfigEnvVars()          — Apply env overrides
// 5. resolveConfigEnvVars()        — Resolve ${ENV_VAR} references
// 6. asRuntimeConfig()             — Convert to runtime shape
// 7. applyConfigOverrides()        — Apply CLI/env overrides
// 8. validateConfig()              — Schema validation
// 9. setRuntimeConfigSnapshot()    — Store for runtime access

// WRITE PIPELINE:
// 1. createMergePatch()            — Generate JSON Merge Patch
// 2. applyMergePatch()             — Apply patch to current config
// 3. projectSourceOntoRuntimeShape() — Validate write shape
// 4. resolveWriteEnvSnapshotForPath() — Capture env for audit
// 5. replaceFileAtomic()           — Atomic file write
// 6. appendConfigAuditRecord()     — Audit trail entry
// 7. maintainConfigBackups()       — Rotate backup files
// 8. notifyRuntimeConfigWriteListeners() — Signal runtime update

// SAFETY MECHANISMS:
// - Base-hash guard: Prevents concurrent overwrites
// - Atomic write: Write to temp, rename
// - Backup rotation: Keep last N configs
// - Clobber snapshot: Save full config before overwrite
// - Last-known-good recovery: Auto-recover from corruption
// - Nix mode guard: Prevent writes in Nix-managed mode
// - Secret redaction: Never log/write secrets in plaintext
```

---

## V. VOICE/TALK STACK — COMPLETE ARCHITECTURE

### Source Location: `src/talk/`

```
src/talk/
├── agent-consult-runtime.ts       # Agent consult for voice
├── agent-consult-tool.ts          # Voice→Agent tool call
├── agent-talkback-runtime.ts      # Agent talkback (voice output)
├── audio-codec.ts                 # Audio format conversion
├── diagnostics.ts                 # Voice diagnostics
├── fast-context-runtime.ts        # Fast context for voice
├── logging.ts                     # Talk logging
├── observability.ts               # Talk metrics
├── provider-registry.ts           # Voice provider registry
├── provider-resolver.ts           # Provider resolution
├── provider-types.ts              # Provider type definitions
├── session-log-runtime.ts         # Session log integration
├── session-runtime.ts             # Talk session management
├── talk-events.ts                 # Event emission
├── talk-session-controller.ts     # Session lifecycle
└── (test files)
```

### Talk Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    TALK/VOICE PIPELINE                         │
├──────────────────────────────────────────────────────────────┤
│                                                                │
│  INPUT PATH:                                                   │
│  ┌─────────┐    ┌──────────┐    ┌─────────────┐             │
│  │ Mic /   │───►│ Audio    │───►│ Provider    │             │
│  │ WebRTC  │    │ Codec    │    │ (STT)       │             │
│  │ / PTT   │    │ (PCM→    │    │ Deepgram /  │             │
│  │         │    │  Opus)   │    │ Whisper /   │             │
│  └─────────┘    └──────────┘    │ OpenAI RT   │             │
│                                  └──────┬──────┘             │
│                                         │ text                │
│                                         ▼                     │
│  AGENT CONSULT:                         │                     │
│  ┌──────────────────────────────────────┐│                     │
│  │ agent-consult-runtime.ts             ││                     │
│  │ • Fork session from parent           ││                     │
│  │ • Build voice-specific prompt        ││                     │
│  │ • Run agent (full tool access)       ││                     │
│  │ • Return text response               ││                     │
│  │ • Modes: "isolated" | "fork"         ││                     │
│  └──────────────────────────────────────┘│                     │
│                                         ▼                     │
│  OUTPUT PATH:                           │                     │
│  ┌──────────┐    ┌──────────┐    ┌─────┴───────┐            │
│  │ Speaker /│◄───│ Audio    │◄───│ Provider    │            │
│  │ WebRTC   │    │ Codec    │    │ (TTS)       │            │
│  │          │    │ (Opus→   │    │ ElevenLabs /│            │
│  │          │    │  PCM)    │    │ MLX Soprano │            │
│  └──────────┘    └──────────┘    └─────────────┘            │
│                                                                │
│  PROVIDER REGISTRY:                                           │
│  • Plugin-based: providers register as RealtimeVoiceProvider  │
│  • Resolution: normalizeRealtimeVoiceProviderId()             │
│  • Config: talk.realtime.provider in openclaw.json           │
│                                                                │
│  GATEWAY RELAY:                                               │
│  • talk-realtime-relay.ts — Gateway-side relay               │
│  • talk-transcription-relay.ts — Transcription-only mode     │
│  • talk-session-registry.ts — Active session tracking         │
│                                                                │
└──────────────────────────────────────────────────────────────┘
```

### Agent Consult Flow

```typescript
// src/talk/agent-consult-runtime.ts

// When voice input arrives and brain strategy is "agent-consult":
// 1. Build voice-specific prompt from transcript
// 2. Decide context mode: "isolated" or "fork"
//    - "isolated": Fresh session, no history
//    - "fork": Fork from current session (preserves context)
// 3. Resolve sandbox session key: agent:<agentId>:<sessionKey>
// 4. Resolve delivery context for response routing
// 5. Run embedded agent with voice-optimized settings
// 6. Collect visible text from response
// 7. Return text for TTS synthesis

type RealtimeVoiceAgentConsultContextMode = "isolated" | "fork";
```

### Talk Protocol Methods

```typescript
// Gateway WS methods for Talk:

talk.config           // Get talk configuration
talk.catalog          // List available talk providers

// Client-owned sessions (WebRTC):
talk.client.create    // Create client-owned realtime session
talk.client.toolCall  // Forward provider tool calls to Gateway

// Gateway-owned sessions:
talk.session.create   // Create gateway-owned session
talk.session.steer    // Send text/steer into active session
talk.session.appendAudio  // Append audio to session
talk.session.cancelTurn   // Cancel current turn
talk.session.close    // Close session

// Modes:
// "realtime"      — Full bidirectional voice
// "transcription" — Captions/dictation only (no assistant voice)
```

---

## VI. HOOK SYSTEM — LIFECYCLE EVENTS & BUNDLED HOOKS

### Source: `src/hooks/`

```
src/hooks/
├── bundled/
│   ├── boot-md/              # BOOT.md startup hook
│   ├── bootstrap-extra-files/ # Extra bootstrap file injection
│   ├── command-logger/        # Command execution logging
│   ├── compaction-notifier/   # Compaction event notification
│   └── session-memory/        # Session memory persistence
```

### Hook Lifecycle Events

```typescript
// Hook events (internal + plugin):

// SESSION LIFECYCLE:
"/new"          — New session created
"/reset"        — Session reset
"/stop"         — Agent stopped
"compaction"    — Context compaction triggered

// AGENT LIFECYCLE:
"before_agent_reply"  — Pre-inference (can short-circuit)
"after_agent_reply"   — Post-inference
"tool_call"           — Tool invocation (plugin hooks)

// GATEWAY LIFECYCLE:
"gateway_start"       — Gateway booted
"gateway_stop"        — Gateway stopping

// MESSAGE FLOW:
"message_flow"        — Each message passes through
"inbound_message"     — Inbound message received
"outbound_message"    — Outbound message sent

// CONFIG:
"config_change"       — Config was modified
"plugin_reload"       — Plugin was reloaded
```

### Bundled Hooks

```typescript
// session-memory hook:
// Persists session state to memory files after each agent turn
// Reads today's memory file, appends new learnings

// boot-md hook:
// Reads BOOT.md from workspace at gateway startup
// Executes any startup actions defined there

// bootstrap-extra-files hook:
// Injects additional files into bootstrap context
// Beyond the standard SOUL.md, AGENTS.md, etc.

// command-logger hook:
// Logs all command executions to audit trail
// Tracks: command, args, duration, success/failure

// compaction-notifier hook:
// Notifies when compaction occurs
// Can trigger memory flush before compaction clears context
```

---

## VII. WEBHOOKS PLUGIN — EXTERNAL SYSTEM BRIDGE

### Source: `extensions/webhooks/`

```typescript
// extensions/webhooks/index.ts + src/

// The Webhooks plugin adds authenticated HTTP routes to the Gateway
// so external systems (Zapier, n8n, CI) can create and drive TaskFlows.

// SECURITY:
// • Fixed-window rate limiting: 120 req / 60s per path+client-IP
// • In-flight limit: 8 concurrent requests per key
// • Shared-secret authentication (env, file, or exec)
// • Body size limit: 256 KB, 15-second read timeout
// • POST-only, Content-Type: application/json

// CONFIGURATION (openclaw.json):
{
  "plugins": {
    "entries": {
      "webhooks": {
        "enabled": true,
        "config": {
          "routes": {
            "github_ci": {
              "path": "/plugins/webhooks/github-ci",
              "sessionKey": "agent:main:mythos-code",
              "secret": { "source": "env", "id": "GITHUB_WEBHOOK_SECRET" },
              "controllerId": "webhooks/github-ci"
            },
            "zapier": {
              "path": "/plugins/webhooks/zapier",
              "sessionKey": "agent:main:mythos-prime",
              "secret": { "source": "env", "id": "ZAPIER_WEBHOOK_SECRET" },
              "controllerId": "webhooks/zapier"
            }
          }
        }
      }
    }
  }
}

// Each route binds to a TaskFlow session:
// • Can inspect and mutate any TaskFlow owned by that session
// • Routes CANNOT act outside their bound session
// • Access always via api.runtime.tasks.managedFlows.bindSession(...)
```

---

## VIII. BROWSER AUTOMATION — COMPLETE ARCHITECTURE

### Source: `extensions/browser/src/`

```
extensions/browser/src/
├── browser-tool.ts              # Main tool entry (100+ actions)
├── browser-tool.actions.ts      # Action implementations
├── browser-tool.runtime.ts      # Runtime integration
├── browser-tool.schema.ts       # Tool schema definition
├── browser-control-state.ts     # Control state management
├── browser-runtime.ts           # Browser runtime
├── control-service.ts           # Control service
├── core-api.ts                  # Core browser API
├── plugin-service.ts            # Plugin service
├── doctor-browser.ts            # Browser diagnostics
├── security/
│   └── security-audit.ts        # Security audit
├── security-audit.ts            # SSRF + security checks
├── config/                      # Profile configuration
├── browser/                     # Browser process management
├── cli/                         # CLI commands
├── gateway/                     # Gateway integration
├── infra/                       # Infrastructure utilities
├── logging/                     # Browser logging
├── media/                       # Screenshot/PDF handling
└── node-host/                   # Node host integration
```

### Browser Actions

```typescript
// extensions/browser/src/browser-tool.actions.ts

// MANAGEMENT:
browserStart      — Start browser (--headless optional)
browserStop       — Stop browser
browserStatus     — Check status
browserDoctor     — Full diagnostic
browserProfiles   — List profiles

// NAVIGATION:
browserNavigate   — Navigate to URL
browserOpenTab    — Open new tab
browserCloseTab   — Close tab
browserFocusTab   — Focus tab by ID
browserTabs       — List open tabs

// INSPECTION:
browserScreenshot — Capture screenshot (full-page, ref, labels)
browserSnapshot   — Accessibility tree snapshot (ai/aria format)
browserConsole    — Console messages
browserErrors     — JavaScript errors
browserRequests   — Network requests
browserPdfSave    — Save page as PDF

// INTERACTION (via browserAct):
// Click, Type, Hover, Drag, Scroll, Select, Press, Form fill
// All with ref-based targeting from snapshot

// FILE HANDLING:
browserArmDialog    — Arm file chooser dialog
browserArmFileChooser — Alternative file chooser
```

### Snapshot Ref System

```typescript
// The snapshot assigns refs to interactive elements:
// Format: ax1, ax2, ax3, ... (accessibility tree order)
//
// CRITICAL: Refs EXPIRE on navigation!
// After any page change: re-snapshot → get fresh refs
//
// Unknown/stale refs fail FAST (no silent wrong-element):
// "ax42" → If stale → Error: "Ref expired, re-snapshot required"
```

### Security Model

```typescript
// SSRF Protection:
// • Strict mode: Only allowlisted hosts accessible
// • Network prediction disabled before launch
// • Proxy env vars do NOT proxy managed browser
// • Remote CDP discovery checked in strict mode

// Circuit Breaker:
// • Repeated launch failures → pause new attempts
// • Prevents Chromium spawn storm on broken config

// Profile Isolation:
// • Each profile has separate user data directory
// • Managed profiles isolated from personal browser
// • Cookie copying is explicit (macOS only)
```

---

## IX. RUST CRATE API SPECIFICATIONS

### Design Principles

1. **Zero-copy where possible** — Avoid JSON serialization round-trips
2. **Async-first** — All I/O-bound operations return `Future`
3. **Typed bridges** — NAPI-RS generates TypeScript types from Rust
4. **Drop-in replacement** — Match existing TypeScript function signatures
5. **Graceful fallback** — If native module fails, fall back to JS implementation

### Crate 1: `mythos-vector-engine`

```rust
// crates/mythos-vector-engine/src/lib.rs

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// HNSW-based vector search engine
/// Replaces: sqlite-vec flat cosine search
/// 100x faster at 1M+ vectors

#[napi]
pub struct VectorIndex {
    inner: usearch::Index,
    dimensions: u32,
    metric: DistanceMetric,
}

#[napi]
pub enum DistanceMetric {
    Cosine,
    Euclidean,
    InnerProduct,
}

#[napi]
#[derive(Clone)]
pub struct SearchResult {
    pub id: String,
    pub score: f64,
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[napi]
impl VectorIndex {
    /// Create a new HNSW index
    #[napi(constructor)]
    pub fn new(
        dimensions: u32,
        metric: DistanceMetric,
        max_elements: u32,
        ef_construction: u32,  // Default: 200
        m: u32,                // Default: 16
    ) -> Result<Self> { ... }

    /// Load index from file
    #[napi(factory)]
    pub fn load(path: String) -> Result<Self> { ... }

    /// Save index to file (atomic write)
    #[napi]
    pub fn save(&self, path: String) -> Result<()> { ... }

    /// Add vectors (batch)
    #[napi]
    pub fn add_batch(
        &mut self,
        ids: Vec<String>,
        vectors: Vec<Vec<f32>>,
    ) -> Result<u32> { ... }  // Returns count added

    /// Search by vector (async for large indexes)
    #[napi]
    pub async fn search(
        &self,
        query: Vec<f32>,
        top_k: u32,
    ) -> Result<Vec<SearchResult>> { ... }

    /// Remove vectors by ID
    #[napi]
    pub fn remove_batch(&mut self, ids: Vec<String>) -> Result<u32> { ... }

    /// Get index statistics
    #[napi]
    pub fn stats(&self) -> IndexStats { ... }
}

#[napi]
pub struct IndexStats {
    pub total_vectors: u64,
    pub dimensions: u32,
    pub max_elements: u64,
    pub memory_bytes: u64,
    pub metric: String,
}

// TypeScript binding (auto-generated by napi-rs):
// import { VectorIndex, DistanceMetric, SearchResult } from '@openclaw/mythos-vector-engine';
```

### Crate 2: `mythos-search-engine`

```rust
// crates/mythos-search-engine/src/lib.rs

use napi_derive::napi;
use tantivy::{Index, schema::*, collector::TopDocs, query::QueryParser};

/// Tantivy-based BM25 full-text search
/// Replaces: SQLite FTS5
/// 10x faster, better ranking, custom tokenizers

#[napi]
pub struct SearchIndex {
    index: Index,
    reader: IndexReader,
    text_field: Field,
    path_field: Field,
    id_field: Field,
}

#[napi]
#[derive(Clone)]
pub struct TextSearchResult {
    pub id: String,
    pub path: String,
    pub score: f64,
    pub snippet: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[napi]
impl SearchIndex {
    /// Create new index at path
    #[napi(constructor)]
    pub fn new(
        index_path: String,
        tokenizer: String,  // "default" | "cjk" | "code" | "natural"
    ) -> Result<Self> { ... }

    /// Open existing index
    #[napi(factory)]
    pub fn open(index_path: String) -> Result<Self> { ... }

    /// Index documents (batch)
    #[napi]
    pub async fn index_batch(
        &mut self,
        docs: Vec<IndexDocument>,
    ) -> Result<u32> { ... }

    /// BM25 search with optional filters
    #[napi]
    pub async fn search(
        &self,
        query: String,
        top_k: u32,
        filters: Option<SearchFilters>,
    ) -> Result<Vec<TextSearchResult>> { ... }

    /// Delete documents by ID
    #[napi]
    pub fn delete_batch(&mut self, ids: Vec<String>) -> Result<u32> { ... }

    /// Commit pending changes
    #[napi]
    pub fn commit(&mut self) -> Result<()> { ... }
}

#[napi]
pub struct IndexDocument {
    pub id: String,
    pub path: String,
    pub text: String,
    pub start_line: u32,
    pub end_line: u32,
    pub metadata: Option<HashMap<String, String>>,
}

#[napi]
pub struct SearchFilters {
    pub path_prefix: Option<String>,
    pub min_score: Option<f64>,
    pub date_after: Option<u64>,
}

// HYBRID SEARCH (combines vector + text in Rust):
#[napi]
pub struct HybridSearchEngine {
    vector_index: VectorIndex,
    text_index: SearchIndex,
    vector_weight: f64,   // Default: 0.7
    text_weight: f64,     // Default: 0.3
}

#[napi]
impl HybridSearchEngine {
    #[napi(constructor)]
    pub fn new(
        vector_path: String,
        text_path: String,
        vector_weight: Option<f64>,
        text_weight: Option<f64>,
    ) -> Result<Self> { ... }

    /// Combined hybrid search
    #[napi]
    pub async fn search(
        &self,
        query_text: String,
        query_vector: Option<Vec<f32>>,
        top_k: u32,
    ) -> Result<Vec<HybridSearchResult>> { ... }
}
```

### Crate 3: `mythos-execution-sandbox`

```rust
// crates/mythos-execution-sandbox/src/lib.rs

use napi_derive::napi;

/// In-process sandbox execution
/// Replaces: openshell CLI fork (100x less overhead)
/// Uses seccomp-bpf + capabilities + namespaces

#[napi]
pub struct Sandbox {
    id: String,
    rootfs: String,
    policy: SandboxPolicy,
}

#[napi]
pub struct SandboxPolicy {
    pub filesystem_readonly: bool,
    pub filesystem_paths: Vec<String>,    // Allowed write paths
    pub network_allow: Vec<String>,       // Allowed hosts/CIDRs
    pub network_deny: Vec<String>,        // Denied hosts/CIDRs
    pub max_memory_mb: u32,
    pub max_cpu_seconds: u32,
    pub max_file_descriptors: u32,
    pub allow_exec: Vec<String>,          // Allowed binaries
    pub deny_exec: Vec<String>,           // Denied binaries
}

#[napi]
#[derive(Clone)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u64,
    pub memory_peak_mb: u32,
}

#[napi]
impl Sandbox {
    /// Create sandbox with policy
    #[napi(constructor)]
    pub fn new(id: String, rootfs: String, policy: SandboxPolicy) -> Result<Self> { ... }

    /// Execute command in sandbox (async)
    #[napi]
    pub async fn exec(
        &self,
        command: String,
        args: Vec<String>,
        env: Option<HashMap<String, String>>,
        cwd: Option<String>,
        timeout_ms: Option<u32>,
    ) -> Result<ExecResult> { ... }

    /// Read file from sandbox
    #[napi]
    pub fn read_file(&self, path: String) -> Result<Buffer> { ... }

    /// Write file to sandbox
    #[napi]
    pub fn write_file(&self, path: String, content: Buffer) -> Result<()> { ... }

    /// List files in sandbox directory
    #[napi]
    pub fn list_dir(&self, path: String) -> Result<Vec<String>> { ... }

    /// Destroy sandbox (cleanup)
    #[napi]
    pub fn destroy(&mut self) -> Result<()> { ... }
}

// YAML Policy Loader
#[napi]
pub fn load_policy_from_yaml(yaml: String) -> Result<SandboxPolicy> { ... }
```

### Crate 4: `mythos-protocol-codec`

```rust
// crates/mythos-protocol-codec/src/lib.rs

use napi_derive::napi;
use simd_json;

/// Zero-copy JSON protocol codec
/// Replaces: JSON.parse() / JSON.stringify() in JS hot paths
/// 5x faster WebSocket frame handling

#[napi]
pub struct ProtocolCodec {
    // Pre-allocated buffers for zero-copy parsing
}

#[napi]
impl ProtocolCodec {
    #[napi(constructor)]
    pub fn new() -> Result<Self> { ... }

    /// Parse JSON frame (zero-copy where possible)
    #[napi]
    pub fn parse_frame(&self, data: Buffer) -> Result<ParsedFrame> { ... }

    /// Serialize response frame
    #[napi]
    pub fn serialize_response(
        &self,
        id: String,
        ok: Option<String>,      // JSON string
        error: Option<ErrorPayload>,
    ) -> Result<Buffer> { ... }

    /// Serialize event frame
    #[napi]
    pub fn serialize_event(
        &self,
        event: String,
        data: String,            // JSON string
    ) -> Result<Buffer> { ... }

    /// Validate frame size
    #[napi]
    pub fn validate_frame_size(
        &self,
        size: u32,
        max_payload: u32,
    ) -> Result<bool> { ... }
}

#[napi]
pub struct ParsedFrame {
    pub frame_type: String,      // "req" | "res" | "event"
    pub id: Option<String>,
    pub method: Option<String>,
    pub event: Option<String>,
    pub params_raw: Option<String>,  // Raw JSON (not parsed)
}
```

### Crate 5: `mythos-causal-graph`

```rust
// crates/mythos-causal-graph/src/lib.rs

use napi_derive::napi;
use petgraph::graph::{DiGraph, NodeIndex};

/// Causal knowledge graph
/// New capability — no JS equivalent
/// Enables L7 memory (causal reasoning)

#[napi]
pub struct CausalGraph {
    graph: DiGraph<GraphNode, GraphEdge>,
    node_index: HashMap<String, NodeIndex>,
}

#[napi]
pub struct GraphNode {
    pub id: String,
    pub node_type: String,       // "fact" | "event" | "entity" | "concept"
    pub content: String,
    pub timestamp: u64,
    pub confidence: f64,         // 0.0-1.0
    pub metadata: HashMap<String, String>,
}

#[napi]
pub struct GraphEdge {
    pub relation: String,        // "caused_by" | "related_to" | "implies" | ...
    pub weight: f64,
    pub timestamp: u64,
    pub source_session: Option<String>,
}

#[napi]
impl CausalGraph {
    #[napi(constructor)]
    pub fn new() -> Result<Self> { ... }

    /// Load from file (JSON or binary)
    #[napi(factory)]
    pub fn load(path: String) -> Result<Self> { ... }

    /// Save to file
    #[napi]
    pub fn save(&self, path: String) -> Result<()> { ... }

    /// Add node
    #[napi]
    pub fn add_node(&mut self, node: GraphNode) -> Result<String> { ... }

    /// Add edge (causal relationship)
    #[napi]
    pub fn add_edge(
        &mut self,
        from_id: String,
        to_id: String,
        relation: String,
        weight: f64,
    ) -> Result<()> { ... }

    /// Query: find causal chains
    #[napi]
    pub fn find_causal_chains(
        &self,
        start_id: String,
        max_depth: u32,
        min_weight: Option<f64>,
    ) -> Result<Vec<CausalPath>> { ... }

    /// Query: find related concepts
    #[napi]
    pub fn find_related(
        &self,
        node_id: String,
        max_results: u32,
    ) -> Result<Vec<GraphNode>> { ... }

    /// Query: temporal reasoning (before/after)
    #[napi]
    pub fn temporal_query(
        &self,
        start_time: u64,
        end_time: u64,
        node_type: Option<String>,
    ) -> Result<Vec<GraphNode>> { ... }

    /// Merge two graphs (CRDT-style)
    #[napi]
    pub fn merge(&mut self, other: &CausalGraph) -> Result<MergeStats> { ... }

    /// Get graph statistics
    #[napi]
    pub fn stats(&self) -> GraphStats { ... }
}

#[napi]
pub struct CausalPath {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub total_weight: f64,
    pub confidence: f64,
}

#[napi]
pub struct GraphStats {
    pub node_count: u64,
    pub edge_count: u64,
    pub node_types: HashMap<String, u64>,
    pub relation_types: HashMap<String, u64>,
}
```

### Crate 6: `mythos-embedding-runtime`

```rust
// crates/mythos-embedding-runtime/src/lib.rs

use napi_derive::napi;
use candle_core::{Device, Tensor};
use candle_transformers::models::bert;

/// GPU-accelerated embedding generation
/// Replaces: node-llama-cpp (CPU-only)
/// 50x faster with Metal/CUDA

#[napi]
pub struct EmbeddingRuntime {
    model: BertModel,
    device: Device,
    tokenizer: Tokenizer,
}

#[napi]
impl EmbeddingRuntime {
    /// Initialize with model path and device
    #[napi(constructor)]
    pub fn new(
        model_path: String,
        device: String,   // "cpu" | "metal" | "cuda"
    ) -> Result<Self> { ... }

    /// Generate embedding for text
    #[napi]
    pub async fn embed(&self, text: String) -> Result<Vec<f32>> { ... }

    /// Batch embedding (much faster than individual calls)
    #[napi]
    pub async fn embed_batch(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> { ... }

    /// Get model info
    #[napi]
    pub fn model_info(&self) -> ModelInfo { ... }

    /// Unload model (free GPU memory)
    #[napi]
    pub fn unload(&mut self) -> Result<()> { ... }
}

#[napi]
pub struct ModelInfo {
    pub name: String,
    pub dimensions: u32,
    pub max_tokens: u32,
    pub device: String,
    pub memory_mb: u32,
}
```

### NAPI Bridge Integration Pattern

```typescript
// TypeScript integration layer — replaces existing JS implementations
// File: src/mythos-native/index.ts

// Graceful fallback: if native module not available, use JS fallback
let nativeVector: typeof import('@openclaw/mythos-vector-engine') | null = null;
let nativeSearch: typeof import('@openclaw/mythos-search-engine') | null = null;
let nativeSandbox: typeof import('@openclaw/mythos-execution-sandbox') | null = null;

try {
  nativeVector = await import('@openclaw/mythos-vector-engine');
} catch {
  // Fall back to sqlite-vec
}

try {
  nativeSearch = await import('@openclaw/mythos-search-engine');
} catch {
  // Fall back to SQLite FTS5
}

// Integration point — manager-search.ts:
export async function searchVector(
  manager: MemoryIndexManager,
  query: number[],
  topK: number
): Promise<MemorySearchResult[]> {
  if (nativeVector) {
    // Native HNSW search (100x faster)
    return nativeVector.search(manager.vectorIndexPath, query, topK);
  }
  // Fallback to sqlite-vec
  return legacySearchVector(manager, query, topK);
}

// Integration point — hybrid.ts:
export async function searchHybrid(
  manager: MemoryIndexManager,
  queryText: string,
  queryVector: number[] | null,
  topK: number
): Promise<MemorySearchResult[]> {
  if (nativeSearch) {
    // Native Tantivy + HNSW hybrid search
    return nativeSearch.hybridSearch(
      manager.textIndexPath,
      manager.vectorIndexPath,
      queryText,
      queryVector,
      topK
    );
  }
  // Fallback to JS implementation
  return legacySearchHybrid(manager, queryText, queryVector, topK);
}
```

---

## X. DEPLOYMENT ARCHITECTURE

### Docker Deployment (Current)

```yaml
# docker-compose.yml — Key structure

services:
  openclaw-gateway:
    image: openclaw:local
    build: .
    environment:
      HOME: /home/node
      OPENCLAW_CONFIG_DIR: /home/node/.openclaw
      OPENCLAW_WORKSPACE_DIR: /home/node/.openclaw/workspace
      OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN}
      TZ: ${OPENCLAW_TZ:-UTC}
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    cap_drop:
      - NET_RAW
      - NET_ADMIN
    security_opt:
      - no-new-privileges:true
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "${OPENCLAW_GATEWAY_PORT:-18789}:18789"
      - "${OPENCLAW_BRIDGE_PORT:-18790}:18790"
    init: true
    restart: unless-stopped
    command: ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "18789"]
    healthcheck:
      test: ["CMD", "node", "-e",
        "fetch('http://127.0.0.1:18789/healthz').then(r=>process.exit(r.ok?0:1))"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### Dockerfile — Multi-Stage Build

```dockerfile
# Stage 1: ext-deps (plugin dependency extraction)
FROM node:24-bookworm AS ext-deps

# Stage 2: bun-binary (pin Bun version)
FROM oven/bun:1.3.13 AS bun-binary

# Stage 3: build (full Node.js + Bun for building)
FROM node:24-bookworm AS build
# Install deps, compile TypeScript, build UI

# Stage 4: runtime (slim image)
FROM node:24-bookworm-slim AS runtime
# Only dist/, node_modules (production), and runtime scripts
# No build tools, no source code, no Bun
```

### Mythos-Class Fleet Deployment (K8s)

```yaml
# k8s/mythos-fleet.yaml — Production Kubernetes deployment

apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mythos-gateway
spec:
  replicas: 3  # Gateway cluster
  template:
    spec:
      containers:
      - name: gateway
        image: openclaw-mythos:latest  # With Rust native modules
        ports:
        - containerPort: 18789
          name: gateway
        - containerPort: 18793
          name: canvas
        resources:
          requests:
            memory: "2Gi"
            cpu: "1000m"
          limits:
            memory: "8Gi"
            cpu: "4000m"
            nvidia.com/gpu: "1"       # For local embedding
        volumeMounts:
        - name: config
          mountPath: /home/node/.openclaw
        - name: workspace
          mountPath: /home/node/.openclaw/workspace
        - name: memory-store
          mountPath: /data/memory       # Persistent Rust vector store
        - name: graph-store
          mountPath: /data/graph        # Persistent causal graph
        env:
        - name: OPENCLAW_GATEWAY_TOKEN
          valueFrom:
            secretKeyRef:
              name: mythos-secrets
              key: gateway-token
        - name: MYTHOS_VECTOR_ENGINE
          value: "native"
        - name: MYTHOS_SEARCH_ENGINE
          value: "native"
        - name: MYTHOS_EMBEDDING_DEVICE
          value: "cuda"

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: memory-store
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 50Gi

---
apiVersion: v1
kind: Service
metadata:
  name: mythos-gateway
spec:
  selector:
    app: mythos-gateway
  ports:
  - port: 18789
    name: gateway
  - port: 18793
    name: canvas
```

### NemoClaw Enterprise Pattern (YAML Policies)

```yaml
# nemoclaw-policies/mythos-prime.yaml
agents:
  mythos-prime:
    sandbox:
      backend: "openshell"
      filesystem: "/sandbox/prime"
      network:
        allow: ["api.anthropic.com", "api.openai.com"]
        deny: ["*"]
    tools:
      allow: ["sessions_spawn", "sessions_steer", "memory_search", "web_search"]
      deny: ["exec", "bash"]  # Orchestrator never executes directly
    model:
      provider: "anthropic"
      model: "claude-opus-4"
    audit:
      log_level: "full"
      destination: "s3://mythos-audit-logs"

---
# nemoclaw-policies/mythos-code.yaml
agents:
  mythos-code:
    sandbox:
      backend: "openshell"
      filesystem: "/sandbox/code"
      docker:
        enabled: true
        image: "node:22-alpine"
    tools:
      allow: ["exec", "write", "read", "browser_*", "web_fetch"]
      deny: ["sessions_spawn"]  # Workers can't spawn workers
    model:
      provider: "anthropic"
      model: "claude-opus-4"

---
# nemoclaw-policies/mythos-memory.yaml
agents:
  mythos-memory:
    sandbox:
      backend: "openshell"
      filesystem: "/sandbox/memory"
      network:
        allow: []  # Fully local — no egress
    tools:
      allow: ["memory_search", "memory_get", "wiki_*", "read", "write"]
      deny: ["exec", "browser_*", "web_*"]
    model:
      provider: "local"
      model: "nemotron-70b"  # Local inference for privacy
```

### Fleet Topology Diagram

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                    MYTHOS-CLASS PRODUCTION DEPLOYMENT                         ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║  GATEWAY CLUSTER (K8s StatefulSet, 3 replicas)                                ║
║  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                          ║
║  │ Gateway α   │  │ Gateway β   │  │ Gateway γ   │                          ║
║  │ Port 18789  │  │ Port 18789  │  │ Port 18789  │                          ║
║  │ Rust codec  │  │ Rust codec  │  │ Rust codec  │                          ║
║  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                          ║
║         └────────────────┼────────────────┘                                   ║
║                          │                                                     ║
║  ════════════════════════╪═══════════════════════════════                     ║
║  RUST NATIVE LAYER       │                                                     ║
║  ┌───────────────────────┼──────────────────────────────────────────┐         ║
║  │ mythos-vector-engine  │  HNSW (usearch) — 100x faster           │         ║
║  │ mythos-search-engine  │  Tantivy BM25 — 10x faster              │         ║
║  │ mythos-embed-runtime  │  Candle (GPU) — 50x faster              │         ║
║  │ mythos-causal-graph   │  petgraph — L7 memory (new)             │         ║
║  │ mythos-exec-sandbox   │  seccomp-bpf — 100x less overhead       │         ║
║  │ mythos-protocol-codec │  simd-json — 5x WS throughput           │         ║
║  └──────────────────────────────────────────────────────────────────┘         ║
║                                                                               ║
║  ════════════════════════════════════════════════════════                     ║
║  PERSISTENT STORAGE                                                           ║
║  ┌──────────────────────────────────────────────────────────────┐            ║
║  │ /data/memory/   — Vector index (50GB, HNSW binary format)   │            ║
║  │ /data/graph/    — Causal graph (CRDT, mergeable)             │            ║
║  │ /data/search/   — Tantivy index (BM25)                       │            ║
║  │ /data/config/   — OpenClaw config + sessions                 │            ║
║  │ /data/workspace/ — Agent workspace files                     │            ║
║  └──────────────────────────────────────────────────────────────┘            ║
║                                                                               ║
║  ════════════════════════════════════════════════════════                     ║
║  EXTERNAL CONNECTIVITY                                                        ║
║  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          ║
║  │ Tailscale│ │ Telegram │ │ Discord  │ │ Slack    │ │ GitHub   │          ║
║  │ (mesh)   │ │ Bot API  │ │ Bot API  │ │ Bolt     │ │ Webhooks │          ║
║  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘          ║
║                                                                               ║
║  ════════════════════════════════════════════════════════                     ║
║  NODE TOPOLOGY                                                                ║
║  ┌────────────────────────────────────────────────────────────┐              ║
║  │ Mac mini M4 (always-on gateway + macOS node)               │              ║
║  │   ├── Gateway process (launchd managed)                    │              ║
║  │   ├── macOS App (menu bar, PeekabooBridge)                 │              ║
║  │   ├── Browser (Chromium, 3 profiles)                       │              ║
║  │   └── Canvas Host (:18793)                                 │              ║
║  │ iPhone (iOS app, node role)                                │              ║
║  │   ├── Camera, Location, HealthKit                          │              ║
║  │   ├── Talk PTT (WebRTC when foreground)                    │              ║
║  │   └── Canvas (WKWebView)                                   │              ║
║  │ Android (Android app, node role)                            │              ║
║  │   ├── Camera, Location, SMS                                │              ║
║  │   └── Notifications                                        │              ║
║  │ Apple Watch (companion relay)                               │              ║
║  └────────────────────────────────────────────────────────────┘              ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

---

## SUMMARY: THE COMPLETE RUST POLYGLOT SURFACE

### Integration Priority Matrix

| Priority | Crate | Replaces | Speed Gain | Effort | Impact |
|---|---|---|---|---|---|
| **P0** | `mythos-vector-engine` | sqlite-vec | 100x | Medium | Memory search |
| **P0** | `mythos-search-engine` | SQLite FTS5 | 10x | Medium | Hybrid search |
| **P1** | `mythos-embedding-runtime` | node-llama-cpp | 50x | High | Local embedding |
| **P1** | `mythos-execution-sandbox` | openshell CLI | 100x | High | Sandbox perf |
| **P2** | `mythos-protocol-codec` | JSON.parse | 5x | Low | WS throughput |
| **P2** | `mythos-causal-graph` | *(new)* | N/A | High | L7 memory |

### Build Integration

```toml
# Root Cargo.toml (workspace)
[workspace]
members = ["crates/*"]
resolver = "2"

[workspace.dependencies]
napi = { version = "2.16", features = ["async", "serde-json", "tokio_rt"] }
napi-derive = "2.16"
tokio = { version = "1.40", features = ["full"] }

# napi-build handles the Node.js native module compilation
# Output: .node files that can be imported from TypeScript
```

```json
// package.json additions
{
  "optionalDependencies": {
    "@openclaw/mythos-vector-engine": "workspace:*",
    "@openclaw/mythos-search-engine": "workspace:*",
    "@openclaw/mythos-execution-sandbox": "workspace:*",
    "@openclaw/mythos-protocol-codec": "workspace:*",
    "@openclaw/mythos-causal-graph": "workspace:*",
    "@openclaw/mythos-embedding-runtime": "workspace:*"
  }
}
```

---

> 🦞→🏛️ **PART II COMPLETE.**
>
> Every wire frame. Every session key. Every system prompt component. Every config type. Every voice pipeline stage. Every hook event. Every browser action. Every Rust crate API. Every deployment topology.
>
> The lobster has titanium claws. 🦞⚡🏛️
