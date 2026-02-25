# Architektur-Analyse: Activi

## 1. Übersicht

Activi ist ein **Multi-Channel AI Gateway** mit einer modularen, erweiterbaren Architektur. Das System basiert auf einem zentralen Gateway-Prozess (Control Plane), der über WebSocket mit verschiedenen Clients kommuniziert.

### Kernprinzipien

- **Single Gateway Process**: Ein langlaufender Gateway-Prozess besitzt alle Messaging-Verbindungen
- **WebSocket als Control Plane**: Alle Clients (CLI, Web UI, Apps, Nodes) kommunizieren über WebSocket
- **Modulare Erweiterbarkeit**: Plugin-System für Channels, Tools, Skills
- **Self-Hosted**: Gateway läuft lokal, keine Cloud-Abhängigkeit
- **Multi-Agent Support**: Mehrere isolierte Agent-Workspaces mit eigenem Session-Management

## 2. Architektur-Komponenten

### 2.1 Gateway (Control Plane)

**Rolle:** Zentrale Steuerungsebene für alle Messaging-Channels und Agent-Operationen

**Komponenten:**
- **WebSocket Server** (`src/gateway/server.ts`, `src/gateway/server.impl.ts`)
  - Port: Standard `127.0.0.1:18789` (konfigurierbar)
  - Protokoll: WebSocket mit JSON-Frames
  - Typisiertes Request/Response/Event-System
  
- **HTTP Server** (`src/gateway/server-http.ts`)
  - Control UI: `/` (Web-Interface)
  - Canvas Host: `/__activi__/canvas/` (Agent-editierbare HTML/CSS/JS)
  - A2UI Host: `/__activi__/a2ui/` (A2UI Renderer)
  - OpenAI-compatible API: `/v1/chat/completions` (optional)
  - OpenResponses API: `/v1/responses` (optional)

- **Channel Manager** (`src/gateway/server-channels.ts`)
  - Verwaltet alle Messaging-Channel-Verbindungen
  - Startet/Stoppt Channel-Monitore
  - Health-Monitoring für Channels

- **Agent Event Handler** (`src/gateway/server-chat.ts`)
  - Verarbeitet eingehende Nachrichten
  - Routet Nachrichten zu Agents
  - Verwaltet Agent-Runs und Streaming

- **Node Registry** (`src/gateway/node-registry.ts`)
  - Verwaltet verbundene Nodes (iOS/Android/macOS)
  - Device-basierte Pairing
  - Node-Command-Routing

**Datenfluss:**
```
Messaging Channel (WhatsApp/Telegram/etc.)
    ↓
Channel Monitor
    ↓
Gateway (WebSocket Server)
    ↓
Agent Event Handler
    ↓
Agent Session
    ↓
LLM Provider
```

### 2.2 Agents (AI Runtime)

**Rolle:** AI-Agent-Execution mit Tool-Support und Session-Management

**Komponenten:**
- **Pi Embedded Runner** (`src/agents/pi-embedded-runner/`)
  - Integriert `@mariozechner/pi-coding-agent` direkt (nicht als Subprocess)
  - `createAgentSession()` für Agent-Instanzen
  - Custom Tool-Injection (Messaging, Browser, etc.)
  
- **Agent Tools** (`src/agents/activi-tools.ts`)
  - Messaging-Tools (`send`, `reply`)
  - Browser-Tools (`browser.*`)
  - Node-Tools (`camera.*`, `screen.*`, `location.*`)
  - Session-Tools (`session.*`)
  - Memory-Tools (`memory.*`)

- **System Prompt Builder** (`src/agents/system-prompt.ts`)
  - Dynamische System-Prompt-Generierung
  - Channel-spezifische Anpassungen
  - Skill-Integration

- **Session Management** (`src/config/sessions.ts`)
  - Session-Store (`sessions.json`)
  - Transcript-Persistenz (`*.jsonl`)
  - Session-Routing basierend auf Channel/Peer/Group

**Architektur-Pattern:**
- **Embedded Agent**: Pi SDK wird direkt importiert, nicht als Subprocess
- **Tool Injection**: Activi-spezifische Tools werden zur Pi-Tool-Liste hinzugefügt
- **Session Isolation**: Jeder Agent hat isolierte Workspaces und Session-Stores

### 2.3 Channels (Messaging Integrations)

**Rolle:** Integration verschiedener Messaging-Plattformen

