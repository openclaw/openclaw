# Views & Controllers — OpenClaw UI (`ui/`)

Mỗi tab trong UI có:

- **View** (`src/ui/views/*.ts`): Lit template function nhận props object, render HTML
- **Controller** (`src/ui/controllers/*.ts`): Async functions gọi gateway API, update state

---

## Pattern Chung

```ts
// View (views/sessions.ts)
export function renderSessions(props: SessionsViewProps) {
  return html`...`;
}

// Controller (controllers/sessions.ts)
export async function loadSessions(host: SessionsHost) {
  host.sessionsLoading = true;
  try {
    const result = await host.client!.request("sessions.list", { ... });
    host.sessionsResult = result;
  } catch (err) {
    host.sessionsError = String(err);
  } finally {
    host.sessionsLoading = false;
  }
}
```

---

## 💬 Chat — Tab `"chat"`

**View**: `views/chat.ts` (18.6KB)  
**Controllers**: `controllers/chat.ts`, `app-chat.ts`

### Props truyền vào `renderChat()`

- `connected`, `loading`, `sending`
- `sessionKey`, `messages`, `chattools`, `stream`
- `sidebarOpen`, `sidebarContent`, `splitRatio`
- Callbacks: `onSend`, `onAbort`, `onScroll`, `onOpenSidebar`, `onCloseSidebar`, `onSplitRatioChange`

### Controllers

| Function                         | Gateway Method   | Mô tả                                  |
| -------------------------------- | ---------------- | -------------------------------------- |
| `loadChatHistory(host)`          | `chat.history`   | Load lịch sử tin nhắn session hiện tại |
| `handleChatEvent(host, payload)` | (event listener) | Xử lý `"chat"` events từ gateway       |

### Chat Event States

`handleChatEvent()` trả về một trong: `"none" | "started" | "delta" | "tool" | "final" | "error" | "aborted"`

### Chat Message Types (`chat/message-normalizer.ts`)

Messages được normalize về `NormalizedMessage[]`:

```ts
type NormalizedMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: ContentBlock[];
  // ...
};
```

### Tool Streaming (`app-tool-stream.ts`)

Khi AI chạy tool, UI nhận stream events → render tool output trong sidebar:

- `CompactionStatus`: Context window đã bị compact
- `FallbackStatus`: Model đã fallback sang model khác
- `ToolStreamEntry`: Mỗi tool call đang chạy

---

## 📊 Overview — Tab `"overview"`

**View**: `views/overview.ts` (13.8KB)  
**Controller**: `app-settings.ts` > `loadOverview()`

### Nội dung

- Status card (connected/disconnected, version)
- Session key selector
- Presence count, Sessions count
- Cron status (enabled/next run)
- Channels last refresh timestamp

### Data Sources

- `hello` (từ `onHello` callback)
- `presenceEntries` (từ `"presence"` events)
- `sessionsResult` (từ `sessions.list` call)
- `cronStatus` (từ `cron.status` call)
- `channelsLastSuccess` (timestamp)

---

## 📡 Channels — Tab `"channels"`

**View**: `views/channels.ts` (10.8KB) + channel-specific files  
**Controller**: `controllers/channels.ts`

### Channel-Specific Views

| File                     | Channel                                |
| ------------------------ | -------------------------------------- |
| `channels.telegram.ts`   | Telegram Bot                           |
| `channels.discord.ts`    | Discord                                |
| `channels.whatsapp.ts`   | WhatsApp (includes QR code login flow) |
| `channels.slack.ts`      | Slack                                  |
| `channels.signal.ts`     | Signal                                 |
| `channels.nostr.ts`      | Nostr + profile editor                 |
| `channels.googlechat.ts` | Google Chat                            |
| `channels.imessage.ts`   | iMessage                               |

### WhatsApp Flow Đặc Biệt

1. User click "Start" → `handleWhatsAppStart(force)`
2. Gateway trả về QR code data URL
3. UI hiển thị QR để user quét
4. Sau khi quét → `handleWhatsAppWait()` để chờ connected
5. `whatsappLoginConnected = true` → done

### Nostr Profile Form

State: `nostrProfileFormState: NostrProfileFormState | null`

