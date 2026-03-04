# Phân Tích Chat — OpenClaw UI (`ui/`)

Tài liệu này phân tích toàn bộ hệ thống chat trong dự án `ui/`, bao gồm luồng gửi tin nhắn, xử lý events, render messages, và tool streaming.

---

## Tổng Quan Hệ Thống Chat

Chat trong `ui/` phức tạp hơn nhiều so với `ui-next/` do hỗ trợ:

- **Real-time streaming** (typing effect)
- **Tool call display** (xem AI đang dùng tool gì)
- **Image attachments** (paste ảnh)
- **Message queue** (gửi khi đang busy)
- **Focus mode** (full-screen chat)
- **Context compaction** indicators
- **Model fallback** notifications
- **Thinking/reasoning** display

---

## Các File Liên Quan

```
ui/src/ui/
├── views/chat.ts              # Render function chính (617 dòng)
├── app-chat.ts                # handleSendChat, enqueueChatMessage, flushQueue
├── controllers/chat.ts        # loadChatHistory, sendChatMessage, handleChatEvent
├── app-tool-stream.ts         # Tool streaming + compaction/fallback events
├── chat/
│   ├── grouped-render.ts      # renderMessageGroup, renderStreamingGroup
│   ├── message-normalizer.ts  # normalizeMessage, normalizeRoleForGrouping
│   ├── message-extract.ts     # extractText, extractThinking (with caching)
│   ├── tool-cards.ts          # extractToolCards, renderToolCardSidebar
│   ├── copy-as-markdown.ts    # Copy button cho assistant messages
│   └── constants.ts           # Chat constants
└── components/
    └── resizable-divider.ts   # Draggable split panel divider
```

---

## State Chat (trong `OpenClawApp`)

```ts
sessionKey: string              // Session đang xem
chatLoading: boolean            // Đang fetch history
chatSending: boolean            // Đang gửi request
chatMessage: string             // Draft input
chatMessages: unknown[]         // History messages
chatToolMessages: unknown[]     // Tool messages (từ streaming)
chatStream: string | null       // Response đang stream (text delta)
chatStreamStartedAt: number | null
chatRunId: string | null        // UUID của run đang chạy
compactionStatus: CompactionStatus | null  // Context compaction state
fallbackStatus: FallbackStatus | null      // Model fallback state
chatAvatarUrl: string | null    // URL avatar agent
chatThinkingLevel: string | null
chatQueue: ChatQueueItem[]      // Queue khi gửi lúc AI đang trả lời
chatAttachments: ChatAttachment[]  // Images chờ gửi
chatManualRefreshInFlight: boolean
chatNewMessagesBelow: boolean   // Hiện button "scroll to bottom"
sidebarOpen: boolean            // Tool output panel
sidebarContent: string | null
splitRatio: number              // 0.4–0.7
```

---

## Luồng Gửi Tin Nhắn

```
User nhấn Enter / click Send
  │
  ▼
handleSendChat(host, messageOverride?, opts?)
  │
  ├── Check: !connected → return
  ├── Check: empty message && no attachments → return
  │
  ├── isChatStopCommand(message)?
  │     └── "/stop" | "stop" | "esc" | "abort" | "wait" | "exit"
  │           → handleAbortChat() → client.request("chat.abort", ...)
  │
  ├── isChatResetCommand(message)?
  │     └── "/new" | "/reset" | "/new ..." | "/reset ..."
  │           → refreshSessions = true (reload sessions sau khi gửi)
  │
  ├── isChatBusy()? (chatSending || chatRunId !== null)
  │     → enqueueChatMessage() → thêm vào chatQueue
  │     → return (send sau khi AI trả lời xong)
  │
  └── sendChatMessageNow()
        ├── resetToolStream()          → clear tool messages
        ├── sendChatMessage()          → gọi gateway API
        │     ├── Optimistic update: thêm user message vào chatMessages[]
        │     ├── Đặt: chatSending=true, chatRunId=UUID, chatStream=""
        │     └── client.request("chat.send", { sessionKey, message, idempotencyKey, attachments })
        │
        ├── Nếu error: khôi phục draft, thêm error assistant message
        ├── Nếu ok: setLastActiveSessionKey()
        └── scheduleChatScroll()       → scroll xuống cuối
```

