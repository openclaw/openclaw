# Kiến Trúc Tổng Quan — OpenClaw UI (`ui/`)

## Stack Công Nghệ

| Thành phần   | Chi tiết                                         |
| ------------ | ------------------------------------------------ |
| Framework    | **Lit 3** — Web Components + Reactive Properties |
| Build tool   | **Vite 7** (ES Module native, TypeScript)        |
| Language     | **TypeScript** (strict mode)                     |
| Rendering    | **Lit `html` tagged templates**                  |
| Testing      | **Vitest 4** + **Playwright** (browser tests)    |
| Styling      | **Vanilla CSS** (6 stylesheets) + CSS Variables  |
| Fonts        | Inter + JetBrains Mono (Google Fonts)            |
| Markdown     | `marked` + `DOMPurify`                           |
| Crypto       | `@noble/ed25519` v3                              |
| Signals      | `@lit-labs/signals`, `signal-polyfill`           |
| i18n         | Custom (locales trong `src/i18n/locales/`)       |
| Dev port     | `5173`                                           |
| Build output | `../dist/control-ui/`                            |

---

## Cây Thư Mục

```
ui/
├── index.html                    # Entry point — <openclaw-app> custom element
├── vite.config.ts                # Vite config (port 5173, outDir dist/control-ui)
├── vitest.config.ts              # Test config (browser)
├── vitest.node.config.ts         # Test config (node)
├── package.json
│
├── public/                       # Static assets (favicon, images)
│
└── src/
    ├── main.ts                   # Import styles.css + app.ts
    ├── styles.css                # Import tất cả stylesheet
    ├── css.d.ts                  # TypeScript type cho .css imports
    │
    ├── i18n/                     # Internationalization
    │   ├── index.ts              # t(), I18nController, isSupportedLocale
    │   ├── lib/                  # i18n engine
    │   ├── locales/              # Translation files (en, ...)
    │   └── test/                 # i18n tests
    │
    └── ui/                       # Core UI code (157 items)
        ├── app.ts                # OpenClawApp — Web Component chính (617 dòng)
        ├── app-view-state.ts     # AppViewState type (interface toàn bộ state)
        ├── app-render.ts         # renderApp() — Lit template root (1142 dòng)
        ├── app-render.helpers.ts  # Helpers: renderTab, renderThemeToggle, renderChatControls
        ├── app-render-usage-tab.ts # renderUsageTab() riêng biệt
        ├── app-gateway.ts        # connectGateway(), handleGatewayEvent()
        ├── app-lifecycle.ts      # handleConnected/Disconnected/Updated/FirstUpdated
        ├── app-settings.ts       # applySettings, setTab, setTheme, loadOverview, loadCron
        ├── app-chat.ts           # handleSendChat, handleAbortChat, removeQueuedMessage
        ├── app-channels.ts       # WhatsApp/Nostr channel handlers
        ├── app-scroll.ts         # Chat/logs scroll management
        ├── app-polling.ts        # Polling interval cho nodes/logs/debug
        ├── app-tool-stream.ts    # Tool output streaming state
        ├── app-defaults.ts       # DEFAULT_CRON_FORM, DEFAULT_LOG_LEVEL_FILTERS
        ├── app-events.ts         # EventLogEntry type
        │
        ├── gateway.ts            # GatewayBrowserClient (WebSocket class)
        ├── storage.ts            # loadSettings/saveSettings (localStorage)
        ├── navigation.ts         # Tab routing, TAB_GROUPS, pathForTab, tabFromPath
        ├── types.ts              # Tất cả TypeScript types (641 dòng)
        ├── ui-types.ts           # ChatAttachment, ChatQueueItem, CronFormState
        ├── format.ts             # Format utilities
        ├── markdown.ts           # marked + DOMPurify render/sanitize pipeline
        ├── icons.ts              # SVG icon definitions (8951 bytes)
        ├── theme.ts              # ThemeMode type
        ├── theme-transition.ts   # Animated theme switching (View Transitions API)
        ├── uuid.ts               # generateUUID()
        ├── text-direction.ts     # RTL/LTR detection
        ├── device-auth.ts        # Device auth token (localStorage)
        ├── device-identity.ts    # Ed25519 key pair management
        ├── assistant-identity.ts # normalizeAssistantIdentity()
        ├── presenter.ts          # Data presentation helpers
        ├── tool-display.ts       # Tool display configuration
        ├── tool-display.json     # Tool display data
        ├── usage-helpers.ts      # Usage analytics helpers
        ├── usage-types.ts        # Usage analytics types
        │
        ├── controllers/          # Gateway data controllers (28 files)
        │   ├── agents.ts         # loadAgents, loadToolsCatalog
        │   ├── agent-files.ts    # loadAgentFiles, loadAgentFileContent, saveAgentFile
        │   ├── agent-identity.ts # loadAgentIdentity/ies
        │   ├── agent-skills.ts   # loadAgentSkills
        │   ├── assistant-identity.ts # loadAssistantIdentity
        │   ├── channels.ts       # loadChannels
        │   ├── chat.ts           # loadChatHistory, handleChatEvent
        │   ├── config.ts         # loadConfig, saveConfig, applyConfig, runUpdate
        │   ├── control-ui-bootstrap.ts # loadControlUiBootstrapConfig
        │   ├── cron.ts           # CRUD cron jobs + run history
        │   ├── debug.ts          # loadDebug, callDebugMethod
        │   ├── devices.ts        # loadDevices, approve/reject/revoke
        │   ├── exec-approval.ts  # parseExecApprovalRequested/Resolved
        │   ├── exec-approvals.ts # loadExecApprovals, saveExecApprovals
        │   ├── logs.ts           # loadLogs
        │   ├── nodes.ts          # loadNodes
        │   ├── presence.ts       # loadPresence
        │   ├── sessions.ts       # loadSessions, patchSession, deleteSessionAndRefresh
        │   ├── skills.ts         # installSkill, updateSkillEnabled, saveSkillApiKey
        │   └── usage.ts          # Usage analytics queries
        │
        ├── views/                # Lit render functions cho từng tab (59 files)
        │   ├── agents.ts         # renderAgents (19KB)
        │   ├── agents-panels-status-files.ts
        │   ├── agents-panels-tools-skills.ts
        │   ├── agents-utils.ts
        │   ├── channels.ts       # renderChannels (10KB)
        │   ├── channels.telegram.ts
        │   ├── channels.discord.ts
        │   ├── channels.whatsapp.ts
        │   ├── channels.slack.ts
        │   ├── channels.signal.ts
        │   ├── channels.nostr.ts
        │   ├── channels.nostr-profile-form.ts
        │   ├── channels.imessage.ts
        │   ├── channels.googlechat.ts
        │   ├── channels.config.ts
        │   ├── channels.shared.ts
        │   ├── chat.ts           # renderChat (18KB)
        │   ├── config.ts         # renderConfig (30KB)
        │   ├── config-form.ts    # Config form entry
        │   ├── config-form.node.ts
        │   ├── config-form.render.ts
        │   ├── config-form.analyze.ts
        │   ├── config-form.shared.ts
        │   ├── config-search.ts
        │   ├── cron.ts           # renderCron (56KB — file lớn nhất)
        │   ├── debug.ts          # renderDebug
        │   ├── exec-approval.ts  # renderExecApprovalPrompt
        │   ├── gateway-url-confirmation.ts
        │   ├── instances.ts      # renderInstances
        │   ├── logs.ts           # renderLogs
        │   ├── markdown-sidebar.ts
        │   ├── nodes.ts          # renderNodes
        │   ├── nodes-exec-approvals.ts
        │   ├── overview.ts       # renderOverview (13KB)
        │   ├── sessions.ts       # renderSessions (10KB)
        │   ├── skills.ts         # renderSkills
        │   ├── skills-grouping.ts
        │   ├── skills-shared.ts
        │   ├── usage.ts          # renderUsage (29KB)
        │   ├── usage-metrics.ts
        │   ├── usage-query.ts
        │   ├── usage-render-details.ts  # (44KB — file lớn thứ 3)
        │   ├── usage-render-overview.ts # (31KB)
        │   └── ...
        │
        ├── chat/                 # Chat-specific modules (10 files)
        │   ├── grouped-render.ts
        │   ├── message-extract.ts
        │   ├── message-normalizer.ts
        │   ├── tool-cards.ts
        │   ├── copy-as-markdown.ts
        │   └── constants.ts
        │
        ├── components/           # 1 shared component
        ├── data/                 # Static data
        └── types/                # Additional type definitions
```

