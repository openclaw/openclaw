# Moltbot Code Audit Report

## Executive Summary

**Project:** Moltbot - Personal AI Assistant Platform
**Version:** 2026.1.27-beta.1
**License:** MIT
**Runtime:** Node.js 22+
**Language:** TypeScript (ESM)

Moltbot is a comprehensive personal AI assistant platform providing a unified interface across multiple messaging channels (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Matrix, MS Teams, and more). The codebase demonstrates enterprise-grade architecture with strong typing, extensive test coverage, and modular plugin systems.

---

## 1. Project Statistics

| Metric | Value |
|--------|-------|
| **Total TypeScript Files** | ~2,500 |
| **Source Files (non-test)** | ~1,615 |
| **Test Files** | ~885 |
| **Total Lines of Code** | ~412,000 |
| **Test-to-Source Ratio** | 59% |
| **Extensions/Plugins** | 31 |
| **Skills** | 35+ |
| **Messaging Channels** | 17+ |
| **Coverage Threshold** | 70% |

---

## 2. Architecture Overview

### 2.1 High-Level Structure

```
moltbot/
├── src/                    # Core TypeScript source (~258K LOC)
│   ├── agents/            # AI agent system (Pi integration)
│   ├── cli/               # CLI framework (Commander.js)
│   ├── commands/          # CLI command implementations
│   ├── gateway/           # Multi-protocol gateway server
│   ├── channels/          # Channel abstraction layer
│   ├── config/            # Configuration management
│   ├── infra/             # Infrastructure utilities
│   ├── media/             # Media processing pipeline
│   ├── plugins/           # Plugin system core
│   └── [channel dirs]/    # Channel implementations
├── extensions/            # Plugin ecosystem (31 plugins)
├── apps/                  # Native applications
│   ├── ios/              # iOS app (Swift)
│   ├── android/          # Android app (Kotlin)
│   ├── macos/            # macOS app (Swift)
│   └── shared/           # Shared mobile code
├── skills/               # Agent skills (35+)
├── docs/                 # Mintlify documentation
├── ui/                   # Web control UI
└── packages/             # npm workspaces
```

### 2.2 Core Subsystems

| Subsystem | Directory | Files | Purpose |
|-----------|-----------|-------|---------|
| Agents | `src/agents/` | 223 | AI agent orchestration, Pi integration, tools, sandbox |
| CLI | `src/cli/` | 137 | Command-line interface framework |
| Commands | `src/commands/` | 169 | CLI command implementations |
| Gateway | `src/gateway/` | 131 | HTTP/WebSocket server, session management |
| Channels | `src/channels/` | 77 | Multi-channel abstraction and routing |
| Config | `src/config/` | 87 | Configuration loading and validation |
| Infrastructure | `src/infra/` | 116 | System utilities, networking, security |
| Plugins | `src/plugins/` | 29 | Plugin loading and registry |
| Media | `src/media/` | 11 | Media processing (images, audio, video, PDF) |

---

## 3. Technology Stack

### 3.1 Runtime Dependencies (Key)

| Category | Libraries |
|----------|-----------|
| **AI/LLM** | `@mariozechner/pi-agent-core` (0.49.3), `@mariozechner/pi-ai`, `@agentclientprotocol/sdk` |
| **Messaging** | `@whiskeysockets/baileys` (WhatsApp), `grammy` (Telegram), `@slack/bolt`, `discord-api-types`, `@line/bot-sdk` |
| **HTTP/Web** | `hono` (4.11.4), `express` (5.2.1), `undici` (7.19.0), `ws` (WebSockets) |
| **Media** | `sharp` (0.34.5), `pdfjs-dist` (5.4.530), `file-type` |
| **CLI/TUI** | `commander` (14.0.2), `@clack/prompts`, `chalk`, `osc-progress` |
| **Data** | `zod` (4.3.6), `yaml`, `json5`, `sqlite-vec` |
| **System** | `@homebridge/ciao` (mDNS), `chokidar`, `proper-lockfile` |

