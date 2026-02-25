# Phase 1A -- Deep Architecture Audit & Web UI Framework Recommendation

**Project:** OpenClaw / Activi
**Date:** 2026-02-23
**Scope:** Monorepo structure, dependency graph, state management, API communication, Web UI framework evaluation
**Version audited:** 2026.2.22

---

## 1. Architecture Map

### 1.1 High-Level System Diagram (C4 -- Context Level)

```
                          +---------------------+
                          |   External Users     |
                          | (WhatsApp, Telegram, |
                          |  Discord, Slack, ...) |
                          +----------+----------+
                                     |
                          messaging channels
                                     |
                          +----------v----------+
                          |   ACTIVI GATEWAY     |
                          |  (Node.js / Express) |
                          |  HTTP + WebSocket    |
                          +---+------+------+---+
                              |      |      |
               +--------------+      |      +---------------+
               |                     |                      |
   +-----------v---------+  +-------v--------+  +----------v----------+
   |  37 Channel Plugins |  |   AI Agents    |  |   Control Clients   |
   |  (extensions/)      |  | (src/agents/)  |  |                     |
   |                     |  |                |  |  - Web UI (Lit.js)  |
   |  WhatsApp, Discord, |  | Agent routing, |  |  - macOS (Swift)   |
   |  Telegram, Slack,   |  | sessions,      |  |  - iOS (Swift)     |
   |  Matrix, IRC, ...   |  | providers      |  |  - Android (Kotlin)|
   +---------------------+  +-------+--------+  |  - TUI (terminal)  |
                                     |           +---------------------+
                              +------v------+
                              |  65 Skills  |
                              | (skills/)   |
                              +-------------+
```

### 1.2 Monorepo Structure

The project is organized as a **pnpm workspace monorepo** with the following top-level layout:

```
activi/
 +-- src/                    Core TypeScript gateway (main package)
 |    +-- gateway/           HTTP/WS server, protocol, methods
 |    +-- agents/            Agent runtime, routing, sessions
 |    +-- channels/          Built-in channel abstractions
 |    +-- config/            Zod-based config schema + validation
 |    +-- plugins/           Plugin registry + hook runner
 |    +-- providers/         LLM provider integrations
 |    +-- security/          Auth, SSRF guards, sandbox
 |    +-- memory/            Session memory (SQLite-vec)
 |    +-- browser/           Playwright browser control
 |    +-- wizard/            Onboarding wizard
 |    +-- (discord|signal|telegram|whatsapp|...) -- legacy in-tree channels
 |    +-- ...
 +-- extensions/             37 channel/feature plugins (pnpm workspace members)
 +-- skills/                 65 bundled skills (SKILL.md + scripts)
 +-- apps/
 |    +-- macos/             Native macOS app (Swift/SwiftUI)
 |    +-- ios/               Native iOS app (Swift/SwiftUI)
 |    +-- android/           Native Android app (Kotlin/Compose)
 |    +-- shared/            Shared ActiviKit (Swift)
 +-- ui/                     Web Control Panel (Lit 3.3.2, Vite 7.3.1)
 +-- packages/               Legacy npm wrappers (activi, moltbot)
 +-- docs/                   Mintlify documentation site
 +-- test/                   Test fixtures and helpers
 +-- scripts/                Build/CI/release scripts
```

**pnpm-workspace.yaml** members: `.` (root), `ui`, `packages/*`, `extensions/*`

**Key technology stack:**
- Runtime: Node.js >= 22.12.0 (ESM)
- Language: TypeScript 5.9, tsdown bundler
- Server: Express 5.2 + ws 8.x
- Validation: Zod 4.x (config), AJV (protocol), @sinclair/typebox
- LLM providers: OpenAI, Anthropic, Google, Bedrock, local (node-llama-cpp)
- Linting: oxlint (Rust-based), oxfmt

### 1.3 Extension/Plugin Architecture

Each extension is a self-contained pnpm workspace package with:
- `activi.plugin.json` -- plugin manifest (id, name, version, capabilities)
- `src/` -- TypeScript source (config schema, channel logic, probe, targets)
- Optional `skills/` subdirectory for extension-specific skills