- `handleNostrProfileEdit(accountId, profile)` → mở form
- `handleNostrProfileFieldChange(field, value)` → update field
- `handleNostrProfileSave()` → lưu, `handleNostrProfileImport()` → import từ relay

---

## 📋 Sessions — Tab `"sessions"`

**View**: `views/sessions.ts` (10.0KB)  
**Controller**: `controllers/sessions.ts`

### Controllers

| Function                             | Gateway Method    | Mô tả                       |
| ------------------------------------ | ----------------- | --------------------------- |
| `loadSessions(host, opts?)`          | `sessions.list`   | Lấy danh sách sessions      |
| `patchSession(host, key, patch)`     | `sessions.patch`  | Cập nhật session properties |
| `deleteSessionAndRefresh(host, key)` | `sessions.remove` | Xóa và reload               |

---

## 🤖 Agents — Tab `"agents"`

**View**: `views/agents.ts` (19.3KB) + panels  
**Controllers**: `controllers/agents.ts`, `agent-files.ts`, `agent-identity.ts`, `agent-skills.ts`

### Panels trong Agents (sub-navigation)

```
agents → panels: "overview" | "files" | "tools" | "skills" | "channels" | "cron"
```

| Panel    | View file                                | Controller                                                |
| -------- | ---------------------------------------- | --------------------------------------------------------- |
| overview | `agents.ts`                              | `loadAgents`, `loadAgentIdentity`                         |
| files    | `agents-panels-status-files.ts` (17KB)   | `loadAgentFiles`, `loadAgentFileContent`, `saveAgentFile` |
| tools    | `agents-panels-tools-skills.ts` (18.8KB) | `loadToolsCatalog`                                        |
| skills   | `agents-panels-tools-skills.ts`          | `loadAgentSkills`                                         |
| channels | (embeds channels view)                   | `loadChannels`                                            |
| cron     | (embeds cron view)                       | `loadCron`                                                |

### File Editor

Khi chọn file trong panel "files":

- Load file content → `agent.files.get`
- Tạo draft copy trong `agentFileDrafts`
- Nút Save → `saveAgentFile()` → `agent.files.set`

### Tool Catalog

- Hiển thị tất cả tools available cho agent
- Groups: `ToolCatalogGroup[]` (core + plugins)
- Profiles: `ToolCatalogProfile[]` (minimal/coding/messaging/full)
- Cho phép chỉnh tools profile → update config form → save config

---

## ⚡ Skills — Tab `"skills"`

**View**: `views/skills.ts` (6.4KB)  
**Controller**: `controllers/skills.ts`

### Controllers

| Function                                 | Gateway Method          | Mô tả                                 |
| ---------------------------------------- | ----------------------- | ------------------------------------- |
| `loadSkills(host)`                       | `skills.status`         | Lấy danh sách skills + install status |
| `updateSkillEnabled(host, key, enabled)` | `skills.enable/disable` | Bật/tắt skill                         |
| `installSkill(host, key)`                | `skills.install`        | Cài đặt skill                         |
| `saveSkillApiKey(host, key, apiKey)`     | `skills.apiKey.set`     | Lưu API key cho skill                 |

### `SkillStatusEntry` fields quan trọng

- `eligible`: Skill có đủ requirements không
- `missing.bins`: Binaries còn thiếu
- `missing.env`: Env vars còn thiếu
- `install`: Hướng dẫn install (brew/node/go/uv)
- `bundled`: Có phải built-in skill không

---

## ⏰ Cron — Tab `"cron"`

**View**: `views/cron.ts` (56KB — **file lớn nhất**)  
**Controller**: `controllers/cron.ts` (23.7KB)

### Tính năng

- List jobs với sort/filter
- Pagination (load more)
- CRUD: Add, Edit (inline form), Clone, Delete
- Toggle enabled/disabled
- Manual run
- Run history (cron runs với filter/sort/pagination)
- Delivery status tracking

### Cron Form State