### 3.2 Development Dependencies

| Tool | Version | Purpose |
|------|---------|---------|
| TypeScript | 5.9.3 | Language compiler |
| Vitest | 4.0.18 | Test framework |
| Oxlint | 1.41.0 | Linting |
| Oxfmt | 0.26.0 | Formatting |
| Rolldown | 1.0.0-rc.1 | Bundler |
| Playwright | 1.58.0 | Browser automation |

### 3.3 Optional Dependencies

- `@napi-rs/canvas` - Canvas rendering for PDF processing
- `node-llama-cpp` - Local LLM inference

---

## 4. Messaging Channel Architecture

### 4.1 Supported Channels

| Channel | Type | Capabilities |
|---------|------|--------------|
| WhatsApp | Core | DM, Group, Polls, Reactions, Media |
| Telegram | Core | DM, Group, Channel, Polls, Reactions, Edit, Media |
| Discord | Core | DM, Channel, Thread, Polls, Reactions, Media |
| Slack | Core | DM, Channel, Thread, Reactions, Media |
| Signal | Core | DM, Group, Edit, Media |
| iMessage | Core | DM, Group, Reactions, Media |
| MS Teams | Extension | DM, Channel, Thread, Reactions, Media |
| Matrix | Extension | DM, Channel, Thread, Reactions, Media, Group Mgmt |
| Google Chat | Extension | DM, Channel, Media |
| LINE | Extension | DM, Group, Reactions, Media |
| Mattermost | Extension | DM, Channel, Thread, Reactions, Media |
| Nextcloud Talk | Extension | DM, Channel, Reactions, Threads, Media |

### 4.2 Channel Plugin Interface

All channels implement the `ChannelPlugin<ResolvedAccount>` interface with 20+ adapter interfaces:

```typescript
type ChannelPlugin<ResolvedAccount> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter;
  setup?: ChannelSetupAdapter;
  pairing?: ChannelPairingAdapter;
  security?: ChannelSecurityAdapter;
  outbound?: ChannelOutboundAdapter;
  gateway?: ChannelGatewayAdapter;
  // ... 15+ more adapters
}
```

### 4.3 Routing System

The routing system supports:
- Multi-account configurations per channel
- Agent-to-channel bindings
- Guild/Team awareness (Discord/Teams)
- Peer-specific routing
- Default agent fallback

---

## 5. CLI System

### 5.1 Framework

- **Base:** Commander.js (v14.0.2)
- **Entry Point:** `moltbot.mjs` → `src/entry.ts` → `src/cli/run-main.ts`
- **Pattern:** Registration-based with lazy loading

### 5.2 Command Categories

| Category | Commands | Description |
|----------|----------|-------------|
| Setup | `setup`, `onboard`, `configure` | Initial configuration |
| Status | `status`, `health`, `doctor` | System diagnostics |
| Agent | `agent`, `agents` | AI agent management |
| Message | `message send/broadcast/poll/react` | Channel operations |
| Gateway | `gateway run/stop/logs` | Server management |
| Plugins | `plugins list/install/enable` | Plugin management |
| Channels | `channels status/configure` | Channel management |

### 5.3 Optimization Features

- **Route-First Execution:** Fast path for common commands
- **Lazy Loading:** Sub-CLIs loaded only when requested
- **Plugin CLI Integration:** Dynamic command registration from plugins

---

## 6. Plugin System

### 6.1 Plugin Types

| Type | Count | Examples |
|------|-------|----------|
| Channel Plugins | 18 | discord, slack, matrix, msteams |
| Memory Plugins | 2 | memory-core, memory-lancedb |
| Auth Plugins | 3 | google-antigravity-auth, qwen-portal-auth |
| Utility Plugins | 5 | llm-task, copilot-proxy, diagnostics-otel |

