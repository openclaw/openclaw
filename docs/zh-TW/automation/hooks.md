---
summary: "Hooks: event-driven automation for commands and lifecycle events"
read_when:
  - >-
    You want event-driven automation for /new, /reset, /stop, and agent
    lifecycle events
  - "You want to build, install, or debug hooks"
title: Hooks
---

# Hooks

Hooks 提供了一個可擴充的事件驅動系統，用於自動執行對代理命令和事件的回應。Hooks 會自動從目錄中被發現，並且可以透過 CLI 命令進行管理，類似於 OpenClaw 中技能的運作方式。

## 瞭解方向

Hooks 是在某些事件發生時執行的小型腳本。主要有兩種：

- **Hooks** (此頁面)：在代理事件觸發時執行於 Gateway 內部，例如 `/new`、`/reset`、`/stop` 或生命週期事件。
- **Webhooks**：外部 HTTP webhook，讓其他系統能夠在 OpenClaw 中觸發工作。請參閱 [Webhook Hooks](/automation/webhook) 或使用 `openclaw webhooks` 來獲取 Gmail 幫助命令。

Hooks 也可以被打包在插件內；請參見 [Plugins](/tools/plugin#plugin-hooks)。

常見用途：

- 在重置會話時保存記憶快照
- 保留命令的審計追蹤以便於故障排除或合規性
- 在會話開始或結束時觸發後續自動化
- 當事件觸發時，將檔案寫入代理工作區或呼叫外部 API

如果你能寫一個小型的 TypeScript 函數，那麼你就能寫一個 hook。hooks 會自動被發現，你可以透過 CLI 來啟用或禁用它們。

## 概述

該掛鉤系統允許您：

- 當 `/new` 被發出時，將會話上下文儲存到記憶體中
- 記錄所有指令以便審計
- 在代理生命週期事件上觸發自訂自動化
- 在不修改核心程式碼的情況下擴充 OpenClaw 的行為

## 開始使用

### Bundled Hooks

OpenClaw 附帶四個自動識別的捲鉤：

- **💾 session-memory**: 將會話上下文儲存到您的代理工作區（預設 `~/.openclaw/workspace/memory/`）當您發出 `/new` 時
- **📎 bootstrap-extra-files**: 在 `agent:bootstrap` 期間從設定的 glob/path 模式注入額外的工作區啟動檔案
- **📝 command-logger**: 將所有命令事件記錄到 `~/.openclaw/logs/commands.log`
- **🚀 boot-md**: 當網關啟動時執行 `BOOT.md`（需要啟用內部鉤子）

列出可用的 hooks:

```bash
openclaw hooks list
```

啟用一個鉤子：

```bash
openclaw hooks enable session-memory
```

檢查掛鉤狀態：

```bash
openclaw hooks check
```

[[BLOCK_1]]

```bash
openclaw hooks info session-memory
```

### Onboarding

在入門過程中 (`openclaw onboard`), 系統會提示您啟用建議的 hooks。精靈會自動發現符合條件的 hooks 並提供選擇。

## Hook Discovery

Hooks 會從三個目錄自動發現（依優先順序）：

1. **工作區鉤子**: `<workspace>/hooks/` (每個代理，最高優先權)
2. **管理鉤子**: `~/.openclaw/hooks/` (用戶安裝，共享於各工作區)
3. **捆綁鉤子**: `<openclaw>/dist/hooks/bundled/` (隨 OpenClaw 一起發佈)

管理的掛鉤目錄可以是 **單一掛鉤** 或 **掛鉤包**（包目錄）。

每個 hook 是一個目錄，包含：

```
my-hook/
├── HOOK.md          # Metadata + documentation
└── handler.ts       # Handler implementation
```

## Hook Packs (npm/archives)

Hook packs 是標準的 npm 套件，透過 `openclaw.hooks` 在 `package.json` 中匯出一個或多個 hooks。安裝它們的方法是：

```bash
openclaw hooks install <path-or-spec>
```

Npm 規格僅限於註冊中心（套件名稱 + 可選的確切版本或發佈標籤）。Git/URL/檔案規格和語義版本範圍會被拒絕。

Bare specs 和 `@latest` 會保持在穩定的路徑上。如果 npm 將其中任何一個解析為預發行版本，OpenClaw 會停止並要求您明確選擇使用預發行標籤，例如 `@beta`/`@rc` 或一個確切的預發行版本。

Example `package.json`:

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

每個條目指向一個包含 `HOOK.md` 和 `handler.ts` (或 `index.ts`) 的掛鉤目錄。掛鉤包可以攜帶依賴項；它們將安裝在 `~/.openclaw/hooks/<id>` 下。每個 `openclaw.hooks` 條目在符號連結解析後必須保持在包目錄內；逃逸的條目將被拒絕。

安全提示：`openclaw hooks install` 使用 `npm install --ignore-scripts` 安裝依賴項（不包含生命週期腳本）。保持掛鉤包依賴樹為「純 JS/TS」，並避免依賴 `postinstall` 建置的套件。

## Hook 結構

### HOOK.md 格式

`HOOK.md` 檔案包含 YAML 前置資料的元資料以及 Markdown 文件：

## markdown

name: my-hook
description: "這個 hook 的簡短描述"
homepage: https://docs.openclaw.ai/automation/hooks#my-hook
metadata:
{ "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }

---

# My Hook

詳細文件在這裡...

## 它的功能

- 監聽 `/new` 指令
- 執行某些動作
- 記錄結果

## Requirements

- 必須安裝 Node.js

## Configuration

No configuration needed.

### Metadata Fields

`metadata.openclaw` 物件支援：

- **`emoji`**: 顯示 CLI 的 emoji（例如：`"💾"`）
- **`events`**: 要監聽的事件陣列（例如：`["command:new", "command:reset"]`）
- **`export`**: 要使用的命名匯出（預設為 `"default"`）
- **`homepage`**: 文件 URL
- **`requires`**: 可選需求
  - **`bins`**: PATH 上的必要二進位檔（例如：`["git", "node"]`）
  - **`anyBins`**: 必須至少存在這些二進位檔中的一個
  - **`env`**: 必要的環境變數
  - **`config`**: 必要的設定路徑（例如：`["workspace.dir"]`）
  - **`os`**: 必要的平台（例如：`["darwin", "linux"]`）
- **`always`**: 繞過資格檢查（布林值）
- **`install`**: 安裝方法（對於捆綁的鉤子：`[{"id":"bundled","kind":"bundled"}]`）

### Handler 實作

該 `handler.ts` 檔案匯出了一個 `HookHandler` 函數：

typescript
const myHandler = async (event) => {
// 只在 'new' 指令上觸發
if (event.type !== "command" || event.action !== "new") {
return;
}

console.log(`[my-hook] New command triggered`);
console.log(`  Session: ${event.sessionKey}`);
console.log(`  Timestamp: ${event.timestamp.toISOString()}`);

// Your custom logic here

// 可選地向用戶發送消息
event.messages.push("✨ 我的鉤子已執行！");  
};

#### 事件上下文

每個事件包括：

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway' | 'message',
  action: string,              // e.g., 'new', 'reset', 'stop', 'received', 'sent'
  sessionKey: string,          // Session identifier
  timestamp: Date,             // When the event occurred
  messages: string[],          // Push messages here to send to user
  context: {
    // Command events:
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // e.g., 'whatsapp', 'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: OpenClawConfig,
    // Message events (see Message Events section for full details):
    from?: string,             // message:received
    to?: string,               // message:sent
    content?: string,
    channelId?: string,
    success?: boolean,         // message:sent
  }
}
```

## 事件類型

### Command Events

當代理命令被發出時觸發：

- **`command`**: 所有命令事件（一般監聽器）
- **`command:new`**: 當發出 `/new` 命令時
- **`command:reset`**: 當發出 `/reset` 命令時
- **`command:stop`**: 當發出 `/stop` 命令時

### Session Events

- **`session:compact:before`**: 在壓縮之前總結歷史
- **`session:compact:after`**: 在壓縮完成後附帶摘要的元數據

Internal hook payloads emit these as `type: "session"` with `action: "compact:before"` / `action: "compact:after"`; listeners subscribe with the combined keys above.
Specific handler registration uses the literal key format `${type}:${action}`. For these events, register `session:compact:before` and `session:compact:after`.

### Agent Events

- **`agent:bootstrap`**: 在工作區域啟動檔案被注入之前（hooks 可能會變更 `context.bootstrapFiles`）

### Gateway Events

當網關啟動時觸發：

- **`gateway:startup`**: 在通道啟動並且鉤子加載後

### Message Events

當接收到或發送消息時觸發：

- **`message`**: 所有訊息事件（一般監聽器）
- **`message:received`**: 當從任何頻道接收到進來的訊息時。此事件在處理過程中較早觸發，並在媒體理解之前。內容可能包含尚未處理的媒體附件的原始佔位符，例如 `<media:audio>`。
- **`message:transcribed`**: 當訊息已完全處理，包括音訊轉錄和連結理解。此時，`transcript` 包含音訊訊息的完整轉錄文本。當您需要訪問轉錄的音訊內容時，請使用此掛鉤。
- **`message:preprocessed`**: 在所有媒體和連結理解完成後，對每條訊息觸發，讓掛鉤可以訪問完全豐富的內容（轉錄、圖片描述、連結摘要），在代理看到之前。
- **`message:sent`**: 當出站訊息成功發送時觸發。

#### Message Event Context

訊息事件包含有關該訊息的豐富上下文：

typescript
// message:received context
{
from: string, // 發送者識別碼（電話號碼、用戶 ID 等）
content: string, // 訊息內容
timestamp?: number, // 接收時的 Unix 時間戳
channelId: string, // 通道（例如："whatsapp"、"telegram"、"discord"）
accountId?: string, // 多帳戶設置的提供者帳戶 ID
conversationId?: string, // 聊天/對話 ID
messageId?: string, // 來自提供者的訊息 ID
metadata?: { // 附加的提供者特定數據
to?: string,
provider?: string,
surface?: string,
threadId?: string,
senderId?: string,
senderName?: string,
senderUsername?: string,
senderE164?: string,
}
}

// message:sent context
{
to: string, // 收件者識別碼
content: string, // 發送的訊息內容
success: boolean, // 發送是否成功
error?: string, // 如果發送失敗的錯誤訊息
channelId: string, // 頻道（例如："whatsapp"、"telegram"、"discord"）
accountId?: string, // 提供者帳戶 ID
conversationId?: string, // 聊天/對話 ID
messageId?: string, // 提供者返回的訊息 ID
isGroup?: boolean, // 此外發訊息是否屬於群組/頻道上下文
groupId?: string, // 與 message:received 相關聯的群組/頻道識別碼
}

// message:transcribed context
{
body?: string, // 增強前的原始進來的內容
bodyForAgent?: string, // 可供代理人查看的增強內容
transcript: string, // 音訊轉錄文本
channelId: string, // 通道（例如："telegram", "whatsapp"）
conversationId?: string,
messageId?: string,
}

// message:preprocessed context
{
body?: string, // 原始進來的內容
bodyForAgent?: string, // 媒體/連結理解後的最終豐富內容
transcript?: string, // 當音訊存在時的逐字稿
channelId: string, // 頻道（例如："telegram", "whatsapp"）
conversationId?: string,
messageId?: string,
isGroup?: boolean,
groupId?: string,
}

#### 範例：訊息記錄器鉤子

typescript
const isMessageReceivedEvent = (event: { type: string; action: string }) =>
event.type === "message" && event.action === "received";
const isMessageSentEvent = (event: { type: string; action: string }) =>
event.type === "message" && event.action === "sent";

const handler = async (event) => {
if (isMessageReceivedEvent(event as { type: string; action: string })) {
console.log(`[message-logger] Received from ${event.context.from}: ${event.context.content}`);
} else if (isMessageSentEvent(event as { type: string; action: string })) {
console.log(`[message-logger] Sent to ${event.context.to}: ${event.context.content}`);
}
};

### 工具結果鉤子 (插件 API)

這些鉤子並不是事件串流監聽器；它們允許插件在 OpenClaw 將工具結果持久化之前同步調整這些結果。

- **`tool_result_persist`**：在將工具結果寫入會話記錄之前轉換工具結果。必須是同步的；返回更新後的工具結果有效載荷或 `undefined` 以保持原樣。請參見 [Agent Loop](/concepts/agent-loop)。

### Plugin Hook Events

透過插件鉤子執行器暴露的壓縮生命週期鉤子：

- **`before_compaction`**: 在包含計數/token 元數據的壓縮之前執行
- **`after_compaction`**: 在包含壓縮摘要元數據的壓縮之後執行

### Future Events

計劃中的事件類型：

- **`session:start`**: 當新的會話開始時
- **`session:end`**: 當會話結束時
- **`agent:error`**: 當代理遇到錯誤時

## 創建自訂 Hook

### 1. 選擇位置

- **工作區鉤子** (`<workspace>/hooks/`): 每個代理，最高優先權
- **管理鉤子** (`~/.openclaw/hooks/`): 在工作區之間共享

### 2. 建立目錄結構

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. 創建 HOOK.md

## markdown

name: my-hook
description: "執行一些有用的操作"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }

---

# My Custom Hook

這個鉤子在你發出 `/new` 時會執行一些有用的操作。

### 4. 建立 handler.ts

typescript
const handler = async (event) => {
if (event.type !== "command" || event.action !== "new") {
return;
}

console.log("[my-hook] 正在執行!");
// 你的邏輯在這裡
};

### 5. 啟用與測試

bash

# 驗證 hook 是否被發現

openclaw hooks list

# 啟用它

openclaw hooks enable my-hook

# 重新啟動您的網關過程（在 macOS 上的選單列應用程式重新啟動，或重新啟動您的開發過程）

# 觸發事件

# 通過您的消息通道發送 /new

## Configuration

### 新的設定格式（推薦）

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

### 每個 Hook 的設定

Hooks 可以有自訂的設定：

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

### Extra Directories

從其他目錄載入鉤子：

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

### 過去的設定格式（仍然支援）

舊的設定格式仍然可以使用，以保持向後相容性：

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

注意：`module` 必須是相對於工作區的路徑。絕對路徑和超出工作區的路徑將被拒絕。

**遷移**：對於新的 hooks，請使用基於發現的新系統。舊版處理程序在基於目錄的 hooks 之後加載。

## CLI 命令

### List Hooks

bash

# 列出所有的 hooks

openclaw hooks list

# 僅顯示符合條件的 hooks

openclaw hooks list --eligible

# 詳細輸出（顯示缺少的要求）

openclaw hooks list --verbose

# JSON 輸出

openclaw hooks list --json

### Hook Information

bash

# 顯示有關 hook 的詳細資訊

openclaw hooks info session-memory

# JSON 輸出

openclaw hooks info session-memory --json

### Check Eligibility

bash

# 顯示資格摘要

openclaw hooks check

# JSON 輸出

openclaw hooks check --json

### 啟用/停用

bash

# 啟用一個鉤子

openclaw hooks enable session-memory

# 禁用一個鉤子

openclaw hooks disable command-logger

## Bundled hook reference

### session-memory

當你發出 `/new` 時，會將會話上下文儲存到記憶體中。

**Events**: `command:new`

**需求**: `workspace.dir` 必須被設定。

**輸出**: `<workspace>/memory/YYYY-MM-DD-slug.md`（預設為 `~/.openclaw/workspace`）

**它的功能**：

1. 使用重置前的會話條目來定位正確的逐字稿
2. 擷取最後 15 行對話
3. 使用 LLM 生成描述性的檔名標識
4. 將會話元數據保存到帶日期的記憶檔案中

**範例輸出**:

markdown

# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram

**檔案名稱範例**:

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md` (如果生成 slug 失敗，則使用的備用時間戳)

**Enable**:

```bash
openclaw hooks enable session-memory
```

### bootstrap-extra-files

在 `agent:bootstrap` 期間注入額外的啟動檔案（例如 monorepo-local `AGENTS.md` / `TOOLS.md`）。

**事件**: `agent:bootstrap`

**需求**: `workspace.dir` 必須被設定。

**輸出**：未寫入任何檔案；啟動上下文僅在記憶體中修改。

**Config**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "bootstrap-extra-files": {
          "enabled": true,
          "paths": ["packages/*/AGENTS.md", "packages/*/TOOLS.md"]
        }
      }
    }
  }
}
```

**備註**:

- 路徑是相對於工作區解析的。
- 檔案必須保留在工作區內（經過實際路徑檢查）。
- 只有被認可的啟動基名會被載入。
- 子代理的允許清單被保留（`AGENTS.md` 和 `TOOLS.md` 只有）。

**Enable**:

```bash
openclaw hooks enable bootstrap-extra-files
```

### command-logger

將所有命令事件記錄到集中式審計檔案中。

**Events**: `command`

**Requirements**: None

`~/.openclaw/logs/commands.log`

**它的功能**：

1. 捕捉事件詳細資訊（命令動作、時間戳記、會話金鑰、發送者 ID、來源）
2. 以 JSONL 格式附加到日誌檔案
3. 在背景靜默執行

**範例日誌條目**:

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**查看日誌**:

bash

# 查看最近的指令

tail -n 20 ~/.openclaw/logs/commands.log

# 使用 jq 進行美化輸出

cat ~/.openclaw/logs/commands.log | jq .

# 根據動作過濾

grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .

**Enable**:

```bash
openclaw hooks enable command-logger
```

### boot-md

當網關啟動時（在通道啟動後）執行 `BOOT.md`。必須啟用內部鉤子才能執行此操作。

**事件**: `gateway:startup`

**需求**：`workspace.dir` 必須被設定。

**它的功能**：

1. 從你的工作區讀取 `BOOT.md`
2. 通過代理執行者執行指令
3. 通過消息工具發送任何請求的外發消息

**Enable**:

```bash
openclaw hooks enable boot-md
```

## 最佳實踐

### 保持處理程序快速

Hooks 在命令處理期間執行。請保持它們輕量：

typescript
// ✓ 好 - 非同步工作，立即返回
const handler: HookHandler = async (event) => {
void processInBackground(event); // 發送後忘記
};

// ✗ 錯誤 - 阻塞命令處理
const handler: HookHandler = async (event) => {
await slowDatabaseQuery(event);
await evenSlowerAPICall(event);
};

### 優雅地處理錯誤

始終包裝風險操作：

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

### 早期過濾事件

如果事件不相關，則提前返回：

typescript
const handler: HookHandler = async (event) => {
// 只處理 'new' 命令
if (event.type !== "command" || event.action !== "new") {
return;
}

};

### 使用特定事件鍵

在可能的情況下，請在元數據中指定確切的事件：

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # Specific
```

