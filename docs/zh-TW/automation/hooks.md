---
summary: "Hooks：指令與生命週期事件的事件驅動自動化"
read_when:
  - 您想要針對 /new、/reset、/stop 以及智慧代理生命週期事件進行事件驅動自動化
  - 您想要建置、安裝或偵錯 Hooks
title: "Hooks"
---

# Hooks

Hooks 提供了一個可擴充的事件驅動系統，用於根據智慧代理指令與事件自動執行操作。Hooks 會從目錄中自動探索，並可透過 CLI 指令進行管理，運作方式與 OpenClaw 中的 Skills 類似。

## 概念引導

Hooks 是在事件發生時執行的輕量腳本。分為兩種：

- **Hooks**（本頁面）：當智慧代理事件觸發時在 Gateway 內部執行，例如 `/new`、`/reset`、`/stop` 或生命週期事件。
- **Webhooks**：外部 HTTP webhooks，讓其他系統觸發 OpenClaw 的工作。請參閱 [Webhook Hooks](/automation/webhook) 或使用 `openclaw webhooks` 查看 Gmail 輔助指令。

Hooks 也可以封裝在外掛程式（Plugins）中；詳情請參閱 [Plugins](/tools/plugin#plugin-hooks)。

常見用途：

- 重設工作階段時儲存記憶體快照
- 保留指令稽核追蹤以供疑難排解或合規性使用
- 在工作階段開始或結束時觸發後續自動化
- 當事件觸發時將檔案寫入智慧代理工作空間或呼叫外部 API

如果您會撰寫簡單的 TypeScript 函式，就能撰寫 Hook。Hooks 會被自動探索，您可以透過 CLI 啟用或停用它們。

## 總覽

Hooks 系統允許您：

- 發出 `/new` 指令時將工作階段上下文儲存到記憶體
- 記錄所有指令以供稽核
- 在智慧代理生命週期事件上觸發自訂自動化
- 在不修改核心程式碼的情況下擴充 OpenClaw 的行為

## 入門指南

### 內建 Hooks

OpenClaw 內建四個自動探索的 Hooks：

- **💾 session-memory**：當您發出 `/new` 時，將工作階段上下文儲存到您的智慧代理工作空間（預設為 `~/.openclaw/workspace/memory/`）
- **📎 bootstrap-extra-files**：在 `agent:bootstrap` 期間，從設定的 glob/路徑模式注入額外的工作空間引導（bootstrap）檔案
- **📝 command-logger**：將所有指令事件記錄到 `~/.openclaw/logs/commands.log`
- **🚀 boot-md**：當 Gateway 啟動時執行 `BOOT.md`（需要啟用內部 Hooks）

列出可用的 Hooks：

```bash
openclaw hooks list
```

啟用一個 Hook：

```bash
openclaw hooks enable session-memory
```

檢查 Hook 狀態：

```bash
openclaw hooks check
```

取得詳細資訊：

```bash
openclaw hooks info session-memory
```

### 新手導覽

在新手導覽（`openclaw onboard`）期間，系統會提示您啟用建議的 Hooks。精靈（wizard）會自動探索符合條件的 Hooks 並顯示供您選擇。

## Hook 探索

Hooks 會從三個目錄自動探索（依優先順序排列）：

1. **工作空間 Hooks**：`<workspace>/hooks/`（個別智慧代理專用，優先權最高）
2. **受管 Hooks**：`~/.openclaw/hooks/`（使用者安裝，跨工作空間共享）
3. **內建 Hooks**：`<openclaw>/dist/hooks/bundled/`（OpenClaw 隨附）

受管 Hook 目錄可以是一個 **單一 Hook** 或一個 **Hook pack**（套件目錄）。

每個 Hook 都是一個包含以下內容的目錄：

```
my-hook/
├── HOOK.md          # 中繼資料 + 文件
└── handler.ts       # 處理常式實作
```

## Hook Packs (npm/封存檔)

Hook packs 是標準的 npm 套件，透過 `package.json` 中的 `openclaw.hooks` 匯出一個或多個 Hooks。使用以下指令安裝：

```bash
openclaw hooks install <path-or-spec>
```

`package.json` 範例：

```json
{
  "name": " @acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

每個項目指向包含 `HOOK.md` 和 `handler.ts`（或 `index.ts`）的 Hook 目錄。
Hook packs 可以隨附依賴項目；它們將安裝在 `~/.openclaw/hooks/<id>` 下。

## Hook 結構

### HOOK.md 格式

`HOOK.md` 檔案在 YAML frontmatter 中包含中繼資料，再加上 Markdown 文件：

```markdown
---
name: my-hook
description: "此 Hook 用途的簡短描述"
homepage: https://docs.openclaw.ai/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# 我的 Hook

詳細文件位於此處...

## 功能說明

- 監聽 `/new` 指令
- 執行特定操作
- 記錄結果

## 需求

- 必須安裝 Node.js

## 設定

無需設定。
```

### 中繼資料欄位

`metadata.openclaw` 物件支援：

- **`emoji`**：CLI 顯示用的表情符號（例如 `"💾"`）
- **`events`**：要監聽的事件陣列（例如 `["command:new", "command:reset"]`）
- **`export`**：要使用的具名匯出（預設為 `"default"`）
- **`homepage`**：文件 URL
- **`requires`**：選用需求
  - **`bins`**：PATH 中所需的執行檔（例如 `["git", "node"]`）
  - **`anyBins`**：至少需存在其中一個執行檔
  - **`env`**：所需的環境變數
  - **`config`**：所需的設定路徑（例如 `["workspace.dir"]`）
  - **`os`**：所需的平台（例如 `["darwin", "linux"]`）
- **`always`**：跳過資格檢查（布林值）
- **`install`**：安裝方法（對於內建 Hooks：`[{"id":"bundled","kind":"bundled"}]`）

### 處理常式實作

`handler.ts` 檔案匯出一個 `HookHandler` 函式：

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  // 僅在 'new' 指令時觸發
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  console.log(`  Session: ${event.sessionKey}`);
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);

  // 您的自訂邏輯位於此處

  // 選用：傳送訊息給使用者
  event.messages.push("✨ 我的 Hook 已執行！");
};

export default myHandler;
```

#### 事件上下文 (Event Context)

每個事件包含：

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway',
  action: string,              // 例如 'new', 'reset', 'stop'
  sessionKey: string,          // 工作階段識別碼
  timestamp: Date,             // 事件發生時間
  messages: string[],          // 在此推入訊息以傳送給使用者
  context: {
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // 例如 'whatsapp', 'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: OpenClawConfig
  }
}
```

## 事件類型

### 指令事件

當智慧代理指令發出時觸發：

- **`command`**：所有指令事件（通用監聽器）
- **`command:new`**：當發出 `/new` 指令時
- **`command:reset`**：當發出 `/reset` 指令時
- **`command:stop`**：當發出 `/stop` 指令時

### 智慧代理事件

- **`agent:bootstrap`**：在注入工作空間引導檔案之前（Hooks 可能會變動 `context.bootstrapFiles`）

### Gateway 事件

當 Gateway 啟動時觸發：

- **`gateway:startup`**：在通道啟動且 Hooks 載入之後

### 工具結果 Hooks (Plugin API)

這些 Hooks 並非事件串流監聽器；它們讓外掛程式能在 OpenClaw 持久化工具結果之前同步調整結果。

- **`tool_result_persist`**：在工具結果寫入工作階段紀錄之前對其進行轉換。必須是同步的；傳回更新後的工具結果內容或 `undefined` 以保持原樣。請參閱 [智慧代理迴圈](/concepts/agent-loop)。

### 未來事件

預計開發的事件類型：

- **`session:start`**：當新的工作階段開始時
- **`session:end`**：當工作階段結束時
- **`agent:error`**：當智慧代理遇到錯誤時
- **`message:sent`**：當訊息送出時
- **`message:received`**：當收到訊息時

## 建立自訂 Hooks

### 1. 選擇位置

- **工作空間 Hooks** (`<workspace>/hooks/`)：個別智慧代理專用，優先權最高
- **受管 Hooks** (`~/.openclaw/hooks/`)：跨工作空間共享

### 2. 建立目錄結構

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. 建立 HOOK.md

```markdown
---
name: my-hook
description: "執行一些有用的操作"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# 我的自訂 Hook