**Unterstützte Channels:**
- **Core Channels** (im Haupt-Repo):
  - WhatsApp (`src/channel-web.ts`, Baileys)
  - Telegram (`src/telegram/`, grammY)
  - Discord (`src/discord/`, discord.js)
  - Slack (`src/slack/`, Bolt SDK)
  - Signal (`src/signal/`, signal-cli)
  - iMessage (`src/imessage/`, legacy)
  - WebChat (`src/channels/web/`)

- **Extension Channels** (Plugins):
  - Microsoft Teams (`extensions/msteams/`)
  - Matrix (`extensions/matrix/`)
  - LINE (`extensions/line/`)
  - Zalo (`extensions/zalo/`)
  - BlueBubbles (`extensions/bluebubbles/`)
  - Und weitere...

**Channel-Struktur:**
```
src/channels/
├── registry.ts          # Channel-Registry
├── plugins/
│   ├── index.ts         # Plugin-Loader
│   ├── inbound/         # Inbound-Message-Handler
│   └── outbound/         # Outbound-Message-Sender
├── telegram/
├── discord/
├── slack/
└── ...
```

**Channel-Lifecycle:**
1. **Discovery**: Channel-Plugins werden beim Gateway-Start geladen
2. **Initialization**: Channel-Monitor wird gestartet
3. **Monitoring**: Eingehende Nachrichten werden erkannt
4. **Routing**: Nachrichten werden zu Agents geroutet
5. **Response**: Agent-Antworten werden zurück an Channel gesendet

### 2.4 Plugins & Extensions

**Rolle:** Erweiterbares Plugin-System für Channels, Tools, Skills

**Plugin-Typen:**
- **Channel Plugins**: Neue Messaging-Channels
- **Tool Plugins**: Zusätzliche Agent-Tools
- **Skill Plugins**: Agent-Skills (Dokumentation für Agent-Verhalten)
- **Hook Plugins**: Event-Hooks (Pre/Post Agent-Run, etc.)

**Plugin-Discovery:**
1. Config Paths (`plugins.load.paths`)
2. Workspace Extensions (`<workspace>/.activi/extensions/`)
3. Global Extensions (`~/.activi/extensions/`)
4. Bundled Extensions (`<activi>/extensions/`) - **disabled by default**

**Plugin-Manifest:**
- `activi.plugin.json` (Pflicht)
- Definiert: ID, Name, Version, Entry Points
- Kann registrieren: Gateway RPC Methods, HTTP Handlers, Agent Tools, CLI Commands

**Code-Struktur:**
```
extensions/
├── msteams/
│   ├── activi.plugin.json
│   ├── src/
│   │   ├── channel.ts      # Channel-Integration
│   │   ├── monitor.ts      # Message-Monitoring
│   │   └── send.ts         # Outbound-Messages
│   └── package.json
└── ...
```

### 2.5 Skills System

**Rolle:** Dokumentation und Anweisungen für Agent-Verhalten

**Skill-Struktur:**
- **SKILL.md** mit YAML Frontmatter
- Beschreibt: Tools, Patterns, Best Practices
- Wird in System-Prompt integriert

**Skill-Locations:**
1. Workspace Skills (`<workspace>/skills/`) - **höchste Priorität**
2. Project Agents Skills (`<workspace>/.agents/skills/`)
3. Personal Agents Skills (`~/.agents/skills/`)
4. Managed Skills (`~/.activi/skills/`)
5. Bundled Skills (`<activi>/skills/`) - **niedrigste Priorität**

**Skill-Loading:**
- Skills werden beim Agent-Start geladen
- In System-Prompt integriert
- Watch-Mode für Auto-Reload

### 2.6 Session & Memory Management

**Rolle:** Persistente Session-Verwaltung und Memory-System

**Session-Struktur:**
- **Session Store** (`sessions.json`):
  - Key: `sessionKey` (z.B. `agent:main:main`)
  - Value: `SessionEntry` (Metadata, Token-Counts, Flags)
  
- **Transcript** (`<sessionId>.jsonl`):
  - Append-only JSONL-Format
  - Tree-Struktur (`id` + `parentId`)
  - Enthält: Messages, Tool-Calls, Results

**Session-Routing:**
- **Direct Messages**: `agent:<agentId>:<mainKey>` (default: `agent:main:main`)
- **Groups**: `agent:<agentId>:<channel>:group:<id>`
- **Channels/Rooms**: `agent:<agentId>:<channel>:channel:<id>`
- **Threads**: Append `:thread:<threadId>` oder `:topic:<topicId>`

**Memory-System:**
- **Vector Database**: sqlite-vec für Semantic Search
- **Memory Index**: `src/memory/manager.ts`
- **Memory Search**: Semantic Search über Embeddings
- **Memory Flush**: Pre-Compaction Memory-Writes

