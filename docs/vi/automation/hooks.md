---
summary: "Hooks: tự động hóa theo sự kiện cho các lệnh và sự kiện vòng đời"
read_when:
  - Bạn muốn tự động hóa theo sự kiện cho /new, /reset, /stop và các sự kiện vòng đời của tác tử
  - Bạn muốn xây dựng, cài đặt hoặc gỡ lỗi hooks
title: "Hooks"
---

# Hooks

Hooks cung cấp một hệ thống hướng sự kiện có thể mở rộng để tự động hóa các hành động nhằm phản hồi các lệnh và sự kiện của agent. Hooks được tự động phát hiện từ các thư mục và có thể được quản lý thông qua các lệnh CLI, tương tự như cách skills hoạt động trong OpenClaw.

## Làm quen

Hooks là các script nhỏ chạy khi có điều gì đó xảy ra. Có hai loại:

- **Hooks** (trang này): chạy bên trong Gateway khi các sự kiện của tác tử được kích hoạt, như `/new`, `/reset`, `/stop`, hoặc các sự kiện vòng đời.
- **Webhooks**: các webhook HTTP bên ngoài cho phép các hệ thống khác kích hoạt công việc trong OpenClaw. Xem [Webhook Hooks](/automation/webhook) hoặc sử dụng `openclaw webhooks` cho các lệnh trợ giúp Gmail.

