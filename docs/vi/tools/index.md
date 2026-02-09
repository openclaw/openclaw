---
summary: "Bề mặt công cụ của tác tử cho OpenClaw (trình duyệt, canvas, nodes, nhắn tin, cron) thay thế các skills `openclaw-*` cũ"
read_when:
  - Thêm hoặc chỉnh sửa công cụ của tác tử
  - Ngừng sử dụng hoặc thay đổi các skills `openclaw-*`
title: "Tools"
---

# Tools (OpenClaw)

OpenClaw exposes **first-class agent tools** for browser, canvas, nodes, and cron.
These replace the old `openclaw-*` skills: the tools are typed, no shelling,
and the agent should rely on them directly.

## Tắt công cụ

You can globally allow/deny tools via `tools.allow` / `tools.deny` in `openclaw.json`
(deny wins). This prevents disallowed tools from being sent to model providers.

```json5
{
  tools: { deny: ["browser"] },
}
```

Ghi chú:

- So khớp không phân biệt chữ hoa/chữ thường.
- Hỗ trợ ký tự đại diện `*` (`"*"` nghĩa là tất cả công cụ).
- Nếu `tools.allow` chỉ tham chiếu các tên công cụ plugin không tồn tại hoặc chưa được tải, OpenClaw ghi cảnh báo và bỏ qua allowlist để các công cụ lõi vẫn khả dụng.

## Hồ sơ công cụ (allowlist cơ sở)

`tools.profile` sets a **base tool allowlist** before `tools.allow`/`tools.deny`.
Per-agent override: `agents.list[].tools.profile`.

Các hồ sơ:

- `minimal`: chỉ `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: không hạn chế (giống như không đặt)

Ví dụ (mặc định chỉ nhắn tin, cho phép thêm công cụ Slack + Discord):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Ví dụ (hồ sơ coding, nhưng từ chối exec/process ở mọi nơi):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

Ví dụ (hồ sơ coding toàn cục, tác tử hỗ trợ chỉ nhắn tin):

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## Chính sách công cụ theo nhà cung cấp

Use `tools.byProvider` to **further restrict** tools for specific providers
(or a single `provider/model`) without changing your global defaults.
Per-agent override: `agents.list[].tools.byProvider`.

This is applied **after** the base tool profile and **before** allow/deny lists,
so it can only narrow the tool set.
Provider keys accept either `provider` (e.g. `google-antigravity`) or
`provider/model` (e.g. `openai/gpt-5.2`).

Ví dụ (giữ hồ sơ coding toàn cục, nhưng công cụ tối thiểu cho Google Antigravity):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

Ví dụ (allowlist theo nhà cung cấp/mô hình cho một endpoint không ổn định):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

Ví dụ (ghi đè theo tác tử cho một nhà cung cấp duy nhất):

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## Nhóm công cụ (viết tắt)

Chính sách tool (toàn cục, theo tác tử, sandbox) hỗ trợ các mục `group:*` mở rộng thành nhiều tool.
Use these in `tools.allow` / `tools.deny`.

Các nhóm có sẵn:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: tất cả công cụ OpenClaw tích hợp sẵn (không bao gồm plugin của nhà cung cấp)

Ví dụ (chỉ cho phép công cụ file + trình duyệt):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Plugin + công cụ

Plugins can register **additional tools** (and CLI commands) beyond the core set.
See [Plugins](/tools/plugin) for install + config, and [Skills](/tools/skills) for how
tool usage guidance is injected into prompts. Some plugins ship their own skills
alongside tools (for example, the voice-call plugin).

Công cụ plugin tùy chọn:

- [Lobster](/tools/lobster): runtime workflow có kiểu với phê duyệt có thể tiếp tục (yêu cầu Lobster CLI trên máy chủ gateway).
- [LLM Task](/tools/llm-task): bước LLM chỉ JSON cho đầu ra workflow có cấu trúc (xác thực schema tùy chọn).

## Danh mục công cụ

### `apply_patch`

Apply structured patches across one or more files. Use for multi-hunk edits.
Experimental: enable via `tools.exec.applyPatch.enabled` (OpenAI models only).

### `exec`

Chạy lệnh shell trong workspace.

Tham số cốt lõi:

- `command` (bắt buộc)
- `yieldMs` (tự chuyển nền sau thời gian chờ, mặc định 10000)
- `background` (chạy nền ngay)
- `timeout` (giây; kết thúc tiến trình nếu vượt quá, mặc định 1800)
- `elevated` (bool; chạy trên host nếu chế độ nâng quyền được bật/cho phép; chỉ thay đổi hành vi khi tác tử bị sandbox)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (id/tên node cho `host=node`)
- Need a real TTY? Set `pty: true`.

Ghi chú:

- Trả về `status: "running"` kèm `sessionId` khi chạy nền.
- Dùng `process` để thăm dò/ghi log/ghi/giết/xóa phiên nền.
- Nếu `process` bị từ chối, `exec` chạy đồng bộ và bỏ qua `yieldMs`/`background`.
- `elevated` bị chặn bởi `tools.elevated` cộng với bất kỳ ghi đè `agents.list[].tools.elevated` nào (cả hai phải cho phép) và là bí danh cho `host=gateway` + `security=full`.
- `elevated` chỉ thay đổi hành vi khi tác tử bị sandbox (ngược lại là không tác dụng).
- `host=node` có thể nhắm tới ứng dụng đồng hành macOS hoặc một node host headless (`openclaw node run`).
- phê duyệt và allowlist gateway/node: [Exec approvals](/tools/exec-approvals).

### `process`

Quản lý các phiên exec chạy nền.

Hành động cốt lõi:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

Ghi chú:

- `poll` trả về đầu ra mới và trạng thái thoát khi hoàn tất.
- `log` hỗ trợ `offset`/`limit` theo dòng (bỏ `offset` để lấy N dòng cuối).
- `process` có phạm vi theo từng tác tử; không thấy các phiên của tác tử khác.

### `web_search`

Tìm kiếm web bằng Brave Search API.

Tham số cốt lõi:

- `query` (bắt buộc)
- `count` (1–10; mặc định từ `tools.web.search.maxResults`)

Ghi chú:

- Yêu cầu khóa API Brave (khuyến nghị: `openclaw configure --section web`, hoặc đặt `BRAVE_API_KEY`).
- Bật qua `tools.web.search.enabled`.
- Phản hồi được cache (mặc định 15 phút).
- Xem [Web tools](/tools/web) để thiết lập.

### `web_fetch`

Lấy và trích xuất nội dung dễ đọc từ URL (HTML → markdown/text).

Tham số cốt lõi:

- `url` (bắt buộc)
- `extractMode` (`markdown` | `text`)
- `maxChars` (cắt ngắn trang dài)

Ghi chú:

- Bật qua `tools.web.fetch.enabled`.
- `maxChars` bị kẹp bởi `tools.web.fetch.maxCharsCap` (mặc định 50000).
- Phản hồi được cache (mặc định 15 phút).
- Với site nặng JS, ưu tiên dùng công cụ trình duyệt.
- Xem [Web tools](/tools/web) để thiết lập.
- Xem [Firecrawl](/tools/firecrawl) cho phương án chống bot tùy chọn.

### `browser`

Điều khiển trình duyệt do OpenClaw quản lý chuyên dụng.

Hành động cốt lõi:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (trả về khối ảnh + `MEDIA:<path>`)
- `act` (hành động UI: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Quản lý hồ sơ:

- `profiles` — liệt kê tất cả hồ sơ trình duyệt kèm trạng thái
- `create-profile` — tạo hồ sơ mới với cổng được cấp tự động (hoặc `cdpUrl`)
- `delete-profile` — dừng trình duyệt, xóa dữ liệu người dùng, gỡ khỏi cấu hình (chỉ local)
- `reset-profile` — kill tiến trình mồ côi trên cổng của hồ sơ (chỉ local)

Tham số chung:

- `profile` (tùy chọn; mặc định là `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (tùy chọn; chọn id/tên node cụ thể)
  Ghi chú:
- Yêu cầu `browser.enabled=true` (mặc định là `true`; đặt `false` để tắt).
- Tất cả hành động chấp nhận tham số `profile` tùy chọn cho hỗ trợ đa instance.
- Khi bỏ `profile`, dùng `browser.defaultProfile` (mặc định "chrome").
- Tên hồ sơ: chữ thường chữ số + dấu gạch ngang (tối đa 64 ký tự).
- Dải cổng: 18800-18899 (~tối đa 100 hồ sơ).
- Hồ sơ từ xa chỉ cho phép attach (không start/stop/reset).
- Nếu có node hỗ trợ trình duyệt được kết nối, công cụ có thể tự định tuyến tới đó (trừ khi bạn ghim `target`).
- `snapshot` mặc định là `ai` khi đã cài Playwright; dùng `aria` cho cây accessibility.
- `snapshot` cũng hỗ trợ các tùy chọn role-snapshot (`interactive`, `compact`, `depth`, `selector`) trả về các ref như `e12`.
- `act` yêu cầu `ref` từ `snapshot` (giá trị số `12` từ AI snapshots, hoặc `e12` từ role snapshots); dùng `evaluate` cho các trường hợp hiếm cần CSS selector.
- Tránh `act` → `wait` theo mặc định; chỉ dùng trong trường hợp đặc biệt (không có trạng thái UI đáng tin cậy để chờ).
- `upload` có thể truyền `ref` để tự click sau khi kích hoạt.
- `upload` cũng hỗ trợ `inputRef` (aria ref) hoặc `element` (CSS selector) để đặt `<input type="file">` trực tiếp.

### `canvas`

Điều khiển Canvas của node (present, eval, snapshot, A2UI).