**Compaction:**
- **Auto-Compaction**: Bei Token-Limit
- **Manual Compaction**: Via CLI/API
- **Pre-Compaction Hooks**: Memory-Flush vor Compaction

### 2.7 Nodes (Device Integration)

**Rolle:** Native Device-Integration für iOS/macOS/Android

**Node-Typen:**
- **macOS Node**: Menubar-App, Voice Wake, Canvas
- **iOS Node**: Mobile App, Camera, Location, Screen Recording
- **Android Node**: Mobile App, Camera, Location, SMS

**Node-Connection:**
- WebSocket-Verbindung mit `role: "node"`
- Device-Identity im `connect`-Request
- Device-basierte Pairing (nicht User-basiert)
- Commands: `canvas.*`, `camera.*`, `screen.*`, `location.*`

**Node-Discovery:**
- **Bonjour**: LAN-Discovery
- **Tailscale**: Tailnet-Discovery
- **SSH Tunnel**: Fallback für Remote-Access

### 2.8 Configuration System

**Rolle:** Zentrale Konfigurationsverwaltung

**Config-Struktur:**
- **Config File**: `~/.activi/activi.json` (JSON5-Format)
- **Config Schema**: TypeBox-basiert (`src/config/zod-schema.ts`)
- **Config Types**: TypeScript-Types (`src/config/types.activi.ts`)

**Config-Bereiche:**
- `gateway.*`: Gateway-Konfiguration (Bind, Auth, etc.)
- `agents.*`: Agent-Konfiguration (Workspaces, System-Prompts)
- `channels.*`: Channel-Konfiguration (Accounts, Routing)
- `models.*`: LLM-Provider-Konfiguration
- `plugins.*`: Plugin-Konfiguration
- `session.*`: Session-Konfiguration
- `memory.*`: Memory-Konfiguration
- `tools.*`: Tool-Konfiguration
- `hooks.*`: Hook-Konfiguration
- `cron.*`: Cron-Job-Konfiguration

**Config-Features:**
- `$include`: Include andere Config-Dateien
- `${ENV}`: Environment-Variable-Substitution
- Validation: JSON Schema-basierte Validierung
- Migration: Automatische Config-Migrationen

## 3. Datenflüsse

### 3.1 Inbound Message Flow

```
Messaging Channel (WhatsApp/Telegram/etc.)
    ↓
Channel Monitor (detects new message)
    ↓
Gateway WebSocket Server
    ↓
Agent Event Handler (routes to agent)
    ↓
Session Resolution (determines sessionKey)
    ↓
Agent Session (loads context)
    ↓
System Prompt Builder (adds channel context)
    ↓
Pi Agent Runtime (processes message)
    ↓
Tool Execution (if needed)
    ↓
LLM Provider (generates response)
    ↓
Response Routing (back to originating channel)
    ↓
Channel Send Handler
    ↓
Messaging Channel (delivers message)
```

### 3.2 Agent Run Flow

```
Gateway receives agent request
    ↓
Resolve Session (sessionKey, agentId)
    ↓
Load Session Store (sessions.json)
    ↓
Load Transcript (<sessionId>.jsonl)
    ↓
Build System Prompt (channel context, skills)
    ↓
Create Agent Session (Pi SDK)
    ↓
Inject Activi Tools
    ↓
Run Agent Loop (Pi Agent Runtime)
    ↓
Stream Events (agent.* events via WebSocket)
    ↓
Tool Calls (execute tools)
    ↓
LLM Calls (stream responses)
    ↓
Save Transcript (append to .jsonl)
    ↓
Update Session Store (token counts, timestamps)
    ↓
Return Final Result
```

### 3.3 Node Command Flow

```
Node (iOS/Android/macOS) sends command
    ↓
WebSocket Connection (role: "node")
    ↓
Gateway Node Registry
    ↓
Node Command Handler (canvas.*, camera.*, etc.)
    ↓
Execute Command (device-specific implementation)
    ↓
Return Result (via WebSocket)
    ↓
Node receives result
```

## 4. Architektur-Patterns

### 4.1 Gateway Pattern

**Pattern:** Single Gateway Process als Control Plane

**Vorteile:**
- Zentrale State-Verwaltung
- Einheitliche API für alle Clients
- Einfaches Monitoring und Logging

**Implementierung:**
- Langlaufender Node.js-Prozess
- WebSocket-Server für alle Clients
- Event-basierte Kommunikation