Hooks cũng có thể được đóng gói bên trong plugin; xem [Plugins](/tools/plugin#plugin-hooks).

Các trường hợp sử dụng phổ biến:

- Lưu snapshot bộ nhớ khi bạn reset một phiên
- Giữ nhật ký kiểm toán các lệnh để xử lý sự cố hoặc tuân thủ
- Kích hoạt tự động hóa tiếp theo khi một phiên bắt đầu hoặc kết thúc
- Ghi file vào workspace của tác tử hoặc gọi API bên ngoài khi sự kiện xảy ra

Nếu bạn có thể viết một hàm TypeScript nhỏ, bạn có thể viết một hook. Hooks được phát hiện tự động, và bạn bật hoặc tắt chúng thông qua CLI.

## Tổng quan

Hệ thống hooks cho phép bạn:

- Lưu ngữ cảnh phiên vào bộ nhớ khi `/new` được phát hành
- Ghi log tất cả lệnh cho mục đích kiểm toán
- Kích hoạt tự động hóa tùy chỉnh dựa trên các sự kiện vòng đời của tác tử
- Mở rộng hành vi của OpenClaw mà không cần sửa đổi mã lõi

## Bắt đầu

### Hooks đi kèm

OpenClaw đi kèm bốn hook có sẵn và được tự động phát hiện:

- **💾 session-memory**: Lưu ngữ cảnh phiên vào workspace của tác tử (mặc định `~/.openclaw/workspace/memory/`) khi bạn phát hành `/new`
- **📝 command-logger**: Ghi log tất cả sự kiện lệnh vào `~/.openclaw/logs/commands.log`
- **🚀 boot-md**: Chạy `BOOT.md` khi gateway khởi động (yêu cầu bật internal hooks)
- **😈 soul-evil**: Hoán đổi nội dung `SOUL.md` được inject bằng `SOUL_EVIL.md` trong một cửa sổ purge hoặc ngẫu nhiên

Liệt kê các hook khả dụng:

```bash
openclaw hooks list
```

Bật một hook:

```bash
openclaw hooks enable session-memory
```

Kiểm tra trạng thái hook:

```bash
openclaw hooks check
```

Xem thông tin chi tiết:

```bash
openclaw hooks info session-memory
```

### Hướng dẫn ban đầu

Trong quá trình onboarding (`openclaw onboard`), bạn sẽ được nhắc bật các hook được đề xuất. Trình hướng dẫn tự động phát hiện các hook đủ điều kiện và trình bày chúng để lựa chọn.

## Phát hiện Hook

Hooks được tự động phát hiện từ ba thư mục (theo thứ tự ưu tiên):

1. **Workspace hooks**: `<workspace>/hooks/` (theo từng tác tử, ưu tiên cao nhất)
2. **Managed hooks**: `~/.openclaw/hooks/` (do người dùng cài đặt, dùng chung giữa các workspace)
3. **Bundled hooks**: `<openclaw>/dist/hooks/bundled/` (được phân phối cùng OpenClaw)

Thư mục managed hook có thể là **một hook đơn lẻ** hoặc một **hook pack** (thư mục gói).

Mỗi hook là một thư mục chứa:

```
my-hook/
├── HOOK.md          # Metadata + documentation
└── handler.ts       # Handler implementation
```

## Hook Packs (npm/archives)

4. Hook pack là các gói npm tiêu chuẩn, xuất một hoặc nhiều hook thông qua `openclaw.hooks` trong `package.json`. 5. Cài đặt chúng bằng:

```bash
openclaw hooks install <path-or-spec>
```

Ví dụ `package.json`:

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

Mỗi mục trỏ tới một thư mục hook chứa `HOOK.md` và `handler.ts` (hoặc `index.ts`).
6. Hook pack có thể kèm theo dependency; chúng sẽ được cài dưới `~/.openclaw/hooks/<id>`.

## Cấu trúc Hook

### Định dạng HOOK.md

File `HOOK.md` chứa metadata ở dạng YAML frontmatter cùng với tài liệu Markdown:

```markdown
---
name: my-hook
description: "Short description of what this hook does"
homepage: https://docs.openclaw.ai/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

Detailed documentation goes here...

## What It Does

- Listens for `/new` commands
- Performs some action
- Logs the result

## Requirements

- Node.js must be installed

## Configuration

No configuration needed.
```

### Trường Metadata

Đối tượng `metadata.openclaw` hỗ trợ:

- **`emoji`**: Emoji hiển thị cho CLI (ví dụ: `"💾"`)
- **`events`**: Mảng các sự kiện cần lắng nghe (ví dụ: `["command:new", "command:reset"]`)
- **`export`**: Named export sẽ sử dụng (mặc định là `"default"`)
- **`homepage`**: URL tài liệu
- **`requires`**: Các yêu cầu tùy chọn
  - **`bins`**: Các binary bắt buộc trong PATH (ví dụ: `["git", "node"]`)
  - **`anyBins`**: Ít nhất một trong các binary này phải tồn tại
  - **`env`**: Các biến môi trường bắt buộc
  - **`config`**: Các đường dẫn cấu hình bắt buộc (ví dụ: `["workspace.dir"]`)
  - **`os`**: Các nền tảng được yêu cầu (ví dụ: `["darwin", "linux"]`)
- **`always`**: Bỏ qua kiểm tra đủ điều kiện (boolean)
- **`install`**: Phương thức cài đặt (đối với hook đi kèm: `[{"id":"bundled","kind":"bundled"}]`)

### Triển khai Handler

File `handler.ts` xuất một hàm `HookHandler`:

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  // Only trigger on 'new' command
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  console.log(`  Session: ${event.sessionKey}`);
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);

  // Your custom logic here

  // Optionally send message to user
  event.messages.push("✨ My hook executed!");
};

export default myHandler;
```

#### Ngữ cảnh sự kiện

Mỗi sự kiện bao gồm:

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway',
  action: string,              // e.g., 'new', 'reset', 'stop'
  sessionKey: string,          // Session identifier
  timestamp: Date,             // When the event occurred
  messages: string[],          // Push messages here to send to user
  context: {
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // e.g., 'whatsapp', 'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: OpenClawConfig
  }
}
```

## Các loại Sự kiện

### Sự kiện Lệnh

Được kích hoạt khi các lệnh của tác tử được phát hành:

- **`command`**: Tất cả các sự kiện lệnh (listener tổng quát)
- **`command:new`**: Khi lệnh `/new` được phát hành
- **`command:reset`**: Khi lệnh `/reset` được phát hành
- **`command:stop`**: Khi lệnh `/stop` được phát hành

### Sự kiện Tác tử

- **`agent:bootstrap`**: Trước khi các file bootstrap workspace được inject (hooks có thể thay đổi `context.bootstrapFiles`)

### Sự kiện Gateway