---

## Kiến Trúc Tổng Thể

```
index.html
  └── <openclaw-app>   (Custom HTML Element đăng ký qua @customElement)
         │
         ├── class OpenClawApp extends LitElement
         │     ├── @state: toàn bộ app state (~100 reactive properties)
         │     ├── render() → renderApp(this as AppViewState)
         │     ├── connectedCallback() → handleConnected()
         │     ├── firstUpdated() → handleFirstUpdated()
         │     ├── disconnectedCallback() → handleDisconnected()
         │     └── updated(changed) → handleUpdated(changed)
         │
         ├── renderApp(state)  [app-render.ts, 1142 dòng]
         │     ├── <header class="topbar">
         │     │     ├── Brand logo + nav collapse toggle
         │     │     ├── Version pill + Health pill
         │     │     └── Theme toggle
         │     ├── <aside class="nav">
         │     │     ├── Tab groups (chat/control/agent/settings)
         │     │     └── External links section (docs.openclaw.ai)
         │     └── <main class="content">
         │           ├── Update banner (nếu có update)
         │           ├── Section header (page title + subtitle)
         │           └── Tab content:
         │                 state.tab === "overview"  → renderOverview()
         │                 state.tab === "chat"      → renderChat()
         │                 state.tab === "agents"    → renderAgents()
         │                 state.tab === "channels"  → renderChannels()
         │                 state.tab === "sessions"  → renderSessions()
         │                 state.tab === "usage"     → renderUsageTab()
         │                 state.tab === "cron"      → renderCron()
         │                 state.tab === "skills"    → renderSkills()
         │                 state.tab === "nodes"     → renderNodes()
         │                 state.tab === "instances" → renderInstances()
         │                 state.tab === "config"    → renderConfig()
         │                 state.tab === "debug"     → renderDebug()
         │                 state.tab === "logs"      → renderLogs()
         │
         └── GatewayBrowserClient [gateway.ts]
               └── WebSocket → OpenClaw Backend
```