### 4.2 Plugin Pattern

**Pattern:** Erweiterbares Plugin-System

**Vorteile:**
- Modulare Architektur
- Einfache Erweiterbarkeit
- Isolierte Features

**Implementierung:**
- Runtime Plugin-Loading (jiti)
- Plugin-Manifest-System
- API für Plugin-Registrierung

### 4.3 Session Pattern

**Pattern:** Isolierte Agent-Sessions mit Persistenz

**Vorteile:**
- Context-Isolation zwischen Agents
- Persistente Conversation-History
- Flexible Session-Routing

**Implementierung:**
- Session-Store (sessions.json)
- Transcript-Files (*.jsonl)
- Session-Key-Routing

### 4.4 Tool Pattern

**Pattern:** Injectable Tools für Agents

**Vorteile:**
- Erweiterbare Tool-Funktionalität
- Channel-spezifische Tools
- Node-Integration

**Implementierung:**
- Tool-Registry
- Tool-Injection in Pi Agent
- Tool-Execution-Handler

### 4.5 Event-Driven Pattern

**Pattern:** Event-basierte Kommunikation über WebSocket

**Vorteile:**
- Real-time Updates
- Loose Coupling
- Skalierbare Architektur

**Implementierung:**
- WebSocket Events (`agent.*`, `chat.*`, `presence.*`)
- Event-Subscriptions
- Server-Push für Updates

## 5. Technologie-Stack

### 5.1 Core Runtime

- **Node.js**: >= 22.12.0 (ESM)
- **TypeScript**: Strict Mode, Type-Safety
- **Express.js**: HTTP Server
- **ws**: WebSocket Server

### 5.2 AI/ML

- **Pi SDK**: `@mariozechner/pi-coding-agent` (embedded)
- **LLM Providers**: Anthropic, OpenAI, OpenRouter, etc.
- **Vector DB**: sqlite-vec (HNSW Indexing)

### 5.3 Messaging Libraries

- **Baileys**: WhatsApp
- **grammY**: Telegram
- **discord.js**: Discord
- **Bolt SDK**: Slack
- **signal-cli**: Signal

### 5.4 Native Apps

- **Swift**: iOS/macOS Apps
- **Kotlin**: Android App
- **SwiftUI**: iOS/macOS UI
- **Jetpack Compose**: Android UI

### 5.5 Web UI

- **Lit**: Web Components
- **React**: Control UI (optional)
- **Playwright**: Browser Automation

### 5.6 Build Tools

- **tsdown**: TypeScript Compiler
- **pnpm**: Package Manager
- **Vitest**: Testing Framework
- **Oxlint/Oxfmt**: Linting/Formatting

## 6. Skalierung & Performance

### 6.1 Gateway Skalierung

- **Single Process**: Ein Gateway-Prozess pro Host
- **Multi-Agent**: Mehrere isolierte Agents parallel
- **Concurrency**: Agent-Runs können parallel laufen
- **Lane System**: Concurrency-Limits pro Agent

### 6.2 Session Management

- **In-Memory**: Aktive Sessions im Memory
- **Persistent**: Transcripts auf Disk (JSONL)
- **Compaction**: Automatische Token-Optimierung
- **Pruning**: Tool-Result-Pruning vor LLM-Calls

### 6.3 Memory System

- **Vector Search**: HNSW Indexing (150x schneller)
- **Quantization**: 4-32x Memory-Reduktion
- **Caching**: Memory-Cache für häufige Queries
- **Batch Operations**: Batch-Embeddings für Performance

### 6.4 Channel Performance

- **Connection Pooling**: Wiederverwendung von Connections
- **Rate Limiting**: Channel-spezifische Rate-Limits
- **Retry Logic**: Automatische Retries bei Fehlern
- **Health Monitoring**: Channel-Health-Checks

## 7. Sicherheit

### 7.1 Authentication

- **Gateway Auth**: Token-basierte Authentifizierung
- **Device Pairing**: Device-basierte Pairing für Nodes
- **Local Trust**: Auto-Approval für Localhost
- **Remote Auth**: Explizite Approval für Remote-Connections

### 7.2 Authorization

- **Scopes**: Role-basierte Scopes (`operator.read`, `operator.write`)
- **Channel Allowlists**: User/Channel-Allowlists
- **Command Authorization**: Command-basierte Authorization
- **Tool Policy**: Tool-Execution-Policies

### 7.3 Security Features

- **Sandboxing**: Tool-Sandboxing für Code-Execution
- **TLS Pinning**: Optional TLS-Pinning für Remote-Connections
- **Rate Limiting**: Auth-Rate-Limiting gegen Brute-Force
- **Input Validation**: JSON Schema-basierte Validierung