### 6.2 Plugin Lifecycle

```
Discovery → Manifest Validation → Configuration → Loading → Registration → Service Startup
```

### 6.3 Registration API

Plugins receive `MoltbotPluginApi` with methods:
- `registerTool()` - Agent tools
- `registerHook()` - Event hooks (13 types)
- `registerChannel()` - Messaging channels
- `registerService()` - Background services
- `registerCommand()` - CLI commands
- `registerHttpRoute()` - HTTP endpoints

### 6.4 Hook System

| Hook | Type | Purpose |
|------|------|---------|
| `before_agent_start` | Modifying | Pre-agent setup |
| `message_received` | Void | Incoming message |
| `message_sending` | Modifying | Can cancel/modify outgoing |
| `before_tool_call` | Modifying | Can block tool execution |
| `session_start/end` | Void | Session lifecycle |
| `gateway_start/stop` | Void | Gateway lifecycle |

---

## 7. Gateway Server

### 7.1 Architecture

- **Framework:** Hono (4.11.4) + Express (5.2.1)
- **Protocols:** HTTP, WebSocket
- **Port:** Configurable (default varies by mode)

### 7.2 Key Components

| Component | File | Purpose |
|-----------|------|---------|
| Server Factory | `server.ts` | Main server creation |
| HTTP Server | `server-http.ts` | REST API endpoints |
| Plugin API | `server-plugins.ts` | Plugin HTTP handlers |
| Chat Registry | `server-chat-registry.ts` | Conversation management |
| Model Catalog | `server-model-catalog.ts` | LLM model listing |
| Mobile Support | `server-mobile-nodes.ts` | iOS/Android integration |

### 7.3 Session Management

- Sessions stored in `~/.clawdbot/sessions/`
- Hot reload support for configuration changes
- Multi-agent federation capabilities

---

## 8. Media Pipeline

### 8.1 Processing Capabilities

| Media Type | Library | Capabilities |
|------------|---------|--------------|
| Images | sharp, sips (macOS) | Resize, format convert, EXIF |
| Audio | Native + file-type | Format detection, voice validation |
| Video | file-type | Format detection, passthrough |
| PDF | pdfjs-dist | Text extraction, image rendering |

### 8.2 Size Limits

| Type | Limit |
|------|-------|
| Images (outbound) | 6 MB |
| Images (AI input) | 10 MB |
| Audio | 16 MB |
| Video | 16 MB |
| Documents | 100 MB |

### 8.3 Security Features

- SSRF protection (hostname pinning, private IP blocking)
- Path traversal prevention
- Symlink blocking
- File permission restrictions (0o600/0o700)

---

## 9. Testing Infrastructure

### 9.1 Framework Configuration

- **Framework:** Vitest with V8 coverage
- **Coverage Threshold:** 70% (lines, functions, statements), 55% (branches)
- **Test Types:** Unit, E2E, Live, Docker-based

### 9.2 Test Statistics

| Category | Files | Purpose |
|----------|-------|---------|
| Unit Tests | 981 | `.test.ts` files |
| E2E Tests | 52 | `.e2e.test.ts` files |
| Live Tests | 10 | `.live.test.ts` files |

### 9.3 Test Execution

```bash
pnpm test              # Parallel unit tests
pnpm test:e2e          # End-to-end tests
pnpm test:live         # Live API tests
pnpm test:docker:all   # Full Docker test suite
```

### 9.4 Test Isolation

- Temporary HOME directories for state isolation
- Deterministic port allocation per worker
- Plugin registry mocking
- Environment variable snapshot/restore

---

## 10. Build System

### 10.1 Build Pipeline

```bash
pnpm build  # Full build pipeline
```

Steps:
1. Canvas A2UI bundling
2. TypeScript compilation
3. Asset copying (canvas, hooks)
4. Build info generation

### 10.2 Package Manager