**37 registered extensions by category:**

| Category | Extensions |
|----------|-----------|
| Messaging | whatsapp, telegram, discord, slack, signal, matrix, imessage, bluebubbles, line, irc, mattermost, msteams, googlechat, feishu, nostr, synology-chat, nextcloud-talk, tlon, zalo, zalouser, twitch |
| Voice | talk-voice, voice-call |
| AI/Tools | llm-task, copilot-proxy, lobster, open-prose, memory-core, memory-lancedb |
| Device | device-pair, phone-control |
| Auth | google-antigravity-auth, google-gemini-cli-auth, qwen-portal-auth, minimax-portal-auth |
| Ops | diagnostics-otel, thread-ownership |

### 1.4 Skills Architecture

**65 bundled skills** in `skills/`, each containing:
- `SKILL.md` -- skill definition (name, description, tools, examples)
- Optional `scripts/` -- Python/bash execution scripts
- Optional `references/` -- reference documentation for the LLM

Skills are loaded by the gateway's skill registry and made available to agents based on configuration. Skills are purely declarative (SKILL.md read by agents at prompt-assembly time) or include executable scripts.

---

## 2. Dependency Graph

### 2.1 Module Dependency Map (C4 -- Container Level)

```
+----------------------------------------------------------------------+
|                         GATEWAY SERVER                                |
|  server.impl.ts                                                       |
|                                                                       |
|  +------------------+    +-------------------+    +-----------------+ |
|  | server-methods/  |    | server-channels   |    | server-cron     | |
|  |  connect, chat,  |    | ChannelManager    |    | CronService     | |
|  |  config, agents, |    +--------+----------+    +--------+--------+ |
|  |  sessions, nodes,|             |                        |          |
|  |  skills, cron,   |    +--------v----------+    +--------v--------+ |
|  |  devices, logs,  |    | plugins/          |    | croner (cron    | |
|  |  exec-approvals, |    | registry.ts       |    |  expressions)   | |
|  |  browser, talk,  |    | hook-runner.ts    |    +-----------------+ |
|  |  tts, update,    |    +--------+----------+                        |
|  |  usage, wizard   |             |                                   |
|  +--------+---------+    +--------v----------+                        |
|           |              | channels/plugins/ |                        |
|           |              | (37 extensions)   |                        |
|  +--------v---------+   +-------------------+                        |
|  | protocol/         |                                                |
|  | schema.ts         |   +-------------------+                        |
|  | (AJV validators)  |   | agents/           |                        |
|  | frames, types,    |   | agent-scope.ts    |                        |
|  | sessions, config  |   | skills/refresh.ts |                        |
|  +------------------+    | pi-embedded-      |                        |
|                          |   runner/          |                        |
|  +------------------+   +--------+----------+                        |
|  | config/           |            |                                   |
|  | zod-schema.ts     |   +--------v----------+                        |
|  | io.ts, paths.ts   |   | providers/         |                       |
|  | validation.ts     |   | (OpenAI, Claude,   |                       |
|  +------------------+    |  Gemini, Bedrock,  |                       |
|                          |  local llama.cpp)  |                       |
|                          +-------------------+                        |
+----------------------------------------------------------------------+

             WebSocket (Protocol v3)
                     |
      +--------------+--------------+
      |              |              |
+-----v----+  +-----v----+  +------v-----+
| Web UI   |  | macOS    |  | Android    |
| (Lit.js) |  | (Swift)  |  | (Kotlin)   |
+----------+  +----------+  +------------+
                    |
              +-----v----+
              | iOS      |
              | (Swift)  |
              +----------+
```

### 2.2 Gateway Request Handler Map

The gateway exposes **22 method handler groups** via WebSocket RPC:

```
server-methods.ts --> coreGatewayHandlers = {
    connect.*        -- WebSocket handshake, hello, challenge-response
    chat.*           -- chat.send, chat.history, chat.abort, chat.inject
    config.*         -- config.get, config.set, config.apply, config.patch, config.schema
    sessions.*       -- sessions.list, sessions.preview, sessions.patch, sessions.delete,
                        sessions.compact, sessions.usage
    agents.*         -- agents.list, agents.create, agents.update, agents.delete, agents.files.*
    agent.*          -- agent.identity, agent.wait
    skills.*         -- skills.status, skills.bins, skills.install, skills.update
    cron.*           -- cron.list, cron.status, cron.add, cron.update, cron.remove, cron.run,
                        cron.runs
    nodes.*          -- node.list, node.describe, node.invoke, node.invoke.result, node.event
    channels.*       -- channels.status, channels.logout
    devices.*        -- device.pair.list, device.pair.approve, device.pair.reject, device.pair.remove
    exec.*           -- exec.approvals.get, exec.approvals.set, exec.approval.resolve
    logs.*           -- logs.tail
    models.*         -- models.list
    health           -- health check
    update.*         -- update.run
    wizard.*         -- wizard.start, wizard.next, wizard.cancel, wizard.status
    talk.*           -- talk.mode, talk.config
    tts.*            -- text-to-speech
    send.*           -- outbound message send
    push.*           -- push notification test
    browser.*        -- browser automation control
    system.*         -- system info
    usage.*          -- usage analytics
    web.*            -- web login start/wait
    voicewake.*      -- voice wake controls
}
```

### 2.3 Protocol Schema Architecture