當您發出 `/new` 時，此 Hook 會執行一些有用的操作。
```

### 4. 建立 handler.ts

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] Running!");
  // 您的邏輯位於此處
};

export default handler;
```

### 5. 啟用並測試

```bash
# 確認 Hook 已被探索
openclaw hooks list

# 啟用它
openclaw hooks enable my-hook

# 重新啟動您的 Gateway 處理程序（macOS 上重啟選單列應用程式，或重啟您的開發處理程序）

# 觸發事件
# 透過您的訊息通道傳送 /new
```

## 設定

### 新設定格式（推薦）

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

### 個別 Hook 設定

Hooks 可以有自訂設定：

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

### 額外目錄

從其他目錄載入 Hooks：

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

### 舊版設定格式（仍支援）

為了回溯相容性，舊的設定格式仍然有效：

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

**遷移提示**：對於新的 Hooks，請使用新的基於探索的系統。舊版處理常式會在基於目錄的 Hooks 之後載入。

## CLI 指令

### 列出 Hooks

```bash
# 列出所有 Hooks
openclaw hooks list

# 僅顯示符合條件的 Hooks
openclaw hooks list --eligible

# 詳細輸出（顯示缺少的需求）
openclaw hooks list --verbose

# JSON 輸出
openclaw hooks list --json
```