[[BLOCK_1]]

```yaml
metadata: { "openclaw": { "events": ["command"] } } # General - more overhead
```

## Debugging

### 啟用 Hook 日誌記錄

[[BLOCK_1]] 門戶日誌在啟動時加載掛鉤：[[BLOCK_1]]

```
Registered hook: session-memory -> command:new
Registered hook: bootstrap-extra-files -> agent:bootstrap
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### Check Discovery

列出所有已發現的鉤子：

```bash
openclaw hooks list --verbose
```

### Check Registration

在你的處理器中，記錄何時被調用：

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // Your logic
};
```

### 驗證資格

檢查為什麼一個 hook 不符合資格：

```bash
openclaw hooks info my-hook
```

尋找輸出中缺失的需求。

## Testing

### Gateway Logs

監控閘道日誌以查看鉤子執行：

bash

# macOS

./scripts/clawlog.sh -f

# 其他平台

tail -f ~/.openclaw/gateway.log

### 直接測試鉤子

在隔離環境中測試你的處理程序：

typescript
import { test } from "vitest";
import myHandler from "./hooks/my-hook/handler.js";

test("我的處理器運作正常", async () => {
const event = {
type: "command",
action: "new",
sessionKey: "test-session",
timestamp: new Date(),
messages: [],
context: { foo: "bar" },
};

await myHandler(event);

// Assert side effects
});