- **Primary:** pnpm (10.23.0)
- **Workspaces:** root, ui, packages/*, extensions/*
- **Native deps:** Selective build via `onlyBuiltDependencies`

### 10.3 Scripts Summary

| Script | Purpose |
|--------|---------|
| `pnpm dev` | Development server |
| `pnpm build` | Production build |
| `pnpm lint` | Oxlint type-aware |
| `pnpm format` | Oxfmt check |
| `pnpm test` | Run tests |
| `pnpm mac:package` | macOS app packaging |
| `pnpm ios:build` | iOS app build |
| `pnpm android:run` | Android build + run |

---

## 11. Native Applications

### 11.1 Platforms

| Platform | Language | Location |
|----------|----------|----------|
| macOS | Swift | `apps/macos/` |
| iOS | Swift | `apps/ios/` |
| Android | Kotlin | `apps/android/` |
| Shared | Swift | `apps/shared/MoltbotKit/` |

### 11.2 Architecture

- SwiftUI with Observation framework (`@Observable`)
- Protocol-based gateway communication
- Menu bar app (macOS)
- Background service via LaunchAgent

---

## 12. Security Considerations

### 12.1 Implemented Safeguards

| Area | Implementation |
|------|----------------|
| SSRF Protection | Hostname pinning, private IP blocking |
| Path Traversal | Real path resolution, symlink blocking |
| Executable Safety | Shell metacharacter blocking |
| File Permissions | Restrictive umask (0o600/0o700) |
| Credential Storage | `~/.clawdbot/credentials/` |
| Secret Detection | `.detect-secrets.cfg` in CI |

### 12.2 Execution Approval System

- Located in `src/infra/exec-approvals.ts` (36.4K LOC)
- Sandboxed execution with approval gates
- Tool execution validation

---

## 13. Code Quality Assessment

### 13.1 Strengths

- **Strong Typing:** Strict TypeScript with minimal `any`
- **Test Coverage:** 59% test-to-source ratio, 70% coverage threshold
- **Modular Architecture:** Clear separation of concerns
- **Plugin Extensibility:** Well-defined extension points
- **Documentation:** Comprehensive Mintlify docs (50+ categories)
- **Multi-platform:** macOS, iOS, Android, Linux, Windows support
- **State Migration:** Backward-compatible configuration updates

### 13.2 Areas of Note

- **Large Monorepo:** 2,500+ TypeScript files
- **Complex Dependencies:** 60+ runtime dependencies
- **Large Files:** Some files exceed 500 LOC guideline (update-cli.ts: 40K)
- **External Service Dependencies:** Heavy reliance on messaging platforms and LLM providers

### 13.3 Technical Debt Indicators

- Legacy `clawdbot` references (migration in progress)
- Some channel implementations have both core and extension versions
- Large configuration schema with many optional fields

---

## 14. Recommendations

### 14.1 Code Maintenance

1. Continue splitting large files (>700 LOC) into focused modules
2. Consolidate duplicate channel implementations
3. Add more inline documentation for complex algorithms

### 14.2 Testing

1. Increase branch coverage from 55% toward 70%
2. Add more integration tests for plugin interactions
3. Document test helper usage patterns

### 14.3 Documentation

1. Add architecture decision records (ADRs)
2. Create contributor onboarding guide
3. Document plugin development workflow

---

## 15. Conclusion

Moltbot is a well-architected, enterprise-grade personal AI assistant platform. The codebase demonstrates:

- **Professional Engineering:** Strong typing, extensive testing, clear patterns
- **Scalable Design:** Plugin architecture supporting 30+ extensions
- **Cross-platform:** Native apps for major platforms
- **Production Ready:** Comprehensive error handling, security measures, and monitoring

The modular architecture makes it suitable for both direct use and as a foundation for building custom AI assistant solutions.

---

*Report generated: 2026-01-29*
*Audit conducted on commit: 109ac1c*