---

## Data Flow

```
User Action (click, input, submit)
  │
  ▼
Handler trong app-render.ts (inline arrow functions)
  │
  ├── Gọi controller (src/ui/controllers/*.ts)
  │     └── controller → client.request("method.name", params)
  │                           └── GatewayBrowserClient.request()
  │                                 └── WebSocket JSON frame
  │
  └── Hoặc update state trực tiếp
        └── LitElement @state → auto re-render

Gateway Response/Event
  │
  ├── onHello → applySnapshot() + load initial data
  ├── onClose → set error state
  └── onEvent → handleGatewayEvent()
        ├── "agent" event → handleAgentEvent() (tool streaming)
        ├── "chat" event → handleChatEvent() + flushChatQueue
        ├── "presence" event → update presenceEntries
        ├── "cron" event → reload cron jobs
        ├── "device.pair.*" event → reload devices
        ├── "exec.approval.requested" → add to approval queue
        └── GATEWAY_EVENT_UPDATE_AVAILABLE → set updateAvailable
```

---

## Tabs / Navigation

### TAB_GROUPS

```
Chat
  └── chat          /chat

Control
  ├── overview      /overview
  ├── channels      /channels
  ├── instances     /instances
  ├── sessions      /sessions
  ├── usage         /usage
  └── cron          /cron

Agent
  ├── agents        /agents
  ├── skills        /skills
  └── nodes         /nodes

Settings
  ├── config        /config
  ├── debug         /debug
  └── logs          /logs
```

> Mặc định (`/`) → tab `"chat"` (xem `tabFromPath()`)

---

## CSS Architecture

```
src/styles.css           (import tất cả)
  ├── styles/base.css      — Design tokens, reset, animations
  ├── styles/layout.css    — Shell grid, topbar, nav, content
  ├── styles/layout.mobile.css — Responsive mobile
  ├── styles/components.css — Button, input, badge, table, etc.
  ├── styles/config.css    — Config form styles (30KB)
  ├── styles/chat.css      — Import từ styles/chat/
  └── styles/chat/*.css    — Chat-specific styles
```

---

## Điểm Khác Biệt So Với `ui-next/`

| Tính năng        | `ui/` (Lit)              | `ui-next/` (Next.js)            |
| ---------------- | ------------------------ | ------------------------------- |
| Framework        | Lit 3 (Web Components)   | Next.js 16 + React 19           |
| Architecture     | Single Web Component     | App Router pages                |
| State            | 100+ `@state` properties | `useState` per page             |
| Rendering        | Lit tagged templates     | JSX                             |
| Tabs đầy đủ      | ✅ 13 tabs               | ⚠️ ~9 tabs (một số coming soon) |
| Usage Analytics  | ✅ Đầy đủ                | ❌ Chưa có                      |
| Config Form      | ✅ Form + Raw            | ✅ Có                           |
| Device Pairing   | ✅                       | ❌                              |
| Exec Approvals   | ✅                       | ❌                              |
| Nostr Profile    | ✅                       | ❌                              |
| i18n             | ✅                       | ❌                              |
| Tests            | ✅ Node + Browser        | ❌                              |
| Theme Transition | ✅ View Transitions API  | ✅ localStorage                 |
| Chat Focus Mode  | ✅                       | ⚠️ State có nhưng chưa full     |
| Markdown render  | ✅ DOMPurify + marked    | ❌ (plain text)                 |
| Onboarding mode  | ✅ `?onboarding=1`       | ❌                              |