## Architecture

### 核心組件

- **`src/hooks/types.ts`**: 類型定義
- **`src/hooks/workspace.ts`**: 目錄掃描與加載
- **`src/hooks/frontmatter.ts`**: HOOK.md 元數據解析
- **`src/hooks/config.ts`**: 合格性檢查
- **`src/hooks/hooks-status.ts`**: 狀態報告
- **`src/hooks/loader.ts`**: 動態模組加載器
- **`src/cli/hooks-cli.ts`**: CLI 命令
- **`src/gateway/server-startup.ts`**: 在網關啟動時加載鉤子
- **`src/auto-reply/reply/commands-core.ts`**: 觸發命令事件

### Discovery Flow

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

### Event Flow

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

## 故障排除

### Hook 未被發現

1. 檢查目錄結構：

```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # Should show: HOOK.md, handler.ts
```

2. 驗證 HOOK.md 格式：

```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # Should have YAML frontmatter with name and metadata
```

3. 列出所有已發現的 hooks:

```bash
   openclaw hooks list
```

### Hook Not Eligible

檢查需求：

```bash
openclaw hooks info my-hook
```

[[BLOCK_1]]

- 二進位檔（檢查 PATH）
- 環境變數
- 設定值
- 作業系統相容性

### Hook 未執行

1. 驗證 hook 是否已啟用：

```bash
   openclaw hooks list
   # Should show ✓ next to enabled hooks
```

2. 重新啟動您的網關過程，以便重新加載鉤子。

3. 檢查閘道日誌以尋找錯誤：

```bash
   ./scripts/clawlog.sh | grep hook
```

### Handler Errors

檢查 TypeScript/匯入錯誤：

```bash
# Test import directly
node -e "import('./path/to/handler.ts').then(console.log)"
```

## 遷移指南

### 從舊版設定到發現

**Before**:

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

**After**:

1. 建立掛鉤目錄：

```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
```

2. 創建 HOOK.md:

markdown

---

name: my-hook
description: "我的自訂掛鉤"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }

---

# My Hook

3. 更新設定：

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

4. 驗證並重新啟動您的網關過程：

```bash
   openclaw hooks list
   # Should show: 🎯 my-hook ✓
```

**遷移的好處**:

- 自動發現
- CLI 管理
- 資格檢查
- 更好的文件
- 一致的結構

## 另請參閱

- [CLI 參考：hooks](/cli/hooks)
- [捆綁的 Hooks 讀我](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/automation/webhook)
- [設定](/gateway/configuration#hooks)
