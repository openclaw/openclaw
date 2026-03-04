# Các Trang (Pages) — OpenClaw UI

Tất cả các trang đều là **Client Components** (`"use client"`), kết nối tới gateway qua hook `useGateway()`.

---

## 📍 Overview — `/`

**File**: `app/page.tsx`

Trang chủ, hiển thị trạng thái tổng quan của gateway.

### Nội dung

- **Stats grid** (4 thẻ): Status, Messages Today, Active Agents, Channels
- **Gateway card**: Thông báo kết nối gateway

### Lưu ý

- Các stat hiện tại là placeholder (`—`), chưa fetch data từ gateway.
- Status được hiển thị static là "Online" với màu `var(--ok)`.

---

## 💬 Chat — `/chat`

**File**: `app/chat/page.tsx`

Giao diện chat trực tiếp với AI agent.

### Layout

- **Sidebar trái (240px)**: Danh sách sessions
- **Khu vực chat (phần còn lại)**: Message bubbles + compose box

### State

| State                 | Kiểu                  | Mô tả                  |
| --------------------- | --------------------- | ---------------------- |
| `sessions`            | `GatewaySessionRow[]` | Danh sách sessions     |
| `selectedSessionKey`  | `string \| null`      | Session đang hoạt động |
| `messages`            | `ChatMessage[]`       | Lịch sử tin nhắn       |
| `draft`               | `string`              | Nội dung đang soạn     |
| `loading` / `sending` | `boolean`             | Loading states         |

### Gateway Methods

| Method           | Params                                      | Mô tả                  |
| ---------------- | ------------------------------------------- | ---------------------- |
| `sessions.list`  | `{}`                                        | Lấy danh sách sessions |
| `chat.history`   | `{ sessionKey }`                            | Lấy lịch sử tin nhắn   |
| `chat.send`      | `{ sessionKey, message, idempotencyKey }`   | Gửi tin nhắn           |
| `sessions.reset` | `{ reason: "new", key: "agent:main:main" }` | Tạo session mới        |

### Luồng hoạt động

1. Khi `state === "connected"` → gọi `sessions.list` tự động
2. Khi chọn session → gọi `chat.history`
3. Khi gửi tin → optimistic update (thêm message ngay) → gọi `chat.send`
4. Nhấn `Enter` (không Shift) → gửi; `Shift+Enter` → xuống dòng

### Component con

- **`Message`**: Render một tin nhắn (hỗ trợ `string` content hoặc `{ type, text }[]` array)

### Types cục bộ

```ts
type ChatMessage = {
  idempotencyKey?: string;
  role: "user" | "assistant" | "system";
  content: string | { type: string; text: string }[];
  timestamp?: number;
};
```

---

## 🤖 Agents — `/agents`

**File**: `app/agents/page.tsx`

Quản lý các AI agent.

### Layout

- **Sidebar trái (280px)**: Danh sách agents
- **Khu vực chính**: Header agent + tabs + nội dung tab

### Tabs

| Tab       | Trạng thái            |
| --------- | --------------------- |
| Overview  | ✅ Hoàn chỉnh         |
| Files     | ✅ Hiển thị file list |
| Tools     | 🚧 Coming soon        |
| Skills    | 🚧 Coming soon        |
| Channels  | 🚧 Coming soon        |
| Cron Jobs | 🚧 Coming soon        |

### Gateway Methods

| Method              | Params        | Mô tả                   |
| ------------------- | ------------- | ----------------------- |
| `agents.list`       | `{}`          | Lấy danh sách agents    |
| `agents.files.list` | `{ agentId }` | Lấy file list của agent |

### Hiển thị agent

- Avatar: emoji từ `identity.emoji` hoặc chữ cái đầu tên
- Badge "default" nếu `agentId === defaultId`
- Thông tin: Agent ID, Display Name, Status (static "Active"), Role

---

## 📋 Sessions — `/sessions`

**File**: `app/sessions/page.tsx`

Quản lý sessions với filter và per-session overrides.

### Bảng dữ liệu (9 cột)

| Cột       | Mô tả                                                              |
| --------- | ------------------------------------------------------------------ |
| Key       | Session key (link tới `/chat?session=...` nếu `kind !== "global"`) |
| Label     | Input chỉnh sửa label                                              |
| Kind      | `direct` / `group` / `global` / `unknown`                          |
| Updated   | Thời gian cập nhật (relative)                                      |
| Tokens    | `totalTokens / contextTokens`                                      |
| Thinking  | Dropdown chỉnh `thinkingLevel`                                     |
| Verbose   | Dropdown chỉnh `verboseLevel`                                      |
| Reasoning | Dropdown chỉnh `reasoningLevel`                                    |
| Actions   | Nút Delete                                                         |