### Hook 資訊

```bash
# 顯示 Hook 的詳細資訊
openclaw hooks info session-memory

# JSON 輸出
openclaw hooks info session-memory --json
```

### 檢查資格

```bash
# 顯示資格摘要
openclaw hooks check

# JSON 輸出
openclaw hooks check --json
```

### 啟用/停用

```bash
# 啟用 Hook
openclaw hooks enable session-memory

# 停用 Hook
openclaw hooks disable command-logger
```

## 內建 Hook 參考

### session-memory

當您發出 `/new` 指令時，將工作階段上下文儲存到記憶體中。

**事件**：`command:new`

**需求**：必須設定 `workspace.dir`

**輸出**：`<workspace>/memory/YYYY-MM-DD-slug.md`（預設為 `~/.openclaw/workspace`）

**功能說明**：

1. 使用重設前的工作階段項目來定位正確的紀錄
2. 擷取最後 15 行對話
3. 使用 LLM 生成具描述性的檔案名稱代稱 (slug)
4. 將工作階段中繼資料儲存到帶有日期的記憶體檔案中

**輸出範例**：

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

**檔案名稱範例**：

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md`（如果代稱生成失敗，則使用時間戳記備案）

**啟用**：

```bash
openclaw hooks enable session-memory
```

### bootstrap-extra-files

在 `agent:bootstrap` 期間注入額外的引導 (bootstrap) 檔案（例如 monorepo 本地的 `AGENTS.md` / `TOOLS.md`）。

**事件**：`agent:bootstrap`

**需求**：必須設定 `workspace.dir`

**輸出**：不寫入檔案；引導上下文僅在記憶體中修改。

**設定**：

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

**附註**：

- 路徑相對於工作空間解析。
- 檔案必須留在工作空間內（會進行實體路徑檢查）。
- 僅載入可識別的引導基本檔名。
- 子智慧代理（Subagent）允許清單會被保留（僅限 `AGENTS.md` 和 `TOOLS.md`）。

**啟用**：

```bash
openclaw hooks enable bootstrap-extra-files
```

### command-logger

將所有指令事件記錄到一個集中式的稽核檔案中。

**事件**：`command`

**需求**：無

**輸出**：`~/.openclaw/logs/commands.log`

**功能說明**：

1. 擷取事件詳細資訊（指令操作、時間戳記、工作階段金鑰、傳送者 ID、來源）
2. 以 JSONL 格式附加到日誌檔
3. 在背景安靜執行

**日誌項目範例**：

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user @example.com","source":"whatsapp"}
```

**查看日誌**：

```bash
# 查看最近的指令
tail -n 20 ~/.openclaw/logs/commands.log

# 使用 jq 進行美化列印
cat ~/.openclaw/logs/commands.log | jq .

# 按操作過濾
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**啟用**：

```bash
openclaw hooks enable command-logger
```

### boot-md

當 Gateway 啟動時（在通道啟動後）執行 `BOOT.md`。
必須啟用內部 Hooks 才能執行此項。

**事件**：`gateway:startup`

**需求**：必須設定 `workspace.dir`

**功能說明**：

1. 從您的工作空間讀取 `BOOT.md`
2. 透過智慧代理執行器執行指令
3. 透過訊息工具傳送任何要求的對外訊息

**啟用**：

```bash
openclaw hooks enable boot-md
```

## 最佳實踐

### 保持處理常式快速

Hooks 在指令處理期間執行。請保持輕量：

```typescript
// ✓ 優良 - 非同步工作，立即回傳
const handler: HookHandler = async (event) => {
  void processInBackground(event); // 執行後不理 (Fire and forget)
};

// ✗ 不佳 - 阻塞指令處理
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### 優雅地處理錯誤

務必封裝具風險的操作：

```typescript
const handler: HookHandler = async (event) => {
  try {
    await riskyOperation(event);
  } catch (err) {
    console.error("[my-handler] Failed:", err instanceof Error ? err.message : String(err));
    // 不要拋出錯誤 - 讓其他處理常式能繼續執行
  }
};
```

### 儘早過濾事件

如果事件不相關，請儘早回傳：

```typescript
const handler: HookHandler = async (event) => {
  // 僅處理 'new' 指令
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // 您的邏輯位於此處
};
```