Hành động cốt lõi:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (trả về khối ảnh + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

Ghi chú:

- Sử dụng `node.invoke` của gateway ở phía dưới.
- Nếu không cung cấp `node`, công cụ chọn mặc định (node đơn đang kết nối hoặc mac node local).
- A2UI chỉ v0.8 (không `createSurface`); CLI từ chối JSONL v0.9 với lỗi theo dòng.
- Kiểm tra nhanh: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

Khám phá và nhắm mục tiêu các node đã ghép cặp; gửi thông báo; ghi camera/màn hình.

Hành động cốt lõi:

- `status`, `describe`
- `pending`, `approve`, `reject` (ghép cặp)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

Ghi chú:

- Lệnh camera/màn hình yêu cầu ứng dụng node ở tiền cảnh.
- Ảnh trả về khối ảnh + `MEDIA:<path>`.
- Video trả về `FILE:<path>` (mp4).
- Vị trí trả về payload JSON (lat/lon/accuracy/timestamp).
- Tham số `run`: mảng argv `command`; tùy chọn `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

Ví dụ (`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

Phân tích một hình ảnh bằng mô hình ảnh đã cấu hình.

Tham số cốt lõi:

- `image` (đường dẫn hoặc URL bắt buộc)
- `prompt` (tùy chọn; mặc định "Describe the image.")
- `model` (ghi đè tùy chọn)
- `maxBytesMb` (giới hạn kích thước tùy chọn)

Ghi chú:

- Chỉ khả dụng khi `agents.defaults.imageModel` được cấu hình (chính hoặc dự phòng), hoặc khi có thể suy ra ngầm mô hình ảnh từ mô hình mặc định + xác thực đã cấu hình (ghép cặp best-effort).
- Dùng trực tiếp mô hình ảnh (độc lập với mô hình chat chính).

### `message`

Gửi tin nhắn và hành động kênh trên Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams.

Hành động cốt lõi:

- `send` (văn bản + media tùy chọn; MS Teams cũng hỗ trợ `card` cho Adaptive Cards)
- `poll` (polls WhatsApp/Discord/MS Teams)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

Ghi chú:

- `send` định tuyến WhatsApp qua Gateway; các kênh khác đi trực tiếp.
- `poll` dùng Gateway cho WhatsApp và MS Teams; polls Discord đi trực tiếp.
- Khi một lời gọi công cụ nhắn tin được ràng buộc với phiên chat đang hoạt động, việc gửi bị giới hạn vào mục tiêu của phiên đó để tránh rò rỉ ngữ cảnh chéo.

### `cron`

Quản lý cron jobs và wakeups của Gateway.

Hành động cốt lõi:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (xếp hàng sự kiện hệ thống + heartbeat ngay lập tức tùy chọn)

Ghi chú:

- `add` yêu cầu một đối tượng cron job đầy đủ (cùng schema với RPC `cron.add`).
- `update` dùng `{ jobId, patch }` (chấp nhận `id` để tương thích).

### `gateway`

Khởi động lại hoặc áp dụng cập nhật cho tiến trình Gateway đang chạy (tại chỗ).

Hành động cốt lõi:

- `restart` (ủy quyền + gửi `SIGUSR1` để khởi động lại trong tiến trình; `openclaw gateway` khởi động lại tại chỗ)
- `config.get` / `config.schema`
- `config.apply` (xác thực + ghi cấu hình + khởi động lại + wake)
- `config.patch` (gộp cập nhật một phần + khởi động lại + wake)
- `update.run` (chạy cập nhật + khởi động lại + wake)

Ghi chú:

- Dùng `delayMs` (mặc định 2000) để tránh gián đoạn một phản hồi đang diễn ra.
- `restart` bị tắt theo mặc định; bật bằng `commands.restart: true`.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

Liệt kê phiên, kiểm tra lịch sử transcript, hoặc gửi sang phiên khác.

Tham số cốt lõi:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = không)
- `sessions_history`: `sessionKey` (hoặc `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (hoặc `sessionId`), `message`, `timeoutSeconds?` (0 = fire-and-forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (mặc định hiện tại; chấp nhận `sessionId`), `model?` (`default` xóa ghi đè)

Ghi chú:

- `main` là khóa direct-chat chuẩn; global/unknown bị ẩn.
- `messageLimit > 0` lấy N tin nhắn cuối mỗi phiên (lọc tin nhắn công cụ).
- `sessions_send` chờ hoàn tất cuối cùng khi `timeoutSeconds > 0`.
- Việc giao/announce diễn ra sau khi hoàn tất và theo best-effort; `status: "ok"` xác nhận lần chạy tác tử đã kết thúc, không đảm bảo announce đã được gửi.
- `sessions_spawn` khởi chạy một tác tử con và đăng một phản hồi announce về chat yêu cầu.
- `sessions_spawn` không chặn và trả về `status: "accepted"` ngay lập tức.
- `sessions_send` chạy ping‑pong phản hồi‑lại (trả lời `REPLY_SKIP` để dừng; số lượt tối đa qua `session.agentToAgent.maxPingPongTurns`, 0–5).
- Sau ping‑pong, tác tử mục tiêu chạy **bước announce**; trả lời `ANNOUNCE_SKIP` để chặn announce.

### `agents_list`

Liệt kê id tác tử mà phiên hiện tại có thể nhắm tới bằng `sessions_spawn`.

Ghi chú:

- Kết quả bị giới hạn theo allowlist từng tác tử (`agents.list[].subagents.allowAgents`).
- Khi cấu hình `["*"]`, công cụ bao gồm tất cả tác tử đã cấu hình và đánh dấu `allowAny: true`.

## Tham số (chung)

Các công cụ dựa trên Gateway (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (mặc định `ws://127.0.0.1:18789`)
- `gatewayToken` (nếu bật xác thực)
- `timeoutMs`

Note: when `gatewayUrl` is set, include `gatewayToken` explicitly. Tools do not inherit config
or environment credentials for overrides, and missing explicit credentials is an error.

Công cụ trình duyệt:

- `profile` (tùy chọn; mặc định là `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (tùy chọn; ghim id/tên node cụ thể)

## Luồng tác tử được khuyến nghị

Tự động hóa trình duyệt:

1. `browser` → `status` / `start`
2. `snapshot` (ai hoặc aria)
3. `act` (click/type/press)
4. `screenshot` nếu cần xác nhận trực quan

Kết xuất canvas:

1. `canvas` → `present`
2. `a2ui_push` (tùy chọn)
3. `snapshot`

Nhắm mục tiêu node:

1. `nodes` → `status`
2. `describe` trên node đã chọn
3. `notify` / `run` / `camera_snap` / `screen_record`

## An toàn

- Tránh `system.run` trực tiếp; chỉ dùng `nodes` → `run` khi có sự đồng ý rõ ràng của người dùng.
- Tôn trọng sự đồng ý của người dùng đối với việc ghi camera/màn hình.
- Dùng `status/describe` để đảm bảo quyền trước khi gọi các lệnh media.

## Cách công cụ được trình bày cho tác tử

Công cụ được hiển thị qua hai kênh song song:

1. **Văn bản system prompt**: danh sách dễ đọc + hướng dẫn.
2. **Schema công cụ**: các định nghĩa hàm có cấu trúc được gửi tới API mô hình.

That means the agent sees both “what tools exist” and “how to call them.” If a tool
doesn’t appear in the system prompt or the schema, the model cannot call it.