### Filters

- **Active within (minutes)**: Lọc session theo thời gian hoạt động (mặc định: 60)
- **Limit**: Giới hạn số session (mặc định: 100)
- **Include global**: Bao gồm global sessions
- **Include unknown**: Bao gồm unknown sessions

### Gateway Methods

| Method            | Params                                                            | Mô tả            |
| ----------------- | ----------------------------------------------------------------- | ---------------- |
| `sessions.list`   | `{ activeMinutes, limit, includeGlobal, includeUnknown }`         | Lấy danh sách    |
| `sessions.patch`  | `{ key, label?, thinkingLevel?, verboseLevel?, reasoningLevel? }` | Cập nhật session |
| `sessions.remove` | `{ key }`                                                         | Xóa session      |

### Logic đặc biệt

- **Binary thinking providers** (z.ai / zai): `thinkingLevel` chỉ có `off` / `on`, khi patch gửi `"low"` thay vì `"on"`
- Dropdown thinking tự động resolve dựa vào `row.modelProvider`

---

## 📡 Channels — `/channels`

**File**: `app/channels/page.tsx`

Hiển thị trạng thái các kênh chat: Telegram, Discord, Slack, WhatsApp, v.v.

### Layout

- Grid responsive `repeat(auto-fill, minmax(340px, 1fr))`
- Mỗi channel → một `ChannelCard`
- Channels có enabled=true hiển thị trước, disabled opacity 0.6

### Gateway Methods

| Method            | Params | Mô tả                               |
| ----------------- | ------ | ----------------------------------- |
| `channels.status` | `{}`   | Lấy toàn bộ channel status snapshot |

### Components con

- **`ChannelCard`**: Hiển thị trạng thái 1 channel và danh sách accounts
- **`AccountCard`**: Chi tiết 1 account (running, configured, connected, last error)

### Logic xác định status

- `running: true` → "Yes"
- `lastInboundAt < 10 phút` → "Active"
- Còn lại → "No"

### Raw data

Có nút "Show Raw" để hiển thị JSON snapshot đầy đủ.

---

## ⚡ Skills — `/skills`

**File**: `app/skills/page.tsx`

Xem và quản lý các skill của agent.

> _(Xem chi tiết implementation trong file, khoảng 17KB)_

---

## ⏰ Automations (Cron) — `/cron`

**File**: `app/cron/page.tsx`

Quản lý cron jobs (tự động hóa).

> _(Xem chi tiết implementation trong file, khoảng 17.2KB)_

### Types liên quan (từ `lib/types.ts`)

- `CronJob` — một cron job với schedule, payload, delivery
- `CronSchedule` — có 3 loại: `at`, `every`, `cron` (expr)
- `CronPayload` — `systemEvent` hoặc `agentTurn`
- `CronRunLogEntry` — log mỗi lần chạy

---

## ⚙️ Config — `/config`

**File**: `app/config/page.tsx`

Xem và chỉnh sửa config file của gateway.

> _(Xem chi tiết implementation trong file, khoảng 10.5KB)_

---

## 📄 Logs — `/logs`

**File**: `app/logs/page.tsx`

Xem log của gateway.

### Types

```ts
type LogEntry = {
  raw: string;
  time?: string | null;
  level?: LogLevel | null; // "trace" | "debug" | "info" | "warn" | "error" | "fatal"
  subsystem?: string | null;
  message?: string | null;
  meta?: Record<string, unknown> | null;
};
```

---

## 🔧 Settings — `/settings`

**File**: `app/settings/page.tsx`

Cấu hình kết nối gateway.

### Các field

| Field       | Mô tả                                 |
| ----------- | ------------------------------------- |
| Gateway URL | WebSocket URL (`ws://` hoặc `wss://`) |
| Token       | Auth token (hiển thị dạng password)   |

### Hành động

- **Save**: Lưu vào localStorage qua `updateSettings()`
- **Reset to Default**: Đặt lại theo URL hiện tại của trình duyệt

### Hint cho dev local

```
pnpm gateway:dev  →  ws://localhost:18789
```

---

## Sơ Đồ Navigation (Nav Groups)

```
Main
├── Overview    /
├── Chat        /chat
├── Agents      /agents
└── Sessions    /sessions

Configure
├── Channels    /channels
├── Skills      /skills
├── Automations /cron
└── Config      /config

System
├── Logs        /logs
└── Settings    /settings
```
