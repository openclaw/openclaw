# Kiến Trúc Tổng Quan — OpenClaw UI (`ui-next`)

## Stack Công Nghệ

| Thành phần | Chi tiết                                            |
| ---------- | --------------------------------------------------- |
| Framework  | **Next.js 16** (App Router, `"use client"` pages)   |
| Language   | **TypeScript 5** + **React 19**                     |
| Styling    | **Tailwind CSS v4** + CSS Variables (design tokens) |
| Fonts      | **Inter** (Google Fonts, biến `--font-inter`)       |
| Mono font  | `JetBrains Mono` (qua CSS var `--mono`)             |
| Crypto     | `@noble/ed25519` — ký device identity qua Ed25519   |
| Dev port   | `5174` (lệnh `npm run dev`)                         |

---

## Cây Thư Mục

```
ui-next/
├── app/                         # Next.js App Router pages
│   ├── layout.tsx               # Root layout: Topbar + Nav + <main>
│   ├── page.tsx                 # Trang Overview (/)
│   ├── globals.css              # Design tokens (CSS variables) + base reset
│   ├── chat/
│   │   └── page.tsx             # Trang Chat (/chat)
│   ├── agents/
│   │   └── page.tsx             # Trang Agents (/agents)
│   ├── sessions/
│   │   └── page.tsx             # Trang Sessions (/sessions)
│   ├── channels/
│   │   └── page.tsx             # Trang Channels (/channels)
│   ├── skills/
│   │   └── page.tsx             # Trang Skills (/skills)
│   ├── cron/
│   │   └── page.tsx             # Trang Automations/Cron (/cron)
│   ├── config/
│   │   └── page.tsx             # Trang Config (/config)
│   ├── logs/
│   │   └── page.tsx             # Trang Logs (/logs)
│   └── settings/
│       └── page.tsx             # Trang Settings (/settings)
│
├── components/                  # Shared UI components
│   ├── nav.tsx                  # Sidebar navigation
│   └── topbar.tsx               # Top header bar + theme toggle
│
├── lib/                         # Utilities & hooks
│   ├── types.ts                 # TypeScript types (gateway data models)
│   ├── gateway.ts               # GatewayClient (WebSocket class)
│   ├── use-gateway.ts           # React hook: useGateway, useGatewayEvents
│   ├── use-settings.ts          # React hook: useSettings (localStorage)
│   ├── storage.ts               # loadSettings / saveSettings (localStorage)
│   ├── format.ts                # Utility functions: format thời gian, token...
│   ├── device-auth.ts           # Device auth token (localStorage)
│   ├── device-identity.ts       # Device identity + Ed25519 key pair
│   └── cn.ts                    # classnames utility
│
├── public/                      # Static assets
├── next.config.ts               # Next.js config
├── tsconfig.json                # TypeScript config
└── package.json                 # Dependencies
```

---

## Kiến Trúc Tổng Thể

```
Browser
  │
  ├── [Root Layout] layout.tsx
  │     ├── <Topbar />   — brand + theme toggle (dark/light/system)
  │     ├── <Nav />      — sidebar navigation (grouped links)
  │     └── <main>       — nội dung page
  │
  └── Pages (App Router)
        ├── Mỗi page là một Client Component ("use client")
        ├── Gọi useGateway() để lấy { state, request }
        └── Giao tiếp với backend qua WebSocket (GatewayClient)
                │
                ▼
        OpenClaw Gateway (WebSocket Server)
          ├── sessions.list / sessions.patch / sessions.remove / sessions.reset
          ├── chat.history / chat.send
          ├── agents.list / agents.files.list
          ├── channels.status
          ├── skills.status
          ├── cron.jobs / cron.runs
          ├── config.get / config.set
          └── logs.stream / logs.get
```

---

## Layout Grid (`globals.css` - `.shell`)

Toàn bộ giao diện dùng CSS Grid với layout 2 cột, 2 hàng:

```
┌─────────────────────────────────────────┐
│ topbar (56px, spanning full width)       │
├──────────────┬──────────────────────────┤
│ nav (220px)  │ content (fill)           │
│              │                          │
│              │  (page renders here)     │
└──────────────┴──────────────────────────┘
```

```css
.shell {
  display: grid;
  grid-template-columns: var(--nav-width) minmax(0, 1fr);
  grid-template-rows: var(--topbar-height) 1fr;
  grid-template-areas:
    "topbar topbar"
    "nav    content";
}
```

---

## Luồng Xác Thực Gateway

1. **WebSocket mở** → server gửi `connect.challenge` event (với `nonce`)
2. **GatewayClient** nhận nonce, tạo/load `DeviceIdentity` (Ed25519 key pair)
3. Gửi `connect` request với payload được ký bằng private key
4. Server trả về `hello-ok` với `auth.deviceToken`
5. Token được lưu vào `localStorage` để dùng lại cho lần sau

> Nếu chạy qua HTTP (không phải HTTPS/localhost), `crypto.subtle` không khả dụng,
> client bỏ qua device identity và fallback về token-only auth.

---

## State Management

UI không dùng Redux hay Zustand. Toàn bộ state được quản lý thông qua:

| Cơ chế                                     | Dùng cho                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `useState` / `useCallback` trong từng page | Local UI state                                                          |
| `useSyncExternalStore`                     | Theme state (Topbar), Settings (useSettings)                            |
| `localStorage`                             | Cài đặt (`openclaw.control.settings.v1`), device token, device identity |
| WebSocket (`GatewayClient`)                | Real-time communication với backend                                     |

---

## Dependency Graph (main)

```
page.tsx
  └── useGateway (use-gateway.ts)
        └── GatewayClient (gateway.ts)
              ├── device-auth.ts
              └── device-identity.ts (@noble/ed25519)

settings/page.tsx
  └── useSettings (use-settings.ts)
        └── loadSettings / saveSettings (storage.ts)

topbar.tsx
  └── useSyncExternalStore (theme stored in localStorage)
```