---

## Luồng Nhận Response (Gateway Events)

```
Gateway gửi event { type: "event", event: "chat", payload: { ... } }
  │
  ▼
handleGatewayEvent(host, evt)
  └── evt.event === "chat" → handleChatGatewayEvent(host, payload)
        │
        ├── setLastActiveSessionKey(payload.sessionKey)
        └── handleChatEvent(host, payload)

handleChatEvent(host, payload):
  │
  ├── payload.sessionKey !== host.sessionKey → bỏ qua (wrong session)
  │
  ├── payload.runId !== host.chatRunId? (sub-agent announce)
  │     └── state === "final" → thêm message vào chatMessages[], return null
  │
  ├── state === "delta"
  │     └── extractText(payload.message) → update chatStream (text tích lũy)
  │          (nếu next.length >= current.length → cập nhật)
  │
  ├── state === "final"
  │     ├── normalizeFinalAssistantMessage(payload.message)
  │     ├── Thêm vào chatMessages[]
  │     ├── chatStream = null, chatRunId = null
  │     └── shouldReloadHistoryForFinalEvent? → loadChatHistory()
  │
  ├── state === "aborted"
  │     ├── normalizeAbortedAssistantMessage() → nếu có, thêm vào chatMessages[]
  │     ├── Nếu không có, dùng streamed text nếu có
  │     └── chatStream = null, chatRunId = null
  │
  └── state === "error"
        └── chatStream = null, chatRunId = null, lastError = payload.errorMessage

ChatEventPayload type:
  { runId: string, sessionKey: string, state: "delta"|"final"|"aborted"|"error",
    message?: unknown, errorMessage?: string }
```

---

## Tool Streaming (`app-tool-stream.ts`)

Khi AI gọi tool, gateway gửi `"agent"` events với `payload.stream === "tool"`.

### Tool Event Phases

```
agent event, stream="tool", data.phase:
  "start"  → Tạo ToolStreamEntry mới (tool bắt đầu chạy)
  "update" → Update partial result (tool đang chạy, có kết quả tạm)
  "result" → Kết quả cuối cùng của tool
```

### ToolStreamEntry

```ts
type ToolStreamEntry = {
  toolCallId: string; // ID duy nhất của tool call
  runId: string; // Run AI đang chạy
  name: string; // Tên tool (ví dụ: "read_file")
  args?: unknown; // Arguments truyền vào tool
  output?: string; // Kết quả tool (truncated tại 120,000 chars)
  startedAt: number;
  updatedAt: number;
  message: Record<string, unknown>; // Lit-friendly message object
};
```

### Throttling

Tool stream updates được throttle **80ms** để không re-render quá nhiều:

```ts
const TOOL_STREAM_THROTTLE_MS = 80;
```

Khi `phase === "result"` → force immediate sync (không throttle).

### Limits

- Tối đa **50 tool calls** trong stream cùng lúc (`TOOL_STREAM_LIMIT`)
- Tool output tối đa **120,000 chars** (sau đó truncate)

### Tool Output trong Sidebar

Tool cards render như `renderToolCardSidebar(card, onOpenSidebar)`.  
Khi click → `onOpenSidebar(content)` → hiện sidebar bên phải với nội dung tool.

---

## Agent Events Khác

### Compaction Events

```
agent event, stream="compaction", data.phase: "start" | "end"
  "start" → CompactionStatus = { active: true, ... }
             → UI hiện "Compacting context..." badge
  "end"   → CompactionStatus = { active: false, completedAt: now }
             → UI hiện "✓ Context compacted" 5 giây
```

### Fallback Events

```
agent event, stream="lifecycle" | "fallback", data.phase: "fallback" | "fallback_cleared"
  → Hiện FallbackStatus toast trong 8 giây
  → "Fallback active: provider/model (reason)"
  → "✓ Fallback cleared: original-model"
```