Được kích hoạt khi gateway khởi động:

- **`gateway:startup`**: Sau khi các kênh khởi động và hooks được tải

### Tool Result Hooks (Plugin API)

Các hook này không phải listener của event-stream; chúng cho phép plugin đồng bộ điều chỉnh kết quả tool trước khi OpenClaw lưu chúng.

- **`tool_result_persist`**: chuyển đổi kết quả của tool trước khi chúng được ghi vào bản ghi phiên làm việc. 7. Phải là đồng bộ; trả về payload kết quả tool đã được cập nhật hoặc `undefined` để giữ nguyên. Xem [Agent Loop](/concepts/agent-loop).

### Sự kiện Tương lai

Các loại sự kiện dự kiến:

- **`session:start`**: Khi một phiên mới bắt đầu
- **`session:end`**: Khi một phiên kết thúc
- **`agent:error`**: Khi một tác tử gặp lỗi
- **`message:sent`**: Khi một tin nhắn được gửi
- **`message:received`**: Khi một tin nhắn được nhận

## Tạo Hook Tùy chỉnh

### 8. 1. Chọn vị trí

- **Workspace hooks** (`<workspace>/hooks/`): Theo từng tác tử, ưu tiên cao nhất
- **Managed hooks** (`~/.openclaw/hooks/`): Dùng chung giữa các workspace

### 2. Tạo cấu trúc thư mục

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. Tạo HOOK.md

```markdown
---
name: my-hook
description: "Does something useful"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Custom Hook

This hook does something useful when you issue `/new`.
```

### 9. 4. Tạo handler.ts

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] Running!");
  // Your logic here
};

export default handler;
```

### 5. Bật và kiểm thử

```bash
# Verify hook is discovered
openclaw hooks list

# Enable it
openclaw hooks enable my-hook

# Restart your gateway process (menu bar app restart on macOS, or restart your dev process)

# Trigger the event
# Send /new via your messaging channel
```

## Cấu hình

### Định dạng Config Mới (Khuyến nghị)

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": { "enabled": true },
        "command-logger": { "enabled": false }
      }
    }
  }
}
```

### Cấu hình Theo Hook

Hooks có thể có cấu hình tùy chỉnh:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "my-hook": {
          "enabled": true,
          "env": {
            "MY_CUSTOM_VAR": "value"
          }
        }
      }
    }
  }
}
```

### Thư mục Bổ sung

Tải hooks từ các thư mục bổ sung:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "load": {
        "extraDirs": ["/path/to/more/hooks"]
      }
    }
  }
}
```

### Định dạng Config Cũ (Vẫn được hỗ trợ)

Định dạng config cũ vẫn hoạt động để tương thích ngược:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts",
          "export": "default"
        }
      ]
    }
  }
}
```

10. **Migration**: Sử dụng hệ thống discovery-based mới cho các hook mới. Các legacy handler được tải sau các hook dựa trên thư mục.

## Lệnh CLI

### Liệt kê Hooks

```bash
# List all hooks
openclaw hooks list

# Show only eligible hooks
openclaw hooks list --eligible

# Verbose output (show missing requirements)
openclaw hooks list --verbose

# JSON output
openclaw hooks list --json
```

### Thông tin Hook

```bash
# Show detailed info about a hook
openclaw hooks info session-memory

# JSON output
openclaw hooks info session-memory --json
```

### Kiểm tra Điều kiện

```bash
# Show eligibility summary
openclaw hooks check

# JSON output
openclaw hooks check --json
```

### Bật/Tắt

```bash
# Enable a hook
openclaw hooks enable session-memory

# Disable a hook
openclaw hooks disable command-logger
```

## Tham khảo hook đi kèm

### session-memory

Lưu ngữ cảnh phiên vào bộ nhớ khi bạn phát hành `/new`.

**Sự kiện**: `command:new`

**Yêu cầu**: `workspace.dir` phải được cấu hình

**Đầu ra**: `<workspace>/memory/YYYY-MM-DD-slug.md` (mặc định `~/.openclaw/workspace`)

**Cách hoạt động**:

1. Sử dụng entry phiên trước khi reset để xác định transcript chính xác
2. Trích xuất 15 dòng hội thoại cuối cùng
3. Dùng LLM để tạo slug tên file mang tính mô tả
4. Lưu metadata phiên vào file bộ nhớ theo ngày

**Ví dụ đầu ra**:

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

**Ví dụ tên file**:

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md` (timestamp dự phòng nếu tạo slug thất bại)

