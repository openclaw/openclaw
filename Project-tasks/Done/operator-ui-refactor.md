# Operator UI Rewrite — Project Plan

> **Goal**: Replace the Lit-based control UI with a modern React + shadcn + Tailwind stack, themed with a Matrix aesthetic.

---

## 📋 Table of Contents

1. [Project Overview](#project-overview)
2. [Tech Stack Decision](#tech-stack-decision)
3. [Current State Analysis](#current-state-analysis)
4. [Dependencies](#dependencies)
5. [Phase 1: Foundation](#phase-1-foundation)
6. [Phase 2: Core Components](#phase-2-core-components)
7. [Phase 3: Pages/Views](#phase-3-pagesviews)
8. [Phase 4: Advanced Features](#phase-4-advanced-features)
9. [Phase 5: Polish & Launch](#phase-5-polish--launch)
10. [Risks & Mitigations](#risks--mitigations)
11. [Open Questions](#open-questions)

---

## Project Overview

| Aspect      | Details                                              |
| ----------- | ---------------------------------------------------- |
| **Project** | Operator (OpenClaw fork)                             |
| **Repo**    | https://github.com/Interstellar-code/operator1       |
| **Scope**   | Frontend rewrite only (`ui/` folder)                 |
| **Backend** | Unchanged — Gateway WebSocket API remains the same   |
| **Theme**   | Matrix-inspired (green on black, terminal aesthetic) |

### Why Rewrite?

- **Lit** → Limited ecosystem, fewer ready-made components
- **shadcn/ui** → Beautiful, customizable, massive community
- **React** → Easier to hire/collaborate, better tooling
- **Tailwind** → Rapid styling, consistent design system

---

## Tech Stack Decision

### Proposed Stack

| Layer          | Technology     | Rationale                                 |
| -------------- | -------------- | ----------------------------------------- |
| **Framework**  | React 19       | Industry standard, hooks, ecosystem       |
| **Bundler**    | Vite           | Fast, modern, already used in Operator    |
| **Styling**    | Tailwind CSS   | Utility-first, great with shadcn          |
| **Components** | shadcn/ui      | Copy-paste components, full control       |
| **Routing**    | React Router 7 | Simple, mature                            |
| **State**      | Zustand        | Lightweight, selectors prevent re-renders |
| **Animations** | Framer Motion  | Smooth, declarative                       |
| **Icons**      | Lucide React   | Clean, consistent                         |

### Alternatives Considered

| Option                | Verdict                                              |
| --------------------- | ---------------------------------------------------- |
| Next.js               | Overkill for SPA dashboard                           |
| React Context         | Causes unnecessary re-renders with WebSocket updates |
| Jotai                 | Good, but Zustand has better DevTools                |
| Redux                 | Too much boilerplate for this scope                  |
| Radix primitives only | shadcn wraps these nicely                            |

### Why Zustand for State

Real-time WebSocket events (messages, status changes, snapshots) flow to multiple components. Zustand's selector pattern ensures only affected components re-render:

```tsx
// Store definition
const useGatewayStore = create((set) => ({
  messages: [],
  sessions: [],
  connectionStatus: "disconnected",
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
}));

// Only re-renders when messages change (not on status changes)
const messages = useGatewayStore((s) => s.messages);

// Only re-renders when status changes (not on new messages)
const status = useGatewayStore((s) => s.connectionStatus);
```

Benefits: ~1kb bundle, minimal boilerplate, DevTools support, no Context Provider nesting.

---

## Current State Analysis

### Existing UI Structure (`ui/src/ui/`)

```
ui/src/ui/
├── gateway.ts              # WebSocket client (KEEP/PORT)
├── app.ts                  # Main Lit component
├── views/                  # Page views
│   ├── overview.ts         # Dashboard home
│   ├── chat.ts             # Chat interface
│   ├── sessions.ts         # Session management
│   ├── channels.*.ts       # Channel configs (8+ files)
│   ├── config.ts           # Settings
│   ├── cron.ts             # Scheduled jobs
│   ├── nodes.ts            # Connected devices
│   ├── logs.ts             # Log viewer
│   └── skills.ts           # Skills browser
├── components/             # Reusable components
├── controllers/            # State management
└── types/                  # TypeScript types
```

### Key Integration Points

1. **`gateway.ts`** — WebSocket client to Gateway API
   - Must port this to React hook
   - Handles: connect, auth, events, RPC calls

2. **API Methods** (via WebSocket RPC):
   - `status` — Get gateway status
   - `sessions.list` — List active sessions
   - `sessions.history` — Get chat history
   - `channels.list` — List connected channels
   - `cron.list` — List scheduled jobs
   - `config.get` / `config.set` — Configuration

3. **Events** (pushed from Gateway):
   - `snapshot` — Full state update
   - `session.message` — New chat message
   - `channel.status` — Channel state change

---

## Dependencies

### Phase 1 Dependencies

```json
{
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0",
    "zustand": "^5.0.0",
    "framer-motion": "^11.0.0",
    "lucide-react": "^0.460.0",
    "clsx": "^2.1.0",
    "tailwind-merge": "^2.5.0",
    "@noble/ed25519": "3.0.0",
    "marked": "^17.0.1",
    "dompurify": "^3.3.1"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/dompurify": "^3.0.0",
    "tailwindcss": "^4.0.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "@vitejs/plugin-react": "^4.3.0"
  }
}
```

### Phase 2+ Dependencies

```json
{
  "dependencies": {
    "@radix-ui/react-dialog": "^1.1.0",
    "@radix-ui/react-dropdown-menu": "^2.1.0",
    "@radix-ui/react-tabs": "^1.1.0",
    "@radix-ui/react-scroll-area": "^1.2.0",
    "@radix-ui/react-tooltip": "^1.1.0",
    "@radix-ui/react-select": "^2.1.0",
    "@tanstack/react-virtual": "^3.10.0",
    "shiki": "^1.0.0"
  }
}
```

---

## Phase 1: Foundation

### Migration Strategy

> **Key Decision:** Keep the old Lit UI fully functional while building the new React UI in parallel.

| Route      | UI          | Purpose                                             |
| ---------- | ----------- | --------------------------------------------------- |
| `/ui`      | Old (Lit)   | Production UI, unchanged, receives upstream updates |
| `/ui-next` | New (React) | Development UI, incrementally built                 |

**Why this matters:**

- Can pull upstream fixes/features to `/ui` without conflicts
- No pressure to finish quickly — old UI still works
- Easy A/B comparison during development
- Switch routes when ready: rename `/ui-next` → `/ui`

**Implementation:**

- New React UI lives in `ui-next/` folder (separate from `ui/`)
- Gateway serves both: existing logic for `/ui`, new route for `/ui-next`
- Single toggle in Gateway config to swap default when ready

### Tasks

- [ ] **1.1** Create new `ui-next/` folder structure
  - [ ] Initialize Vite + React + TypeScript
  - [ ] Configure Tailwind CSS
  - [ ] Set up path aliases (`@/`)
  - [ ] Configure build output to `dist/control-ui-next`
  - [ ] Add Gateway route for `/ui-next`
    - [ ] Locate Gateway HTTP server code (`src/gateway/server-http.ts`)
    - [ ] Add route handler for `/ui-next` to serve `dist/control-ui-next`
    - [ ] Ensure WebSocket endpoint remains accessible from new UI
    - [ ] Test both UIs can connect to same Gateway instance
    - [ ] Document environment variable for switching default UI

- [ ] **1.2** Design System — Matrix Theme
  - [ ] Color Palette:
    - [ ] Primary: `#00ff41` (Matrix green)
    - [ ] Background: `#0d0208` (Deep black)
    - [ ] Surface: `#1a1a1a` (Elevated black)
    - [ ] Text: `#00ff41` (Green) / `#e0e0e0` (Muted white)
    - [ ] Accent: `#39ff14` (Neon green)
    - [ ] Error: `#ff0040` (Red)
  - [ ] Typography:
    - [ ] Monospace: `'JetBrains Mono', 'Fira Code', monospace`
    - [ ] Body: `'Space Grotesk', sans-serif` (already used in old UI)
  - [ ] Effects:
    - [ ] Text glow: `text-shadow: 0 0 10px rgba(0, 255, 65, 0.5)`
    - [ ] Border glow: `box-shadow: 0 0 10px rgba(0, 255, 65, 0.3)`
    - [ ] Scanline effect (optional)
    - [ ] CRT flicker animation (optional)
  - [ ] Animations:
    - [ ] Fade in: 200ms ease-out
    - [ ] Slide in: 300ms ease-out
    - [ ] Glow pulse: 2s infinite
  - [ ] Create CSS variables for theming
  - [ ] Create global styles

- [ ] **1.3** shadcn/ui Setup
  - [ ] Install base dependencies
  - [ ] Create `lib/utils.ts` (cn helper)
  - [ ] Port/create core components:
    - [ ] Button
    - [ ] Input
    - [ ] Card
    - [ ] Dialog
    - [ ] Tabs
    - [ ] ScrollArea
    - [ ] Tooltip

- [ ] **1.4** Gateway Client + State
  - [ ] Port `gateway.ts` to TypeScript module
  - [ ] Set up Zustand store (`useGatewayStore`)
  - [ ] Create `useGateway` hook (connects WebSocket → Zustand)
  - [ ] Handle reconnection logic (exponential backoff: 800ms → 15s)
  - [ ] Type all events and responses
  - [ ] **Type Definitions Strategy**
    - [ ] Import types from `src/gateway/protocol/schema/types.ts`
    - [ ] Create type adapters if needed (backend types → UI types)
    - [ ] Set up path aliases to import from `../../../src/gateway/protocol`
    - [ ] Document which types are shared vs UI-specific
    - [ ] Consider generating a types package for cleaner imports
  - [ ] **Device Authentication**
    - [ ] Port device identity logic (`device-identity.ts`, `device-auth.ts`)
    - [ ] Handle secure context requirements (HTTPS vs HTTP)
    - [ ] Implement token storage (localStorage)
    - [ ] Handle device pairing flow
    - [ ] Support fallback to password-only auth
    - [ ] Test auth flow in both secure and insecure contexts
  - [ ] **Advanced WebSocket Features**
    - [ ] Implement exponential backoff reconnection (800ms → 15s)
    - [ ] Handle `snapshot` events for full state sync on connect
    - [ ] Implement sequence number gap detection (`onGap` callback)
    - [ ] Handle `hello-ok` with feature negotiation
    - [ ] Implement tick/heartbeat handling
    - [ ] Test reconnection scenarios (network drop, gateway restart)

### Deliverable

> A working dev environment with Matrix theme, running at `localhost:3000`, connecting to Gateway.

---

## Phase 2: Core Components

### Tasks

- [ ] **2.1** Layout Components
  - [ ] `Shell` — Main app shell with sidebar
  - [ ] `Sidebar` — Navigation menu
  - [ ] `Header` — Top bar with status
  - [ ] `MatrixRain` — Background effect (optional)

- [ ] **2.2** Status Components
  - [ ] `ConnectionStatus` — Online/offline indicator
  - [ ] `StatusCard` — Metric display card
  - [ ] `ChannelBadge` — Channel type indicator

- [ ] **2.3** Data Display
  - [ ] `DataTable` — Sortable, filterable tables
  - [ ] `CodeBlock` — Syntax highlighted code
  - [ ] `JsonViewer` — Collapsible JSON tree
  - [ ] `LogViewer` — Streaming log display
  - [ ] **Markdown Rendering**
    - [ ] Install `marked` (already used in old UI)
    - [ ] Install `dompurify` for XSS protection
    - [ ] Add syntax highlighting library (`shiki` or `prism`)
    - [ ] Handle code blocks with language detection
    - [ ] Support inline code, links, lists, tables
    - [ ] Test with AI-generated markdown (edge cases)

- [ ] **2.4** Form Components
  - [ ] `ConfigForm` — Dynamic form from schema
  - [ ] `SecretInput` — Password with toggle
  - [ ] `Select` — Dropdown with Matrix styling

### Deliverable

> Complete component library, documented with examples.

---

## Phase 3: Pages/Views

### Priority Order

| Priority | Page     | Complexity | Notes                        |
| -------- | -------- | ---------- | ---------------------------- |
| P0       | Overview | Medium     | Dashboard home, key metrics  |
| P0       | Chat     | High       | Real-time messages, markdown |
| P1       | Sessions | Medium     | List, history, status        |
| P1       | Channels | High       | Multiple channel types       |
| P2       | Config   | Medium     | Dynamic config forms         |
| P2       | Cron     | Low        | Job list, next run           |
| P3       | Nodes    | Low        | Device list                  |
| P3       | Logs     | Medium     | Streaming logs               |
| P3       | Skills   | Low        | Skills browser               |

### Tasks

- [ ] **3.1** Overview Page
  - [ ] Connection status
  - [ ] Uptime, version info
  - [ ] Session count
  - [ ] Channel statuses
  - [ ] Quick actions

- [ ] **3.2** Chat Page
  - [ ] Message list with virtual scrolling
  - [ ] Markdown rendering
  - [ ] Code block highlighting
  - [ ] Message input
  - [ ] **Tool Call Rendering**
    - [ ] Display tool invocations (name, params, status)
    - [ ] Show tool results (success/error)
    - [ ] Collapsible tool details
    - [ ] Visual indicators for tool execution state
    - [ ] Handle streaming tool updates
    - [ ] Port logic from `tool-display.ts` and `tool-cards.ts`

- [ ] **3.3** Sessions Page
  - [ ] Session list with filters
  - [ ] Session details panel
  - [ ] History viewer
  - [ ] Session actions (compact, end)

- [ ] **3.4** Channels Pages
  - [ ] Channel list overview
  - [ ] Per-channel config pages:
    - [ ] WhatsApp
    - [ ] Telegram
    - [ ] Discord
    - [ ] Slack
    - [ ] Signal
    - [ ] iMessage
    - [ ] Google Chat

- [ ] **3.5** Config Page
  - [ ] Config editor
  - [ ] Schema-driven forms
  - [ ] Validation feedback
  - [ ] Save/reset actions

- [ ] **3.6** Cron Page
  - [ ] Job list
  - [ ] Next run times
  - [ ] Job details
  - [ ] Run now action

- [ ] **3.7** Nodes Page
  - [ ] Connected devices list
  - [ ] Device capabilities
  - [ ] Connection status

- [ ] **3.8** Logs Page
  - [ ] Log level filter
  - [ ] Real-time streaming
  - [ ] Search/filter
  - [ ] Clear logs

---

## Phase 4: Advanced Features

### Tasks

- [ ] **4.1** Context Window Display (NEW)
  - [ ] Show token count
  - [ ] Show context window size
  - [ ] Usage percentage bar
  - [ ] Per-session breakdown

- [ ] **4.2** Connection Details (NEW)
  - [ ] WebSocket status
  - [ ] Latency indicator
  - [ ] Reconnection attempts
  - [ ] Last message timestamp

- [ ] **4.3** Model Info Display (NEW)
  - [ ] Current model
  - [ ] Provider status
  - [ ] Token limits
  - [ ] Cost tracking (if available)

- [ ] **4.4** Keyboard Shortcuts
  - [ ] Global shortcuts (Ctrl+K for search)
  - [ ] Page-specific shortcuts
  - [ ] Shortcut help modal

- [ ] **4.5** Responsive Design
  - [ ] Mobile breakpoints: 640px (sm), 768px (md), 1024px (lg)
  - [ ] Collapsible sidebar with hamburger menu
  - [ ] Touch-friendly tap targets (min 44px)
  - [ ] Swipe gestures for navigation (optional)
  - [ ] Test on iOS Safari, Android Chrome
  - [ ] Handle safe areas (notch, home indicator)
  - [ ] Optimize for tablet landscape/portrait

---

## Phase 5: Polish & Launch

### Tasks

- [ ] **5.1** Performance
  - [ ] Code splitting by route
  - [ ] Lazy load heavy components
  - [ ] Optimize bundle size
  - [ ] **Virtual Scrolling**
    - [ ] Use `@tanstack/react-virtual` or `react-window`
    - [ ] Apply to chat message list (can be 1000+ messages)
    - [ ] Apply to session history
    - [ ] Apply to log viewer
    - [ ] Test with large datasets (10k+ items)

- [ ] **5.2** Testing
  - [ ] Unit tests for Zustand store (WebSocket state)
  - [ ] Unit tests for utility functions (formatters, parsers)
  - [ ] Component tests with React Testing Library
  - [ ] Integration tests for WebSocket connection flow
  - [ ] E2E tests with Playwright:
    - [ ] Login flow
    - [ ] Send message and receive response
    - [ ] Navigate between pages
    - [ ] Reconnection after disconnect
  - [ ] Visual regression tests (optional, with Percy/Chromatic)
  - [ ] Test coverage target: 70%+ (match existing UI)

- [ ] **5.3** Documentation
  - [ ] Architecture diagram (React → Zustand → WebSocket → Gateway)
  - [ ] Component API documentation
  - [ ] WebSocket event flow diagram
  - [ ] Migration guide for users (switching from `/ui` to `/ui-next`)
  - [ ] Developer setup guide (running both UIs locally)
  - [ ] Troubleshooting guide (common issues)
  - [ ] Component storybook (optional)
  - [ ] README for ui-next folder
  - [ ] Contribution guide

- [ ] **5.4** Build Integration
  - [ ] Add `ui-next:build` script to root `package.json`
  - [ ] Update main build script to include `ui-next`
  - [ ] Verify output to `dist/control-ui-next`
  - [ ] Test Gateway serves both UIs correctly
  - [ ] Add CI/CD checks for `ui-next` build
  - [ ] Document switching from `/ui` to `/ui-next` as default
  - [ ] Plan for deprecating old UI (timeline, migration guide)

- [ ] **5.5** Branding
  - [ ] Update logos/icons
  - [ ] OpenClaw → Operator naming
  - [ ] Favicon
  - [ ] Meta tags

---

## Risks & Mitigations

| Risk                                | Impact | Mitigation                                                              |
| ----------------------------------- | ------ | ----------------------------------------------------------------------- |
| WebSocket state sync bugs           | High   | Extensive testing, reuse existing logic from `gateway.ts`               |
| Device auth complexity              | High   | Port existing code carefully, test all flows (secure/insecure contexts) |
| Performance with large chat history | Medium | Virtual scrolling, pagination, lazy loading                             |
| Upstream changes to old UI          | Low    | Keep `/ui` separate, cherry-pick critical fixes if needed               |
| Timeline slippage                   | Medium | Prioritize P0/P1 features, defer P2/P3 to later iterations              |
| Browser compatibility               | Low    | Test on Chrome, Safari, Firefox; use standard Web APIs                  |
| Type import complexity              | Medium | Set up clean path aliases, consider shared types package                |
| Markdown/XSS vulnerabilities        | Medium | Use `dompurify` for sanitization, test with malicious inputs            |

---

## Open Questions

| #   | Question                                      | Status      | Recommendation                                                       |
| --- | --------------------------------------------- | ----------- | -------------------------------------------------------------------- |
| 1   | Use existing templates or build from scratch? | **Decided** | Build from scratch with shadcn/ui (templates add bloat)              |
| 2   | Keep backward compatibility with old UI?      | **Decided** | No - parallel UIs are enough, clean break is fine                    |
| 3   | Add authentication UI or rely on tokens?      | **Decided** | Keep current flow - device auth + password fallback                  |
| 4   | PWA support needed?                           | **Later**   | Nice to have - add manifest.json, service worker in future phase     |
| 5   | Dark mode only or light mode too?             | **Both**    | Existing UI has light mode, users expect it                          |
| 6   | Internationalization (i18n)?                  | **Later**   | Not needed for MVP, defer to later phase                             |
| 7   | How to handle upstream updates to old UI?     | **Decided** | Keep `/ui` as-is, cherry-pick critical fixes to `/ui-next` if needed |

---

## Timeline (Revised Estimate)

| Phase     | Original      | Realistic     | Notes                                                      |
| --------- | ------------- | ------------- | ---------------------------------------------------------- |
| Phase 1   | 2-3 days      | **4-5 days**  | Auth + WebSocket are complex, need thorough testing        |
| Phase 2   | 3-4 days      | **3-4 days**  | Reasonable with shadcn/ui components                       |
| Phase 3   | 5-7 days      | **7-10 days** | Chat + Channels are substantial, tool rendering is complex |
| Phase 4   | 2-3 days      | **3-4 days**  | Reasonable for advanced features                           |
| Phase 5   | 2-3 days      | **3-5 days**  | Testing and documentation take time                        |
| **Total** | **2-3 weeks** | **3-4 weeks** | With focused effort and minimal blockers                   |

**Key Assumptions:**

- Full-time focused work (6-8 hours/day)
- Minimal context switching
- No major blockers or upstream changes
- Existing Lit UI remains functional for reference

---

## Next Steps

1. ✅ **Review this plan** — Completed with comprehensive improvements
2. ✅ **Answer open questions** — All questions answered with recommendations
3. **Start Phase 1.1** — Create `ui-next/` folder structure
4. **Phase 1.2** — Set up Matrix theme with specific color palette
5. **Phase 1.3** — Install shadcn/ui and core components
6. **Phase 1.4** — Port WebSocket client and authentication (most critical)
7. **Iterate** — Ship incrementally, test thoroughly, get feedback

**Recommended Starting Order:**

1. Start with Phase 1.1 - get the basic Vite + React + TypeScript setup working
2. Get the WebSocket client working (Phase 1.4) - this validates the architecture
3. Build a minimal chat page (Phase 3.2) - this exercises the full stack
4. Then fill in other components and pages

---

_Last updated: 2026-02-06_