---

## Chat Queue

Nếu user gửi message khi AI đang trả lời (`isChatBusy() === true`):

```ts
type ChatQueueItem = {
  id: string;
  text: string;
  createdAt: number;
  attachments?: ChatAttachment[];
  refreshSessions?: boolean;
};
```

- Message được thêm vào `chatQueue[]`
- UI hiển thị "Queued (N)" với list và nút xóa từng item
- Khi AI trả lời xong (`state === "final"` hoặc `"aborted"`) → `flushChatQueue()` tự động gửi item tiếp theo

---

## Render Architecture

### `buildChatItems(props)` → pipeline tạo chat items

```
props.messages (history)
  │
  ├── Slice to last CHAT_HISTORY_RENDER_LIMIT=200
  ├── Nếu bị slice: thêm system notice "Showing last 200 messages"
  ├── Check __openclaw.kind === "compaction" → ChatItem { kind: "divider" }
  ├── showThinking=false && role="toolresult" → skip
  └── else → ChatItem { kind: "message" }

props.toolMessages (tool stream)
  └── showThinking=true → thêm vào items

props.stream (live stream)
  ├── stream.trim().length > 0 → ChatItem { kind: "stream" }
  └── stream === "" → ChatItem { kind: "reading-indicator" } (loading dots)

groupMessages(items)
  └── Gộp messages liền kề cùng role → MessageGroup { kind: "group", role, messages[] }
```

### Các ChatItem kinds

| Kind                  | Render                                            |
| --------------------- | ------------------------------------------------- |
| `"group"`             | `renderMessageGroup()` — grouped messages by role |
| `"stream"`            | `renderStreamingGroup()` — live streaming text    |
| `"reading-indicator"` | `renderReadingIndicatorGroup()` — animating dots  |
| `"divider"`           | Divider với label (e.g., "Compaction")            |

### Message Key Strategy (`messageKey()`)

Ưu tiên theo thứ tự:

1. `toolCallId` → `"tool:<id>"`
2. `id` → `"msg:<id>"`
3. `messageId` → `"msg:<id>"`
4. `role + timestamp` → `"msg:<role>:<ts>:<index>"`
5. fallback → `"msg:<role>:<index>"`

---

## renderGroupedMessage — Chi Tiết Render

```
message
  ├── extractImages() → display inline images (với click to open)
  ├── extractTextCached() → text content (cached với WeakMap)
  ├── extractThinkingCached() → <think> content (nếu showReasoning)
  ├── extractToolCards() → tool call cards
  │
  └── Render:
        ├── renderCopyAsMarkdownButton() (nếu role=assistant && có text)
        ├── renderMessageImages()
        ├── chat-thinking div (nếu có thinking, rendered as markdown italic)
        ├── chat-text div (text rendered as sanitized markdown)
        └── toolCards.map(renderToolCardSidebar)
```

### Avatar Logic

```
role = "user"      → "U" initial (blue/indigo)
role = "assistant" →
  avatarUrl (http/https/data:image//) → <img src=avatarUrl>
  avatar (emoji/text)                 → <div>emoji</div>
  fallback                            → First letter of name
role = "tool"      → "⚙" icon (gear)
```

---

## Image Attachments

### Paste Ảnh

User paste ảnh vào textarea → `handlePaste(e, props)`:

1. Check `ClipboardData.items` có `type.startsWith("image/")`
2. `FileReader.readAsDataURL()` → convert to `data:image/...;base64,...`
3. Thêm vào `chatAttachments[]`

```ts
type ChatAttachment = {
  id: string; // "att-<timestamp>-<random>"
  dataUrl: string; // "data:image/png;base64,..."
  mimeType: string;
};
```

### Gửi Attachments

`sendChatMessage(state, message, attachments?)`:

- Content blocks: `[{ type: "text", text }, { type: "image", source: { type: "base64", ... } }]`
- API format: `dataUrlToBase64(dataUrl)` → strip prefix → `{ mimeType, content: base64 }`
- Gửi kèm `chat.send` request: `{ ..., attachments: [{ type: "image", mimeType, content }] }`