**Bật**:

```bash
openclaw hooks enable session-memory
```

### command-logger

Ghi log tất cả sự kiện lệnh vào một file kiểm toán tập trung.

**Sự kiện**: `command`

**Yêu cầu**: Không

**Đầu ra**: `~/.openclaw/logs/commands.log`

**Cách hoạt động**:

1. Thu thập chi tiết sự kiện (hành động lệnh, timestamp, khóa phiên, ID người gửi, nguồn)
2. Ghi thêm vào file log theo định dạng JSONL
3. Chạy âm thầm trong nền

**Ví dụ bản ghi log**:

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**Xem log**:

```bash
# View recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print with jq
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Bật**:

```bash
openclaw hooks enable command-logger
```

### soul-evil

Hoán đổi nội dung `SOUL.md` được inject bằng `SOUL_EVIL.md` trong một cửa sổ purge hoặc theo xác suất ngẫu nhiên.

**Sự kiện**: `agent:bootstrap`

**Tài liệu**: [SOUL Evil Hook](/hooks/soul-evil)

**Đầu ra**: Không ghi file; việc hoán đổi chỉ diễn ra trong bộ nhớ.

**Bật**:

```bash
openclaw hooks enable soul-evil
```

**Cấu hình**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

### boot-md

Chạy `BOOT.md` khi gateway khởi động (sau khi các kênh khởi động).
Các hook nội bộ phải được bật để điều này chạy.

**Sự kiện**: `gateway:startup`

**Yêu cầu**: `workspace.dir` phải được cấu hình

**Cách hoạt động**:

1. Đọc `BOOT.md` từ workspace của bạn
2. Chạy các hướng dẫn thông qua agent runner
3. Gửi mọi tin nhắn outbound được yêu cầu qua message tool

**Bật**:

```bash
openclaw hooks enable boot-md
```

## Thực hành Tốt nhất

### Giữ Handler Nhanh

Hooks chạy trong quá trình xử lý lệnh. Giữ chúng nhẹ nhàng:

```typescript
// ✓ Good - async work, returns immediately
const handler: HookHandler = async (event) => {
  void processInBackground(event); // Fire and forget
};

// ✗ Bad - blocks command processing
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### Xử lý Lỗi Một cách An toàn

Luôn bao bọc các thao tác rủi ro:

```typescript
const handler: HookHandler = async (event) => {
  try {
    await riskyOperation(event);
  } catch (err) {
    console.error("[my-handler] Failed:", err instanceof Error ? err.message : String(err));
    // Don't throw - let other handlers run
  }
};
```

### Lọc Sự kiện Sớm

Trả về sớm nếu sự kiện không liên quan:

```typescript
const handler: HookHandler = async (event) => {
  // Only handle 'new' commands
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // Your logic here
};
```

### Dùng Khóa Sự kiện Cụ thể

Chỉ định chính xác các sự kiện trong metadata khi có thể:

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # Specific
```

Thay vì:

```yaml
metadata: { "openclaw": { "events": ["command"] } } # General - more overhead
```

## Gỡ lỗi

### Bật Log Hook

Gateway ghi log việc tải hook khi khởi động:

```
Registered hook: session-memory -> command:new
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### Kiểm tra Discovery

Liệt kê tất cả hook được phát hiện:

```bash
openclaw hooks list --verbose
```

### Kiểm tra Đăng ký

Trong handler của bạn, ghi log khi nó được gọi:

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // Your logic
};
```

### Xác minh Điều kiện

Kiểm tra lý do hook không đủ điều kiện:

```bash
openclaw hooks info my-hook
```

Tìm các yêu cầu còn thiếu trong đầu ra.

## Kiểm thử

### Log Gateway

Theo dõi log gateway để xem việc thực thi hook:

```bash
# macOS
./scripts/clawlog.sh -f