The protocol is defined in `/Users/dsselmanovic/openclaw/src/gateway/protocol/`:
- **schema.ts** -- barrel file re-exporting 17 schema modules
- **schema/** -- individual JSON Schema definitions for each domain (agents, channels, config, cron, devices, exec-approvals, frames, logs-chat, nodes, push, sessions, snapshot, types, wizard, protocol-schemas)
- **index.ts** -- compiles all schemas into AJV validators, exports validation functions and type definitions
- **client-info.ts** -- client name/mode constants used in protocol handshake

The protocol is versioned at `PROTOCOL_VERSION = 3` and schemas are generated into `dist/protocol.schema.json` for cross-platform consumption (Swift clients use auto-generated `GatewayModels.swift`).

---

## 3. Web UI State Management Analysis

### 3.1 Current Architecture

**File:** `/Users/dsselmanovic/openclaw/ui/src/ui/app.ts` (623 lines)

The `ActiviApp` class extends `LitElement` with **createRenderRoot() returning `this`** (no Shadow DOM). It is the single root custom element (`<activi-app>`) and contains:

- **126 `@state()` reactive properties** covering all application domains
- **No component decomposition** -- one monolithic class owns all state
- **Delegate pattern** -- methods forward to imported helper modules (`app-chat.ts`, `app-settings.ts`, `app-lifecycle.ts`, etc.) using type assertions

**State domains hosted on ActiviApp (count of @state properties):**

| Domain | @state count | Notes |
|--------|-------------|-------|
| Chat | ~18 | messages, stream, queue, attachments, sidebar |
| Config | ~16 | raw/form modes, schema, sections, saving |
| Sessions | ~12 | list, filters, sorting, pagination, actions |
| Usage | ~28 | dates, charts, time series, filters, columns |
| Agents | ~14 | list, files, identity, skills |
| Channels | ~9 | snapshot, WhatsApp QR, Nostr profile |
| Cron | ~7 | jobs, status, form, runs |
| Exec Approvals | ~11 | snapshot, form, queue |
| Logs | ~12 | entries, filters, follow, scroll |
| Debug | ~8 | status, health, models, RPC |
| Devices | ~3 | loading, error, list |
| Health | ~3 | loading, result, error |
| Overview | ~6 | attention, palette, stream, logs |
| Theme/UI | ~8 | theme, tab, connected, hello, settings |

### 3.2 State Flow Diagram

```
 +-------------------+
 |  Gateway Server   |
 |  (Node.js)        |
 +--------+----------+
          | WebSocket (JSON frames)
          | Protocol v3
          |
 +--------v-----------+
 | GatewayBrowserClient|  ui/src/ui/gateway.ts
 | - WebSocket conn    |
 | - request/response  |
 | - event handling    |
 | - reconnect logic   |
 | - device auth       |
 +--------+------------+
          |
          | onHello callback
          | onEvent callback
          | request<T>() Promise
          |
 +--------v---------------------------+
 | Controllers (33 files)              |  ui/src/ui/controllers/
 | - chat.ts (loadChatHistory,         |
 |   sendChatMessage)                  |
 | - config.ts (loadConfig, saveConfig)|
 | - sessions.ts (loadSessions)        |
 | - agents.ts (loadAgents)            |
 | - channels.ts (loadChannels)        |
 | - skills.ts (loadSkills)            |
 | - cron.ts (loadCron, addCronJob)    |
 | - logs.ts (loadLogs)                |
 | - debug.ts (loadDebug)              |
 | - nodes.ts (loadNodes)              |
 | - devices.ts (loadDevices)          |
 | - presence.ts (loadPresence)        |
 | - health.ts                         |
 | - usage.ts                          |
 | - exec-approval.ts                  |
 | - exec-approvals.ts                 |
 | - onboarding-wizard.ts              |
 | - assistant-identity.ts             |
 | - agent-files.ts                    |
 | - agent-identity.ts                 |
 | - agent-skills.ts                   |
 | - control-ui-bootstrap.ts           |
 | - models.ts                         |
 | - ...                               |
 +--------+----------------------------+
          |
          | Direct mutation of state properties
          | (controllers receive `state: ChatState` etc.
          |  and mutate properties directly)
          |
 +--------v---------------------------+
 | ActiviApp (@state() properties)     |  ui/src/ui/app.ts
 | 126 reactive properties             |
 | - Lit triggers re-render on change  |
 | - No external state store           |
 | - No computed/derived state layer   |
 +--------+----------------------------+
          |
          | renderApp(this as AppViewState)
          |
 +--------v---------------------------+
 | Views (62 files)                    |  ui/src/ui/views/
 | - chat.ts                           |
 | - overview.ts, overview-cards.ts    |
 | - config.ts, config-form.ts         |
 | - channels.ts + per-channel views   |
 | - sessions.ts                       |
 | - agents.ts + agent panels          |
 | - skills.ts                         |
 | - usage.ts + metrics/query/details  |
 | - cron.ts                           |
 | - logs.ts                           |
 | - debug.ts                          |
 | - nodes.ts                          |
 | - ...                               |
 +-------------------------------------+
```

### 3.3 Critical Observations

1. **God Object anti-pattern**: `ActiviApp` is a single class with 126 reactive state properties. Every state change anywhere triggers Lit's dirty-checking across all properties.

2. **No state isolation**: All domains (chat, config, sessions, usage, agents, etc.) share the same reactive scope. A usage filter change re-evaluates the entire render tree.

3. **Controller pattern is thin**: Controllers are pure functions that receive a subset type and mutate properties directly. They do not own state -- they borrow it via type assertions.

4. **No Shadow DOM**: `createRenderRoot()` returns `this`, meaning all CSS is global and all views share the same DOM scope. This makes the 15 CSS files (~10,800 lines) a fragile global namespace.

5. **No router**: Navigation is handled via a `tab` state property with `history.pushState()` side effects. There is no code-splitting -- all 62 view files are loaded upfront.

6. **Views are pure render functions**: The 62 view files export functions like `renderChat(state: AppViewState)` that return Lit `html` templates. They are not separate components, so they cannot independently optimize rendering.

7. **Tab-based navigation**: 14 tabs organized into 4 groups -- chat, control (overview, channels, broadcast, instances, sessions, usage, cron), agent (agents, skills, nodes), settings (config, debug, logs).

---

## 4. API Communication

### 4.1 WebSocket Protocol (Protocol v3)

**Frame types:**

```typescript
// Client -> Gateway (request)
{ type: "req", id: string, method: string, params?: unknown }

// Gateway -> Client (response)
{ type: "res", id: string, ok: boolean, payload?: unknown, error?: ErrorShape }

// Gateway -> Client (event, server push)
{ type: "event", event: string, payload?: unknown, seq?: number,
  stateVersion?: { presence: number, health: number } }
```

**Connection flow:**
1. Client opens WebSocket to gateway URL
2. Gateway sends `connect.challenge` event with `nonce`
3. Client sends `connect` request with auth credentials + device signature
4. Gateway responds with `hello-ok` containing features, snapshot, auth token, policy

**Event stream (server push):** `chat.event`, `agent.event`, `tick`, `shutdown`, presence updates, health updates, exec-approval requests, update-available notifications.

### 4.2 HTTP Endpoints

Express routes serve:
- Static assets for Control UI (`/` serves Vite-built SPA)
- Plugin HTTP routes (extension-provided HTTP endpoints)
- OpenAI-compatible Responses API (`/v1/responses`)
- Health check endpoint
- Canvas host (embedded browser automation UI)

### 4.3 Authentication Mechanisms

| Mechanism | Description |
|-----------|-------------|
| **Token** | Shared secret (`gateway.auth.token`), compared via timing-safe hash comparison |
| **Password** | Password-based auth (`gateway.auth.password`) |
| **Tailscale** | Proxy-header identity verification via Tailscale Serve |
| **Device Auth** | Ed25519 keypair per device, nonce-signed challenge-response, with issued device tokens stored in browser IndexedDB |
| **Rate Limiting** | Sliding-window per-IP rate limiter (10 attempts / 60s / 5 min lockout) |

**Role-based authorization:** `operator` (with scoped permissions: `operator.admin`, `operator.read`, `operator.write`, `operator.approvals`, `operator.pairing`) and `node` roles. Each method is authorized via `method-scopes.ts` and `role-policy.ts`. Control-plane write methods (`config.apply`, `config.patch`, `update.run`) have additional rate limiting (3 per 60s).

**Device auth payload format (v2):**
```
v2|{deviceId}|{clientId}|{clientMode}|{role}|{scopes}|{signedAtMs}|{token}|{nonce}
```
Signed with Ed25519 private key stored in browser CryptoKey storage. Device tokens are issued by the gateway on successful connect and cached for subsequent connections.

---

## 5. Web UI Framework Evaluation

### 5.1 Current State Assessment

| Metric | Value |
|--------|-------|
| Framework | Lit 3.3.2 Web Components |
| Bundler | Vite 7.3.1 |
| Shadow DOM | Disabled (createRenderRoot bypass) |
| Router | None (manual tab + pushState) |
| State management | 126 @state() on monolithic ActiviApp |
| View files | 62 |
| Controller files | 33 |
| CSS files | 15 (~10,800 lines vanilla CSS) |
| i18n | Custom Lit controller with locale support |
| Component library | None (hand-rolled) |
| Testing | Vitest + Playwright browser tests |
| Dependencies | lit, @lit-labs/signals, @lit/context, signal-utils, marked, dompurify |

### 5.2 Framework Comparison Matrix

| Criterion | Lit.js (stay + refactor) | SvelteKit 2 | React 19 + shadcn/ui | Solid.js + SolidStart |
|-----------|------------------------|-------------|----------------------|----------------------|
| **Migration effort** | LOW -- incremental refactor into sub-components, extract stores. No rewrite needed. | HIGH -- full rewrite from templates to Svelte SFCs. 62 views + 33 controllers must be ported. | HIGH -- full rewrite from Lit templates to JSX. Controllers map well to hooks/Zustand. | HIGH -- full rewrite. JSX similar to React but different reactivity model. |
| **Component library** | WEAK -- Shoelace/Spectrum exist but limited for admin dashboards. | MODERATE -- Skeleton UI, Flowbite Svelte, Melt UI. Growing but smaller than React. | STRONG -- shadcn/ui, Radix, Headless UI, Material, Ant Design. Best-in-class ecosystem. | WEAK -- Kobalte exists but small ecosystem. Few production-grade libraries. |
| **State management** | Needs work -- @lit-labs/signals already a dep. Could adopt TC39 Signals + context. | STRONG -- Svelte stores ($state runes in Svelte 5) built-in, reactive, composable. | STRONG -- Zustand, Jotai, TanStack Query. Mature, well-documented, huge community. | STRONG -- fine-grained signals built-in. Best reactivity model. No virtual DOM. |
| **Routing + code-split** | WEAK -- must add manually. @vaadin/router or custom solution. | STRONG -- SvelteKit file-based routing, SSR, automatic code splitting. | STRONG -- React Router 7 / TanStack Router. Lazy loading, nested layouts. | MODERATE -- SolidStart file-based routing. Smaller ecosystem. |
| **Ecosystem size** | SMALL -- ~70k weekly npm downloads. Limited community resources. | MODERATE -- ~350k weekly downloads. Growing momentum. | DOMINANT -- ~25M weekly downloads. Largest ecosystem by far. | SMALL -- ~80k weekly downloads. Niche but innovative. |
| **Bundle size (framework)** | EXCELLENT -- ~16 KB gzipped (Lit core). | EXCELLENT -- ~5 KB gzipped (Svelte compiles away). | MODERATE -- ~45 KB gzipped (React + ReactDOM). With shadcn additions grow further. | EXCELLENT -- ~8 KB gzipped. Compiles to vanilla JS. |
| **WebSocket compat** | NATIVE -- current GatewayBrowserClient works as-is. | GOOD -- wrap existing client in Svelte store. Minor adaptation. | GOOD -- wrap in custom hook or external store. Standard pattern. | GOOD -- wrap in createResource/createSignal. Natural fit for signals. |
| **Design system tools** | WEAK -- no Tailwind integration, no design tokens. Hand-rolled CSS. | GOOD -- Tailwind integration native. Theme tokens via CSS vars. | EXCELLENT -- Tailwind + shadcn/ui = production-grade design system out of the box. | MODERATE -- Tailwind works. Limited pre-built design systems. |
| **TypeScript support** | GOOD -- Lit has strong TS support. Decorators require config. | GOOD -- Svelte 5 improved TS significantly. Some template limitations. | EXCELLENT -- React + TS is the most battle-tested combination in the industry. | EXCELLENT -- Solid has first-class TypeScript support. |
| **Developer experience** | MODERATE -- lower-level primitives. No hot module replacement for state. | GOOD -- excellent DX, fast HMR, intuitive reactivity model. | GOOD -- massive tooling (React DevTools, ESLint plugins, testing-library). | GOOD -- fast HMR, fine-grained updates visible in DevTools. |
| **Learning curve** | LOW for existing team (already using it). | MODERATE -- new syntax, runes paradigm in Svelte 5. | LOW-MODERATE -- most developers know React already. | MODERATE -- looks like React but reactivity rules differ significantly. |
| **Long-term viability** | MODERATE -- Google-backed but low adoption outside Google. Web Components standard is stable but ecosystem is thin. | GOOD -- strong momentum, corporate backing growing. | STRONG -- industry standard, massive investment, not going anywhere. | MODERATE -- innovative but niche. Risk of staying small. |

### 5.3 Weighted Score

Weights reflect the project's priorities: admin dashboard for a multi-channel AI gateway. Key needs are maintainability, component library quality, developer productivity, and ecosystem longevity.

| Criterion (weight) | Lit (stay) | SvelteKit | React + shadcn | Solid.js |
|---------------------|-----------|-----------|----------------|----------|
| Migration effort (20%) | 9 | 3 | 3 | 3 |
| Component library (15%) | 3 | 6 | 10 | 4 |
| State management (15%) | 5 | 9 | 9 | 10 |
| Routing/code-split (10%) | 3 | 9 | 9 | 7 |
| Ecosystem size (10%) | 3 | 6 | 10 | 3 |
| Bundle size (5%) | 10 | 10 | 6 | 10 |
| WebSocket compat (5%) | 10 | 8 | 8 | 8 |
| Design system (10%) | 3 | 7 | 10 | 5 |
| TypeScript (5%) | 8 | 7 | 10 | 9 |
| Long-term viability (5%) | 6 | 7 | 10 | 6 |
| **WEIGHTED TOTAL** | **5.40** | **6.30** | **7.85** | **5.55** |

---

## 6. Framework Recommendation

### Primary Recommendation: React 19 + shadcn/ui + Tailwind CSS

**Rationale:**

1. **Component library gap is the biggest pain point.** The current UI has 10,800 lines of hand-rolled CSS with no design tokens, no reusable component system, and no accessibility baseline. shadcn/ui provides production-grade, accessible, themeable components (dialog, dropdown, tabs, data tables, charts, command palette, forms) that directly map to the existing view needs.

2. **State management becomes trivial.** The 126 `@state()` properties can be decomposed into domain-specific Zustand stores (`useChatStore`, `useConfigStore`, `useSessionsStore`, etc.) that are independently reactive. TanStack Query can handle server-state synchronization with the WebSocket, providing caching, invalidation, and optimistic updates.

3. **Routing and code splitting are built-in.** React Router 7 or TanStack Router provides file-based routing with lazy-loaded route components. The 14 tabs become 14 route entries with automatic code splitting -- the current monolithic bundle splits into per-tab chunks.

4. **Ecosystem dominance matters.** For a project that ships a web-based admin dashboard as its primary control surface, the React ecosystem provides the widest selection of battle-tested libraries for every need: data visualization (Recharts for usage charts), markdown rendering (react-markdown), form handling (React Hook Form for config editor), virtualized lists (TanStack Virtual for log/session tables).

5. **The WebSocket client is framework-agnostic.** `GatewayBrowserClient` is a plain TypeScript class with callbacks. It wraps cleanly into either a Zustand middleware or a custom hook -- no rewrite needed.

6. **The migration, while substantial, follows a clear mechanical pattern.** Each Lit view function (`renderChat(state)`) maps 1:1 to a React component. Each controller module maps to a hook or store slice. The template syntax change (Lit `html` tagged templates to JSX) is tedious but predictable.

### Why not stay with Lit (refactor only)?

Staying with Lit and refactoring is the lowest-risk option. However:
- Lit's component library ecosystem is too thin for a complex admin dashboard
- Adding routing, code splitting, and proper state management to Lit requires stitching together multiple small libraries with no unified developer experience
- The CSS situation (10,800 lines of global vanilla CSS) requires a design system migration regardless; doing it alongside a framework upgrade amortizes the effort
- The team is already importing `@lit-labs/signals` and `signal-utils` -- signals are better supported natively in React 19 via `use()` and in dedicated stores like Zustand

### Why not SvelteKit?

SvelteKit scored second and is a strong alternative. Its built-in reactivity and routing are excellent. However:
- Component library ecosystem is smaller (no shadcn-quality equivalent yet)
- Svelte 5 runes are a new paradigm; the ecosystem is still catching up
- Fewer developers know Svelte, which affects future contributor pool
- SvelteKit's SSR focus is unnecessary for a WebSocket-driven SPA

### Why not Solid.js?

Solid has the best reactivity model of all candidates but:
- Component library ecosystem is too small for production admin dashboards
- Niche adoption creates long-term risk for hiring and community support
- Fewer developers available

---

## 7. Migration Plan Outline (React)

### Phase 0: Preparation (1--2 weeks)
- Set up React 19 + Vite + Tailwind CSS + shadcn/ui in `ui/` alongside existing Lit app
- Port `GatewayBrowserClient` into a framework-agnostic Zustand store
- Define routing structure mapping existing 14 tabs to routes
- Set up shared types (reuse existing `types.ts`, `ui-types.ts`)
- Create design token system (CSS variables + Tailwind config)

### Phase 1: Core Shell (2--3 weeks)
- Build React app shell: layout, sidebar navigation, theme system
- Port the login gate and WebSocket connection flow
- Implement gateway Zustand store with request/event handling
- Port the command palette (shadcn `CommandDialog` is a near drop-in)
- Port i18n (react-i18next or custom hook wrapping existing locale files)

### Phase 2: High-Value Views (3--4 weeks)
- Port Chat view (highest usage) -- use shadcn components + react-markdown
- Port Overview dashboard (cards, attention items, event log)
- Port Config view (form mode + raw JSON editor) -- shadcn form components
- Port Sessions/Usage views -- shadcn DataTable + Recharts for charts

### Phase 3: Remaining Views (3--4 weeks)
- Port Channels views (per-channel config forms)
- Port Agents views (panels, files, tools, skills sub-views)
- Port Skills, Cron, Nodes, Logs, Debug views
- Port Broadcast, Instances, Exec Approvals views
- Port Onboarding Wizard (shadcn stepper pattern)

### Phase 4: Polish & Cutover (2 weeks)
- Migrate all remaining CSS to Tailwind utility classes + shadcn theming
- Comprehensive browser testing (Playwright)
- Performance profiling (Lighthouse, bundle analysis)
- Remove Lit dependencies and old UI code
- Update build scripts (`ui:build`, `ui:dev`)

**Estimated total: 11--15 weeks for one full-time developer, or 6--8 weeks for two.**

### Alternative: Incremental Lit Refactor (if migration is rejected)

If a full framework change is rejected, the following refactor plan addresses the worst issues within Lit:

1. **Decompose ActiviApp into sub-components**: Create `<activi-chat>`, `<activi-config>`, `<activi-sessions>` etc. as separate LitElement classes, each owning their domain state
2. **Adopt Lit Context + Signals**: Use `@lit/context` for shared state (gateway client, theme, settings) and `@lit-labs/signals` for reactive data flow between components
3. **Add @vaadin/router**: Client-side routing with lazy imports per tab
4. **Adopt Tailwind CSS**: Replace vanilla CSS with utility classes, add design tokens via Tailwind config
5. **Adopt Shoelace**: Web Components-based component library compatible with Lit for common UI patterns

This incremental path is lower risk but delivers less improvement in DX and component quality.

---

## 8. Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| Migration takes longer than estimated | HIGH | MODERATE | Phase approach allows shipping incremental value; old UI remains functional during migration |
| shadcn/ui does not cover all custom components | LOW | LOW | shadcn is unstyled/composable; custom components are straightforward to create within its patterns |
| WebSocket integration complexity | MODERATE | LOW | GatewayBrowserClient is already framework-agnostic; well-tested pattern |
| Team unfamiliar with React | MODERATE | VARIES | React has the most learning resources of any framework; hiring pool is largest |
| Performance regression (React vs Lit) | LOW | LOW | React 19 concurrent features + code splitting will likely improve perceived performance vs current monolithic Lit bundle |
| CSS migration introduces visual regressions | MODERATE | MODERATE | Automated visual regression testing with Playwright screenshots; side-by-side comparison during migration |

---

## Appendix A: Key File References

| Purpose | Path |
|---------|------|
| Root package.json | `/Users/dsselmanovic/openclaw/package.json` |
| pnpm workspace | `/Users/dsselmanovic/openclaw/pnpm-workspace.yaml` |
| Gateway server impl | `/Users/dsselmanovic/openclaw/src/gateway/server.impl.ts` |
| Gateway methods | `/Users/dsselmanovic/openclaw/src/gateway/server-methods.ts` |
| Protocol schema barrel | `/Users/dsselmanovic/openclaw/src/gateway/protocol/schema.ts` |
| Protocol validators | `/Users/dsselmanovic/openclaw/src/gateway/protocol/index.ts` |
| Config barrel | `/Users/dsselmanovic/openclaw/src/config/config.ts` |
| UI main app | `/Users/dsselmanovic/openclaw/ui/src/ui/app.ts` |
| UI gateway client | `/Users/dsselmanovic/openclaw/ui/src/ui/gateway.ts` |
| UI navigation | `/Users/dsselmanovic/openclaw/ui/src/ui/navigation.ts` |
| UI render entry | `/Users/dsselmanovic/openclaw/ui/src/ui/app-render.ts` |
| UI package.json | `/Users/dsselmanovic/openclaw/ui/package.json` |
| Device auth | `/Users/dsselmanovic/openclaw/src/gateway/device-auth.ts` |
| Auth messages | `/Users/dsselmanovic/openclaw/src/gateway/server/ws-connection/auth-messages.ts` |

## Appendix B: Quantitative Summary

| Metric | Count |
|--------|-------|
| Extensions (plugins) | 37 |
| Bundled skills | 65 |
| Native apps | 3 (macOS, iOS, Android) |
| Gateway RPC method groups | 22 |
| UI @state() properties | 126 |
| UI view files | 62 |
| UI controller files | 33 (including tests) |
| UI CSS files | 15 |
| UI tabs/routes | 14 |
| Protocol version | 3 |
| Auth mechanisms | 4 (token, password, tailscale, device) |