### Hiển Thị Attachments

- Preview trước khi gửi: grid thumbnail với nút xóa
- Sau khi gửi: `extractImages()` render inline trong chat bubble
- Click → `window.open(url, "_blank")`

---

## Text Extraction & Thinking

### `extractText(message)` — lấy text để hiển thị

```
content: string                    → stripThinkingTags + stripEnvelope
content: [{ type: "text", text }]  → join, process tương tự
text: string (fallback)            → process tương tự

Với role="user": stripInboundMetadata (xóa metadata AI inject)
Với role="assistant": stripThinkingTags (xóa <think>...</think>)
```

### `extractThinking(message)` — lấy reasoning/thinking content

```
Ưu tiên: content[].type === "thinking" && .thinking (structured format)
Fallback: regex match <think>...</think> tags trong text
```

### `formatReasoningMarkdown(text)` — render thinking

```
"line 1\nline 2" → "_Reasoning:_\n_line 1_\n_line 2_"
```

(Hiển thị như italics trong markdown)

---

## Special Commands

| Command                                             | Hành động                                                 |
| --------------------------------------------------- | --------------------------------------------------------- |
| `/stop` hoặc `stop`, `esc`, `abort`, `wait`, `exit` | Dừng run hiện tại (`chat.abort`)                          |
| `/new` hoặc `/reset`                                | Báo gateway tạo session mới, sau đó refresh sessions list |
| `/new <text>`                                       | Tương tự nhưng vẫn gửi text sau                           |

---

## Avatar của Assistant

```
refreshChatAvatar(host):
  1. parseAgentSessionKey(sessionKey) → agentId
  2. Fetch GET /avatar/{agentId}?meta=1
  3. Response: { avatarUrl: string } → set host.chatAvatarUrl
```

Avatar endpoint trả về URL của agent avatar (ảnh).  
Format URL: `/{basePath}/avatar/{encoded_agentId}?meta=1`

---

## Focus Mode

Khi `chatFocusMode=true` hoặc `onboarding=true`:

- CSS class `shell--chat-focus` trên `.shell`
- Chat chiếm toàn bộ màn hình (nav và topbar bị ẩn)
- Nút "X" ở góc để thoát focus mode

---

## Resizable Sidebar (Tool Output)

Chat có split layout khi sidebar mở:

```
┌───────────────────────────────────────────┐
│ Chat thread  │ ╎ │  Tool output sidebar   │
│              │ ╎ │  (markdown rendered)   │
└──────────────┴───┴────────────────────────┘
                ↑ resizable-divider component
```

`<resizable-divider>` là custom Web Component xử lý dragging và emit `resize` event với `detail.splitRatio`.

`splitRatio`: 0.4 → 0.7, lưu trong `UiSettings.splitRatio`.

---

## So Sánh Chat UI vs `ui-next/`

| Tính năng             | `ui/`                         | `ui-next/`  |
| --------------------- | ----------------------------- | ----------- |
| Real-time streaming   | ✅ `chatStream` state         | ✅          |
| Tool display          | ✅ Live tool stream + sidebar | ❌          |
| Image attachments     | ✅ Paste + preview            | ❌          |
| Message queue         | ✅ Queued while busy          | ❌          |
| Focus mode            | ✅ Fullscreen                 | ❌          |
| Compaction indicator  | ✅ Toast badge                | ❌          |
| Model fallback notify | ✅ Toast badge                | ❌          |
| Thinking display      | ✅ Toggle                     | ⚠️ State có |
| Copy as markdown      | ✅ Button                     | ❌          |
| Abort                 | ✅ `/stop` + button           | ✅          |
| New session command   | ✅ `/new`                     | ⚠️          |
| Avatar fetch          | ✅ HTTP GET                   | ✅ Static   |
| Markdown render       | ✅ DOMPurify                  | ❌ Plain    |
| Max history render    | 200 msgs                      | No limit    |
| RTL support           | ✅ Auto detect                | ❌          |