```ts
type CronFormState = {
  name: string;
  description: string;
  enabled: boolean;
  deleteAfterRun: boolean;
  scheduleKind: "at" | "every" | "cron";
  scheduledAt: string; // ISO datetime (for "at" kind)
  everyMs: string; // ms value (for "every" kind)
  everyUnit: string; // "ms" | "s" | "min" | "hr" | "day"
  cronExpr: string; // Cron expression (for "cron" kind)
  cronTz: string; // Timezone
  cronStaggerMs: string;
  payloadKind: "systemEvent" | "agentTurn";
  payloadText: string; // systemEvent text
  payloadMessage: string; // agentTurn message
  payloadModel: string;
  payloadThinking: string;
  payloadTimeoutSeconds: string;
  sessionTarget: "main" | "isolated";
  wakeMode: "next-heartbeat" | "now";
  agentId: string;
  deliveryMode: "none" | "announce" | "webhook";
  deliveryChannel: string;
  deliveryTo: string;
  deliveryBestEffort: boolean;
};
```

---

## ⚙️ Config — Tab `"config"`

**View**: `views/config.ts` (30KB) + `config-form*.ts`  
**Controller**: `controllers/config.ts`

### Hai mode hiển thị

1. **Form mode** (`configFormMode: "form"`): UI form tự động generate từ JSON schema + `configUiHints`
2. **Raw mode** (`configFormMode: "raw"`): Textarea chỉnh JSON trực tiếp

### Config Schema

- Load từ gateway: `config.schema`
- Kèm `configUiHints: ConfigUiHints` (labels, order, advanced/sensitive fields)
- Form analyzer (`config-form.analyze.ts`): Parse schema → generate form structure

### Controllers

| Function            | Gateway Method  | Mô tả                           |
| ------------------- | --------------- | ------------------------------- |
| `loadConfig(host)`  | `config.get`    | Load snapshot hiện tại          |
| `saveConfig(host)`  | `config.set`    | Lưu changes                     |
| `applyConfig(host)` | `config.apply`  | Apply config (restart services) |
| `runUpdate(host)`   | `system.update` | Chạy update                     |

---

## 🐛 Debug — Tab `"debug"`

**View**: `views/debug.ts` (5.4KB)  
**Controller**: `controllers/debug.ts`

### Tính năng

- System status summary (`debug.status`)
- Health snapshot (`debug.health`)
- Model list (`debug.models`)
- Raw call: gọi bất kỳ gateway method nào với JSON params
- Event log: History của gateway events nhận được

---

## 📄 Logs — Tab `"logs"`

**View**: `views/logs.ts` (4.8KB)  
**Controller**: `controllers/logs.ts`

### Tính năng

- Load from gateway: `logs.get` với cursor-based pagination
- Auto-follow (scroll bottom khi có log mới)
- Filter theo text và level (`trace|debug|info|warn|error|fatal`)
- Level filter badges
- Export logs (download .txt)
- Polling interval khi tab active

### Log entry parsing

Log được parse từ JSON lines, extract `time`, `level`, `subsystem`, `message`, `meta`.

---

## 🖥️ Instances — Tab `"instances"`

**View**: `views/instances.ts` (3.1KB)  
**Controller**: `controllers/presence.ts`

Hiển thị các gateway instances đang active (presence entries).  
Data được cập nhật qua `"presence"` events từ gateway.

---

## 🔌 Nodes — Tab `"nodes"`

**View**: `views/nodes.ts` (18KB) + `nodes-exec-approvals.ts` (22KB)  
**Controller**: `controllers/nodes.ts`, `controllers/exec-approvals.ts`

- Node list (remote OpenClaw nodes kết nối)
- Exec approval management (per-node approval policies)
- Exec Approval Queue: Real-time queue nhận `exec.approval.requested` events

---

## 📈 Usage — Tab `"usage"`

**View**: `views/usage.ts` (29.6KB) + render helpers  
**Controller**: `controllers/usage.ts`

### Tính năng phong phú nhất

- Date range filter (start/end date)
- Session list với sort/filter
- Token usage charts (daily bar, time series line)
- Cost analytics (nếu có pricing)
- Per-session drill-down:
  - Token timeline per turn
  - Session log (messages với role/tool filter)
- Recent sessions tracking
- Timezone support (local/UTC)
- Visible columns customization