# Other platforms
tail -f ~/.openclaw/gateway.log
```

### Kiểm thử Hook Trực tiếp

Kiểm thử handler của bạn một cách độc lập:

```typescript
import { test } from "vitest";
import { createHookEvent } from "./src/hooks/hooks.js";
import myHandler from "./hooks/my-hook/handler.js";

test("my handler works", async () => {
  const event = createHookEvent("command", "new", "test-session", {
    foo: "bar",
  });

  await myHandler(event);

  // Assert side effects
});
```

## Kiến trúc

### Thành phần Cốt lõi

- **`src/hooks/types.ts`**: Định nghĩa kiểu
- **`src/hooks/workspace.ts`**: Quét và tải thư mục
- **`src/hooks/frontmatter.ts`**: Phân tích metadata HOOK.md
- **`src/hooks/config.ts`**: Kiểm tra điều kiện
- **`src/hooks/hooks-status.ts`**: Báo cáo trạng thái
- **`src/hooks/loader.ts`**: Bộ tải module động
- **`src/cli/hooks-cli.ts`**: Lệnh CLI
- **`src/gateway/server-startup.ts`**: Tải hooks khi gateway khởi động
- **`src/auto-reply/reply/commands-core.ts`**: Kích hoạt sự kiện lệnh

### Luồng Discovery

```
Gateway startup
    ↓
Scan directories (workspace → managed → bundled)
    ↓
Parse HOOK.md files
    ↓
Check eligibility (bins, env, config, os)
    ↓
Load handlers from eligible hooks
    ↓
Register handlers for events
```

### Luồng Sự kiện

```
User sends /new
    ↓
Command validation
    ↓
Create hook event
    ↓
Trigger hook (all registered handlers)
    ↓
Command processing continues
    ↓
Session reset
```

## Xử lý Sự cố

### Hook Không Được Phát hiện

1. Kiểm tra cấu trúc thư mục:

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # Should show: HOOK.md, handler.ts
   ```

2. Xác minh định dạng HOOK.md:

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # Should have YAML frontmatter with name and metadata
   ```

3. Liệt kê tất cả hook được phát hiện:

   ```bash
   openclaw hooks list
   ```

### Hook Không Đủ Điều kiện

Kiểm tra các yêu cầu:

```bash
openclaw hooks info my-hook
```

Tìm các mục còn thiếu:

- Binary (kiểm tra PATH)
- Biến môi trường
- Giá trị cấu hình
- Khả năng tương thích OS

### Hook Không Thực thi

1. Xác minh hook đã được bật:

   ```bash
   openclaw hooks list
   # Should show ✓ next to enabled hooks
   ```

2. Khởi động lại tiến trình gateway để hook được tải lại.

3. Kiểm tra log gateway để tìm lỗi:

   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### Lỗi Handler

Kiểm tra lỗi TypeScript/import:

```bash
# Test import directly
node -e "import('./path/to/handler.ts').then(console.log)"
```

## Hướng dẫn Di chuyển

### Từ Config Cũ sang Discovery

**Trước**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts"
        }
      ]
    }
  }
}
```

**Sau**:

1. Tạo thư mục hook:

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. Tạo HOOK.md:

   ```markdown
   ---
   name: my-hook
   description: "My custom hook"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   Does something useful.
   ```

3. Cập nhật config:

   ```json
   {
     "hooks": {
       "internal": {
         "enabled": true,
         "entries": {
           "my-hook": { "enabled": true }
         }
       }
     }
   }
   ```

4. Xác minh và khởi động lại tiến trình gateway của bạn:

   ```bash
   openclaw hooks list
   # Should show: 🎯 my-hook ✓
   ```

**Lợi ích của việc di chuyển**:

- Tự động discovery
- Quản lý qua CLI
- Kiểm tra điều kiện
- Tài liệu tốt hơn
- Cấu trúc nhất quán

## Xem thêm

- [CLI Reference: hooks](/cli/hooks)
- [Bundled Hooks README](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/automation/webhook)
- [Configuration](/gateway/configuration#hooks)
