# Moltbot Modular Components Guide

This document describes the modular portions of the Moltbot codebase that can be utilized elsewhere. Each component is designed with clear interfaces and minimal coupling, making them suitable for extraction or reuse in other projects.

---

## Table of Contents

1. [Plugin System](#1-plugin-system)
2. [Channel Abstraction Layer](#2-channel-abstraction-layer)
3. [CLI Framework Patterns](#3-cli-framework-patterns)
4. [Media Processing Pipeline](#4-media-processing-pipeline)
5. [Infrastructure Utilities](#5-infrastructure-utilities)
6. [Configuration System](#6-configuration-system)
7. [Gateway Server Components](#7-gateway-server-components)
8. [Testing Utilities](#8-testing-utilities)
9. [Agent Tool System](#9-agent-tool-system)
10. [Hook System](#10-hook-system)

---

## 1. Plugin System

### Location
- Core: `src/plugins/`
- SDK: `src/plugin-sdk/`
- Extensions: `extensions/`

### Components

#### 1.1 Plugin Loader (`src/plugins/loader.ts`)

A dynamic plugin loading system using Jiti for TypeScript/JavaScript modules.

**Key Features:**
- Manifest-based plugin discovery
- Schema validation
- Lazy loading with caching
- Error resilience (plugin failures don't crash core)

**Reusable Pattern:**
```typescript
// Plugin discovery and loading
const plugins = await discoverMoltbotPlugins({
  bundledDir: './extensions',
  globalDir: '~/.config/app/extensions',
  workspaceDir: './workspace/extensions',
});

// Load with validation
const registry = loadMoltbotPlugins({
  config,
  workspaceDir,
  logger,
});
```

#### 1.2 Plugin Registry (`src/plugins/registry.ts`)

A centralized registry for plugin registrations.

**Extensible Registration Types:**
- Tools
- Hooks
- Channels
- Providers
- HTTP handlers
- CLI commands
- Services

**Interface:**
```typescript
type PluginRegistry = {
  plugins: PluginRecord[];
  tools: PluginToolRegistration[];
  hooks: PluginHookRegistration[];
  channels: PluginChannelRegistration[];
  services: PluginServiceRegistration[];
  // ...
}
```

#### 1.3 Plugin Runtime API (`src/plugins/runtime/`)

A comprehensive runtime API exposed to plugins.

**Namespaced Utilities:**
- `runtime.config.*` - Configuration management
- `runtime.system.*` - System operations
- `runtime.media.*` - Media processing
- `runtime.channel.*` - Channel operations
- `runtime.logging.*` - Logging utilities

---

## 2. Channel Abstraction Layer

### Location
- Types: `src/channels/plugins/types*.ts`
- Registry: `src/channels/registry.ts`
- Routing: `src/routing/`

### Components

#### 2.1 Channel Plugin Interface (`src/channels/plugins/types.plugin.ts`)

A comprehensive interface for implementing messaging channels.

**Core Adapters:**
```typescript
type ChannelPlugin<ResolvedAccount> = {
  // Required
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter<ResolvedAccount>;

  // Optional adapters (20+)
  setup?: ChannelSetupAdapter;
  pairing?: ChannelPairingAdapter;
  security?: ChannelSecurityAdapter<ResolvedAccount>;
  outbound?: ChannelOutboundAdapter;
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  threading?: ChannelThreadingAdapter;
  directory?: ChannelDirectoryAdapter;
  actions?: ChannelMessageActionAdapter;
  // ...
}
```

#### 2.2 Capabilities Model (`src/channels/plugins/types.core.ts`)

A declarative capabilities system for channels.

```typescript
type ChannelCapabilities = {
  chatTypes: ('direct' | 'group' | 'channel' | 'thread')[];
  polls?: boolean;
  reactions?: boolean;
  edit?: boolean;
  unsend?: boolean;
  threads?: boolean;
  media?: boolean;
  groupManagement?: boolean;
  nativeCommands?: boolean;
  blockStreaming?: boolean | { minChars: number; idleMs: number };
}
```

#### 2.3 Message Routing (`src/routing/resolve-route.ts`)

A flexible routing system supporting:
- Multi-account configurations
- Agent-to-channel bindings
- Guild/Team awareness
- Peer-specific routing

**Usage:**
```typescript
const route = resolveAgentRoute({
  channel: 'discord',
  accountId: 'main',
  peer: 'user123',
  guildId: 'guild456',
  config,
  bindings,
});
```

---

## 3. CLI Framework Patterns

### Location
- Framework: `src/cli/program/`
- Commands: `src/commands/`

### Components

#### 3.1 Command Registry Pattern (`src/cli/program/command-registry.ts`)

A registration-based command system with lazy loading.

```typescript
type CommandRegistration = {
  id: string;
  register: (params: CommandRegisterParams) => void;
  routes?: RouteSpec[];  // Fast-path routes
};

// Usage
const commandRegistry: CommandRegistration[] = [
  { id: 'status', register: registerStatusCommand },
  { id: 'agent', register: registerAgentCommand, routes: [...] },
];
```

#### 3.2 Fast-Path Routing (`src/cli/route.ts`)

An optimized execution path for high-frequency commands.

```typescript
type RouteSpec = {
  match: (path: string[]) => boolean;
  loadPlugins?: boolean;
  run: (argv: string[]) => Promise<boolean>;
};
```

**Benefits:**
- Bypasses Commander.js parsing overhead
- Selective plugin loading
- Faster startup for common operations

#### 3.3 Lazy Sub-CLI Loading (`src/cli/program/register.subclis.ts`)

Load command modules only when requested.

```typescript
// 28 lazy-loaded subcommands
const SUBCLI_MODULES = {
  gateway: () => import('./gateway-cli.js'),
  models: () => import('./models-cli.js'),
  plugins: () => import('./plugins-cli.js'),
  // ...
};

// Load on demand
await registerSubCliByName(program, 'gateway');
```

#### 3.4 Dependency Injection (`src/cli/deps.ts`)

Injectable dependencies for testable commands.

```typescript
type CliDeps = {
  sendMessageWhatsApp: typeof sendMessageWhatsApp;
  sendMessageTelegram: typeof sendMessageTelegram;
  // ...
};

const deps = createDefaultDeps();
await commandHandler(opts, runtime, deps);
```

---

## 4. Media Processing Pipeline

### Location
- Core: `src/media/`

### Components

#### 4.1 Image Operations (`src/media/image-ops.ts`)

Cross-platform image processing with fallback support.

**Features:**
- EXIF orientation handling
- Format conversion (HEIC, JPEG, PNG)
- Aspect-ratio-preserving resize
- Multi-level compression
- macOS sips fallback

```typescript
// Usage
const result = await resizeToJpeg(buffer, {
  maxWidth: 1920,
  maxHeight: 1080,
  quality: 85,
});
```

#### 4.2 MIME Detection (`src/media/mime.ts`)

Robust MIME type detection using magic bytes.

```typescript
// Detection priority: magic bytes > extension > content-type header
const mime = await detectMimeType(buffer, {
  filename: 'photo.jpg',
  contentType: 'application/octet-stream',
});
```

#### 4.3 Media Store (`src/media/store.ts`)

Temporary media storage with TTL-based cleanup.

**Features:**
- Automatic cleanup on expiration
- Original filename preservation
- Safe filename sanitization
- Permission-controlled storage

```typescript
const { path, url } = await saveMediaBuffer(buffer, 'image/jpeg', 'uploads', {
  maxBytes: 5_000_000,
  ttlMs: 120_000,
});
```

#### 4.4 Remote Fetch with Guards (`src/media/fetch.ts`)

Secure media downloading with size limits and timeout.

```typescript
const { buffer, contentType, filename } = await fetchMediaWithGuard(url, {
  maxBytes: 5_000_000,
  timeoutMs: 10_000,
  maxRedirects: 3,
});
```

---

## 5. Infrastructure Utilities

### Location
- Core: `src/infra/`

### Components

#### 5.1 SSRF Protection (`src/infra/net/ssrf.ts`)

Prevent Server-Side Request Forgery attacks.

**Blocked Targets:**
- Private IP ranges (10.x, 127.x, 192.168.x, etc.)
- Link-local IPv6 addresses
- Reserved domains (.localhost, .local, .internal)

```typescript
// Create a pinned hostname that resolves once
const pinned = await resolvePinnedHostname('api.example.com');

// Use with undici dispatcher
const response = await fetch(url, {
  dispatcher: createPinnedDispatcher(pinned),
});
```

#### 5.2 Safe File Operations (`src/infra/fs-safe.ts`)

Path-traversal-safe file access.

```typescript
const { handle, realPath, stat } = await openFileWithinRoot(
  '/var/media',
  userProvidedPath
);
// Validates:
// - No path traversal (../)
// - No symlink following
// - Within root directory
```

#### 5.3 Retry Logic (`src/infra/retry.ts`)

Configurable exponential backoff retry.

```typescript
const result = await retryAsync(
  () => fetchData(),
  {
    attempts: 3,
    minDelayMs: 300,
    maxDelayMs: 30_000,
    shouldRetry: (err) => err.code === 'ECONNRESET',
  }
);
```

#### 5.4 Port Management (`src/infra/ports.ts`)

Port availability checking and ownership detection.

```typescript
const available = await ensurePortAvailable(8080);
if (!available) {
  const owner = await describePortOwner(8080);
  console.log(`Port in use by: ${owner.command} (PID ${owner.pid})`);
}
```

#### 5.5 Executable Safety (`src/infra/exec-safety.ts`)

Validate executable paths for shell injection.

```typescript
if (!isSafeExecutableValue(userInput)) {
  throw new Error('Unsafe executable value');
}
// Blocks: shell metacharacters, control chars, null bytes
```

---

## 6. Configuration System

### Location
- Core: `src/config/`

### Components

#### 6.1 Hierarchical Config Loading (`src/config/config.ts`)

Multi-source configuration with validation.

**Priority (high to low):**
1. Environment variables
2. Config file (`~/.clawdbot/moltbot.json`)
3. Default values

```typescript
const config = await loadConfig({
  configDir: '~/.clawdbot',
  profile: 'default',
});
```

#### 6.2 State Migrations (`src/infra/state-migrations.ts`)

Backward-compatible configuration updates.

```typescript
// Define migrations
const migrations: StateMigration[] = [
  {
    version: 1,
    migrate: (config) => ({ ...config, newField: 'default' }),
  },
];

// Apply migrations
const migrated = applyMigrations(config, migrations);
```

#### 6.3 Config Schema Validation

Zod-based schema validation.

```typescript
import { z } from 'zod';

const ConfigSchema = z.object({
  gateway: z.object({
    port: z.number().default(18789),
    mode: z.enum(['local', 'remote']).default('local'),
  }),
});
```

---

## 7. Gateway Server Components

### Location
- Core: `src/gateway/`

### Components

#### 7.1 Server Factory (`src/gateway/server.ts`)

Modular server creation with pluggable handlers.

```typescript
const server = createGatewayServer({
  config,
  port: 18789,
  plugins: loadedPlugins,
  channels: channelRegistry,
});
```

#### 7.2 Session Management (`src/gateway/session-utils.ts`)

Conversation session lifecycle management.

```typescript
const session = await createSession({
  channel: 'telegram',
  peer: 'user123',
  agentId: 'main',
});

// Session persisted to ~/.clawdbot/sessions/
```

#### 7.3 Health Probing (`src/gateway/probe.ts`)

Service health checking utilities.

```typescript
const health = await probeGatewayHealth({
  port: 18789,
  timeout: 5000,
});
// Returns: { ok: boolean, latency: number, error?: Error }
```

---

## 8. Testing Utilities

### Location
- Helpers: `test/helpers/`, `src/test-utils/`
- Mocks: `src/gateway/test-helpers.*.ts`

### Components

#### 8.1 Isolated Test Environment (`test/test-env.ts`)

Complete environment isolation for tests.

```typescript
// Creates temporary HOME with full directory structure
await setupTestHome();
// $TMPDIR/moltbot-test-XXXX/
//   .clawdbot/
//   .config/
//   .local/share/
//   .cache/
```

#### 8.2 Deterministic Port Allocation (`src/test-utils/ports.ts`)

Worker-aware port allocation to prevent conflicts.

```typescript
// Returns unique port block per Vitest worker
const port = getDeterministicFreePortBlock();
// Worker 0: 19000, Worker 1: 19100, etc.
```

#### 8.3 Mock Plugin Registry (`src/test-utils/channel-plugins.ts`)

Stub channel plugins for testing.

```typescript
const registry = createTestRegistry({
  channels: ['discord', 'telegram'],
  capabilities: { media: true, reactions: true },
});
```

#### 8.4 Polling Utility (`test/helpers/poll.ts`)

Wait for asynchronous conditions.

```typescript
const result = await pollUntil(
  async () => await checkCondition(),
  { timeout: 5000, interval: 100 }
);
```

---

## 9. Agent Tool System

### Location
- Core: `src/agents/tools/`
- Skills: `skills/`

### Components

#### 9.1 Tool Definition Pattern

Standardized tool definition structure.

```typescript
type AgentTool = {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute: (params: unknown, ctx: ToolContext) => Promise<ToolResult>;
};
```

#### 9.2 Tool Factory Pattern

Context-aware tool creation.

```typescript
function createMemorySearchTool(ctx: ToolContext): AgentTool {
  return {
    name: 'memory_search',
    description: 'Search stored memories',
    parameters: { query: { type: 'string' } },
    execute: async (params) => {
      return await searchMemory(params.query, ctx);
    },
  };
}
```

#### 9.3 Skill Loader

Load skills from directory structure.

```typescript
const skills = await loadSkills('./skills');
// Each skill: metadata.json + tool implementations
```

---

## 10. Hook System

### Location
- Core: `src/plugins/hooks.ts`
- Types: `src/plugins/types.ts`

### Components

#### 10.1 Hook Registry

Event-driven hook system with priorities.

```typescript
// Register hook
api.registerHook('message_sending', async (event, ctx) => {
  if (event.text.includes('blocked')) {
    return { cancel: true, reason: 'Content blocked' };
  }
  return { text: event.text.toUpperCase() };
}, { priority: 10 });
```

#### 10.2 Hook Types

| Hook | Can Modify | Use Case |
|------|------------|----------|
| `before_agent_start` | Yes | Pre-agent setup |
| `message_sending` | Yes | Filter/modify outgoing |
| `before_tool_call` | Yes | Block tool execution |
| `message_received` | No | Log incoming messages |
| `session_start/end` | No | Session lifecycle events |

#### 10.3 Hook Execution

- **Void hooks:** Run in parallel, fire-and-forget
- **Modifying hooks:** Run sequentially by priority

```typescript
// Execute modifying hooks
const result = await executeHooks('message_sending', event, ctx);
if (result.cancelled) {
  return { error: result.reason };
}
```

---

## Extraction Guidelines

When extracting these components for use in other projects:

### 1. Dependencies

Each component has minimal dependencies. Check the imports at the top of each file to identify required packages.

### 2. TypeScript Configuration

These components use strict TypeScript with ESM modules. Ensure your `tsconfig.json` includes:

```json
{
  "compilerOptions": {
    "strict": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ES2022"
  }
}
```

### 3. Path Aliases

Some components use path aliases defined in `tsconfig.json`. Update imports to relative paths or configure aliases in your project.

### 4. Error Handling

Components throw typed errors. Preserve error types when extracting to maintain debugging capability.

### 5. Testing

Each component has colocated tests (`*.test.ts`). Extract tests alongside source for validation.

---

## Quick Reference: File Locations

| Component | Primary File(s) |
|-----------|----------------|
| Plugin Loader | `src/plugins/loader.ts` |
| Plugin Registry | `src/plugins/registry.ts` |
| Plugin Runtime | `src/plugins/runtime/types.ts` |
| Channel Interface | `src/channels/plugins/types.plugin.ts` |
| Routing | `src/routing/resolve-route.ts` |
| CLI Registry | `src/cli/program/command-registry.ts` |
| Fast Routes | `src/cli/route.ts` |
| Image Ops | `src/media/image-ops.ts` |
| MIME Detection | `src/media/mime.ts` |
| Media Store | `src/media/store.ts` |
| SSRF Protection | `src/infra/net/ssrf.ts` |
| Safe File Ops | `src/infra/fs-safe.ts` |
| Retry Logic | `src/infra/retry.ts` |
| Config Loading | `src/config/config.ts` |
| State Migrations | `src/infra/state-migrations.ts` |
| Test Environment | `test/test-env.ts` |
| Test Ports | `src/test-utils/ports.ts` |
| Hook System | `src/plugins/hooks.ts` |

---

*Document generated: 2026-01-29*