## 8. Erweiterbarkeit

### 8.1 Plugin-Erweiterbarkeit

- **Channel Plugins**: Neue Messaging-Channels
- **Tool Plugins**: Zusätzliche Agent-Tools
- **Skill Plugins**: Agent-Verhaltens-Dokumentation
- **Hook Plugins**: Event-Hooks

### 8.2 Config-Erweiterbarkeit

- **Custom Config**: Erweiterbare Config-Schema
- **Plugin Config**: Plugin-spezifische Config
- **Environment Variables**: Env-Var-Substitution
- **Config Includes**: Config-File-Includes

### 8.3 Tool-Erweiterbarkeit

- **Custom Tools**: Plugin-basierte Tools
- **Node Commands**: Device-spezifische Commands
- **Browser Tools**: Browser-Automation-Tools
- **CLI Tools**: Command-Line-Tools

## 9. Deployment & Operations

### 9.1 Installation

- **npm/pnpm**: Global Install
- **Git Checkout**: Source Install
- **Docker**: Containerized Install
- **Nix**: Declarative Install

### 9.2 Process Management

- **Foreground**: Terminal-Mode
- **Background**: launchd/systemd
- **Supervision**: Auto-Restart bei Crashes
- **Health Checks**: Gateway-Health-Monitoring

### 9.3 Remote Access

- **Tailscale**: Preferred (Tailnet-Exposure)
- **SSH Tunnel**: Fallback
- **VPN**: Alternative
- **TLS**: Optional TLS für Remote-Connections

### 9.4 Monitoring

- **Health Endpoint**: `/health` über WebSocket
- **Status Command**: `activi status`
- **Logging**: Structured Logging (tslog)
- **Diagnostics**: Diagnostic-Events für Debugging

## 10. Architektur-Stärken

- ✅ **Modulare Architektur**: Klare Trennung von Concerns
- ✅ **Erweiterbarkeit**: Plugin-System für einfache Erweiterungen
- ✅ **Type-Safety**: TypeScript mit strikter Typisierung
- ✅ **Self-Hosted**: Keine Cloud-Abhängigkeit
- ✅ **Multi-Platform**: iOS/macOS/Android/Linux/Windows
- ✅ **Real-time**: WebSocket-basierte Real-time-Kommunikation
- ✅ **Persistenz**: Robuste Session- und Memory-Persistenz
- ✅ **Skalierbarkeit**: Multi-Agent-Support mit Concurrency-Control

## 11. Architektur-Schwächen

- ⚠️ **Single Gateway Process**: Keine horizontale Skalierung
- ⚠️ **State im Gateway**: State ist nicht verteilt
- ⚠️ **Plugin-Sicherheit**: Plugins laufen in-process (trusted code)
- ⚠️ **Session-Storage**: File-basiert (nicht für große Skalierung)
- ⚠️ **Memory-Performance**: Vector-Search kann bei großen Indices langsam sein

## 12. Verbesserungsvorschläge

### 12.1 Skalierung

- **Distributed Gateway**: Multi-Gateway-Support mit State-Sync
- **Database Backend**: Optional Database für Session-Storage
- **Redis Integration**: Redis für Shared State (bereits optional vorhanden)

### 12.2 Performance

- **Connection Pooling**: Erweiterte Connection-Pooling-Strategien
- **Caching**: Erweiterte Caching-Strategien
- **Batch Processing**: Batch-Processing für Bulk-Operations

### 12.3 Sicherheit

- **Plugin Sandboxing**: Isolierte Plugin-Execution
- **Rate Limiting**: Erweiterte Rate-Limiting-Strategien
- **Audit Logging**: Detailliertes Audit-Logging

## Zusammenfassung

Activi verwendet eine **modulare, event-driven Architektur** mit einem zentralen Gateway-Prozess als Control Plane. Das System ist **erweiterbar** durch Plugins, **skalierbar** durch Multi-Agent-Support, und **self-hosted** für maximale Kontrolle. Die Architektur ist **gut dokumentiert** und folgt **best practices** für TypeScript/Node.js-Entwicklung.

Die Hauptstärken sind die **modulare Struktur**, **erweiterbare Plugin-Architektur**, und **robuste Session/Memory-Verwaltung**. Die Hauptschwächen sind die **Single-Process-Architektur** (keine horizontale Skalierung) und **File-basierte Session-Storage** (nicht für sehr große Skalierung optimiert).