### 使用特定的事件鍵名

儘可能在中繼資料中指定確切的事件：

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # 特定
```

而非：

```yaml
metadata: { "openclaw": { "events": ["command"] } } # 通用 - 負載較高
```

## 偵錯

### 啟用 Hook 日誌

Gateway 在啟動時會記錄 Hook 載入情況：

```
Registered hook: session-memory -> command:new
Registered hook: bootstrap-extra-files -> agent:bootstrap
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### 檢查探索情形

列出所有探索到的 Hooks：

```bash
openclaw hooks list --verbose
```

### 檢查註冊情形

在您的處理常式中，記錄它何時被呼叫：

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // 您的邏輯
};
```

### 驗證資格

檢查為何 Hook 不符合資格：

```bash
openclaw hooks info my-hook
```

在輸出中尋找缺失的需求。

## 測試

### Gateway 日誌

監看 Gateway 日誌以查看 Hook 執行情況：

```bash
# macOS
./scripts/clawlog.sh -f

# 其他平台
tail -f ~/.openclaw/gateway.log
```

### 直接測試 Hooks

隔離測試您的處理常式：

```typescript
import { test } from "vitest";
import { createHookEvent } from "./src/hooks/hooks.js";
import myHandler from "./hooks/my-hook/handler.js";

test("my handler works", async () => {
  const event = createHookEvent("command", "new", "test-session", {
    foo: "bar",
  });

  await myHandler(event);

  // 斷言副作用
});
```

## 架構

### 核心組件

- **`src/hooks/types.ts`**：類型定義
- **`src/hooks/workspace.ts`**：目錄掃描與載入
- **`src/hooks/frontmatter.ts`**：HOOK.md 中繼資料解析
- **`src/hooks/config.ts`**：資格檢查
- **`src/hooks/hooks-status.ts`**：狀態回報
- **`src/hooks/loader.ts`**：動態模組載入器
- **`src/cli/hooks-cli.ts`**：CLI 指令
- **`src/gateway/server-startup.ts`**：在 Gateway 啟動時載入 Hooks
- **`src/auto-reply/reply/commands-core.ts`**：觸發指令事件

### 探索流程

```
Gateway 啟動
    ↓
掃描目錄（工作空間 → 受管 → 內建）
    ↓
解析 HOOK.md 檔案
    ↓
檢查資格（執行檔, 環境變數, 設定, 作業系統）
    ↓
從符合資格的 Hooks 載入處理常式
    ↓
為事件註冊處理常式
```

### 事件流程

```
使用者傳送 /new
    ↓
指令驗證
    ↓
建立 Hook 事件
    ↓
觸發 Hook（所有已註冊的處理常式）
    ↓
指令處理繼續
    ↓
工作階段重設
```

## 疑難排解

### Hook 未被探索

1. 檢查目錄結構：

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # 應顯示：HOOK.md, handler.ts
   ```

2. 驗證 HOOK.md 格式：

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # 應包含具有名稱與中繼資料的 YAML frontmatter
   ```

3. 列出所有探索到的 Hooks：

   ```bash
   openclaw hooks list
   ```

### Hook 不符合資格

檢查需求：

```bash
openclaw hooks info my-hook
```

尋找是否缺少：

- 執行檔（檢查 PATH）
- 環境變數
- 設定值
- 作業系統相容性

### Hook 未執行

1. 驗證 Hook 已啟用：

   ```bash
   openclaw hooks list
   # 啟用的 Hooks 旁邊應顯示 ✓
   ```

2. 重新啟動您的 Gateway 處理程序以重載 Hooks。

3. 檢查 Gateway 日誌中的錯誤：

   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### 處理常式錯誤

檢查 TypeScript/匯入錯誤：

```bash
# 直接測試匯入
node -e "import('./path/to/handler.ts').then(console.log)"
```

## 遷移指南

### 從舊版設定遷移至自動探索

**之前**：

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

**之後**：

1. 建立 Hook 目錄：

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. 建立 HOOK.md：

   ```markdown
   ---
   name: my-hook
   description: "我的自訂 Hook"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # 我的 Hook

   執行一些有用的操作。
   ```

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

4. 驗證並重啟您的 Gateway 處理程序：

   ```bash
   openclaw hooks list
   # 應顯示：🎯 my-hook ✓
   ```

**遷移的好處**：

- 自動探索
- CLI 管理
- 資格檢查
- 更好的文件化
- 一致的結構

## 延伸閱讀

- [CLI 參考：hooks](/cli/hooks)
- [內建 Hooks README](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/automation/webhook)
- [設定](/gateway/configuration#hooks)
