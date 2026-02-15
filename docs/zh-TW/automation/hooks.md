---
summary: "Hooks：用於命令與生命週期事件的事件驅動自動化"
read_when:
  - 您希望對 /new、/reset、/stop 及智慧代理生命週期事件進行事件驅動自動化
  - 您想要建置、安裝或偵錯 Hooks
title: "Hooks"
---

# Hooks

Hooks 提供了一個可擴充的事件驅動系統，用於自動化回應智慧代理命令和事件的動作。Hooks 會從目錄中自動探索，並可透過 CLI 命令進行管理，類似於 OpenClaw 中的 Skills 運作方式。

## 快速上手

Hooks 是在事件發生時執行的小型指令碼。主要有兩種：

-   **Hooks** (此頁)：在智慧代理事件觸發時 (例如 `/new`、`/reset`、`/stop` 或生命週期事件) 於 Gateway 內部執行。
-   **Webhooks**：外部 HTTP webhooks，允許其他系統在 OpenClaw 中觸發工作。請參閱 [Webhook Hooks](/automation/webhook) 或使用 `openclaw webhooks` 取得 Gmail 輔助命令。

Hooks 也可以捆綁在外掛程式中；請參閱 [Plugins](/tools/plugin#plugin-hooks)。

常見用途：

-   在您重設工作階段時儲存記憶體快照
-   保留命令的稽核軌跡以進行疑難排解或合規性檢查
-   在工作階段開始或結束時觸發後續自動化
-   在事件觸發時將檔案寫入智慧代理工作區或呼叫外部 API

如果您可以撰寫一個小型 TypeScript 函數，那麼您就可以撰寫一個 hook。Hooks 會自動探索，您可以透過 CLI 啟用或停用它們。

## 概覽

Hooks 系統允許您：

-   在發出 `/new` 命令時將工作階段上下文儲存到記憶體中
-   記錄所有命令以進行稽核
-   在智慧代理生命週期事件上觸發自訂自動化
-   擴展 OpenClaw 的行為而無需修改核心程式碼

## 入門指南

### 內建 Hooks

OpenClaw 隨附四個會自動探索的內建 Hooks：

-   **💾 session-memory**：在您發出 `/new` 命令時，將工作階段上下文儲存到您的智慧代理工作區 (預設 `~/.openclaw/workspace/memory/`)。
-   **📎 bootstrap-extra-files**：在 `agent:bootstrap` 期間，從設定的 glob/路徑模式注入額外的工作區引導檔案。
-   **📝 command-logger**：將所有命令事件記錄到 `~/.openclaw/logs/commands.log`。
-   **🚀 boot-md**：在 Gateway 啟動時執行 `BOOT.md` (需要啟用內部 hooks)。

列出可用的 hooks：

```bash
openclaw hooks list
```

啟用 hook：

```bash
openclaw hooks enable session-memory
```

檢查 hook 狀態：

```bash
openclaw hooks check
```

取得詳細資訊：

```bash
openclaw hooks info session-memory
```

### 新手導覽

在新手導覽 (`openclaw onboard`) 期間，系統會提示您啟用推薦的 hooks。精靈會自動探索符合條件的 hooks 並提供給您選擇。

## Hook 探索

Hooks 會從三個目錄中自動探索 (依優先順序排列)：

1.  **工作區 hooks**：`<workspace>/hooks/` (每個智慧代理，最高優先順序)
2.  **管理的 hooks**：`~/.openclaw/hooks/` (使用者安裝，跨工作區共用)
3.  **內建 hooks**：`<openclaw>/dist/hooks/bundled/` (隨 OpenClaw 提供)

管理的 hook 目錄可以是**單一 hook** 或**hook 套件** (套件目錄)。

每個 hook 都是一個包含以下內容的目錄：

```
my-hook/
├── HOOK.md          # 中繼資料 + 文件
└── handler.ts       # 處理常式實作
```

## Hook 套件 (npm/歸檔)

Hook 套件是標準 npm 套件，透過 `package.json` 中的 `openclaw.hooks` 匯出一個或多個 hooks。
使用以下命令安裝它們：

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

每個條目都指向一個包含 `HOOK.md` 和 `handler.ts` (或 `index.ts`) 的 hook 目錄。
Hook 套件可以隨附依賴項；它們將安裝在 `~/.openclaw/hooks/<id>` 下。

## Hook 結構

### HOOK.md 格式

`HOOK.md` 檔案包含 YAML frontmatter 中的中繼資料以及 Markdown 文件：

```markdown
---
name: my-hook
description: "此 hook 功能的簡短描述"
homepage: https://docs.openclaw.ai/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# 我的 Hook

詳細文件在此處...

## 功能

-   監聽 `/new` 命令
-   執行某些動作
-   記錄結果

## 需求

-   必須安裝 Node.js

## 設定

無需設定。
```

### 中繼資料欄位

`metadata.openclaw` 物件支援：

-   **`emoji`**：用於 CLI 的顯示表情符號 (例如 `"💾"`)
-   **`events`**：要監聽的事件陣列 (例如 `["command:new", "command:reset"]`)
-   **`export`**：要使用的具名匯出 (預設為 `"default"`)
-   **`homepage`**：文件 URL
-   **`requires`**：選用需求
    -   **`bins`**：PATH 中所需的二進位檔 (例如 `["git", "node"]`)
    -   **`anyBins`**：這些二進位檔中至少必須存在一個
    -   **`env`**：所需的環境變數
    -   **`config`**：所需的設定路徑 (例如 `["workspace.dir"]`)
    -   **`os`**：所需的平台 (例如 `["darwin", "linux"]`)
-   **`always`**：繞過資格檢查 (布林值)
-   **`install`**：安裝方法 (對於內建 hooks：`[{"id":"bundled","kind":"bundled"}]`)

### 處理常式實作

`handler.ts` 檔案匯出一個 `HookHandler` 函數：

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  // 僅在 'new' 命令上觸發
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] 新命令已觸發`);
  console.log(`  工作階段: ${event.sessionKey}`);
  console.log(`  時間戳記: ${event.timestamp.toISOString()}`);

  // 您的自訂邏輯在此

  // (選用) 向使用者傳送訊息
  event.messages.push("✨ 我的 hook 已執行！");
};

export default myHandler;
```

#### 事件上下文

每個事件包含：

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway',
  action: string,              // 例如 'new', 'reset', 'stop'
  sessionKey: string,          // 工作階段識別碼
  timestamp: Date,             // 事件發生時間
  messages: string[],          // 將訊息推送到此處以傳送給使用者
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

### 命令事件

在發出智慧代理命令時觸發：

-   **`command`**：所有命令事件 (通用監聽器)
-   **`command:new`**：發出 `/new` 命令時
-   **`command:reset`**：發出 `/reset` 命令時
-   **`command:stop`**：發出 `/stop` 命令時

### 智慧代理事件

-   **`agent:bootstrap`**：在注入工作區引導檔案之前 (hooks 可能會改變 `context.bootstrapFiles`)

### Gateway 事件

在 Gateway 啟動時觸發：

-   **`gateway:startup`**：在頻道啟動和 hooks 載入之後

### 工具結果 Hooks (外掛程式 API)

這些 hooks 不是事件串流監聽器；它們讓外掛程式在 OpenClaw 持久化工具結果之前同步調整它們。

-   **`tool_result_persist`**：在工具結果寫入工作階段轉錄之前轉換它們。必須是同步的；返回更新後的工具結果酬載或 `undefined` 以保持原樣。請參閱 [智慧代理迴圈](/concepts/agent-loop)。

### 未來事件

規劃的事件類型：

-   **`session:start`**：新工作階段開始時
-   **`session:end`**：工作階段結束時
-   **`agent:error`**：智慧代理遇到錯誤時
-   **`message:sent`**：傳送訊息時
-   **`message:received`**：接收訊息時

## 建立自訂 Hooks

### 1. 選擇位置

-   **工作區 hooks** (`<workspace>/hooks/`)：每個智慧代理，最高優先順序
-   **管理的 hooks** (`~/.openclaw/hooks/`)：跨工作區共用

### 2. 建立目錄結構

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. 建立 HOOK.md

```markdown
---
name: my-hook
description: "執行有用的功能"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# 我的自訂 Hook

當您發出 `/new` 命令時，這個 hook 會執行一些有用的功能。
```

### 4. 建立 handler.ts

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] 執行中！");
  // 您的邏輯在此
};

export default handler;
```

### 5. 啟用與測試

```bash
# 驗證 hook 是否已探索
openclaw hooks list

# 啟用它
openclaw hooks enable my-hook

# 重新啟動您的 Gateway 程序 (在 macOS 上重新啟動選單列應用程式，或重新啟動您的開發程序)

# 觸發事件
# 透過您的訊息頻道傳送 /new
```

## 設定

### 新設定格式 (推薦)

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

從額外目錄載入 hooks：

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

### 舊版設定格式 (仍然支援)

舊版設定格式仍然支援以保持向後相容性：

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

**遷移**：為新的 hooks 使用基於探索的系統。舊版處理常式會在基於目錄的 hooks 之後載入。

## CLI 命令

### 列出 Hooks

```bash
# 列出所有 hooks
openclaw hooks list

# 僅顯示符合條件的 hooks
openclaw hooks list --eligible

# 詳細輸出 (顯示缺少的需求)
openclaw hooks list --verbose

# JSON 輸出
openclaw hooks list --json
```

### Hook 資訊

```bash
# 顯示 hook 的詳細資訊
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
# 啟用 hook
openclaw hooks enable session-memory

# 停用 hook
openclaw hooks disable command-logger
```

## 內建 hook 參考

### session-memory

在您發出 `/new` 命令時，將工作階段上下文儲存到記憶體中。

**事件**：`command:new`

**需求**：必須設定 `workspace.dir`

**輸出**：`<workspace>/memory/YYYY-MM-DD-slug.md` (預設為 `~/.openclaw/workspace`)

**功能**：

1.  使用預重設工作階段條目來定位正確的轉錄
2.  提取最近 15 行的對話
3.  使用 LLM 生成描述性的檔案名稱 slug
4.  將工作階段中繼資料儲存到帶日期的記憶體檔案

**檔案名稱範例**：

-   `2026-01-16-vendor-pitch.md`
-   `2026-01-16-api-design.md`
-   `2026-01-16-1430.md` (如果 slug 生成失敗，則為後備時間戳記)

**啟用**：

```bash
openclaw hooks enable session-memory
```

### bootstrap-extra-files

在 `agent:bootstrap` 期間注入額外的引導檔案 (例如單一儲存庫本機的 `AGENTS.md` / `TOOLS.md`)。

**事件**：`agent:bootstrap`

**需求**：必須設定 `workspace.dir`

**輸出**：未寫入任何檔案；僅在記憶體中修改引導上下文。

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

**注意事項**：

-   路徑會相對於工作區解析。
-   檔案必須保留在工作區內 (已檢查真實路徑)。
-   僅載入已識別的引導基本名稱。
-   保留次級智慧代理允許列表 (`AGENTS.md` 和 `TOOLS.md` 僅限)。

**啟用**：

```bash
openclaw hooks enable bootstrap-extra-files
```

### command-logger

將所有命令事件記錄到集中式稽核檔案。

**事件**：`command`

**需求**：無

**輸出**：`~/.openclaw/logs/commands.log`

**功能**：

1.  擷取事件詳細資訊 (命令動作、時間戳記、工作階段鍵、傳送者 ID、來源)
2.  以 JSONL 格式附加到日誌檔案
3.  在背景靜默執行

**日誌條目範例**：

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user @example.com","source":"whatsapp"}
```

**檢視日誌**：

```bash
# 檢視最近的命令
tail -n 20 ~/.openclaw/logs/commands.log

# 使用 jq 美觀列印
cat ~/.openclaw/logs/commands.log | jq .

# 依動作篩選
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**啟用**：

```bash
openclaw hooks enable command-logger
```

### boot-md

在 Gateway 啟動時執行 `BOOT.md` (在頻道啟動之後)。
必須啟用內部 hooks 才能執行此操作。

**事件**：`gateway:startup`

**需求**：必須設定 `workspace.dir`

**功能**：

1.  從您的工作區讀取 `BOOT.md`
2.  透過智慧代理執行器執行指令
3.  透過訊息工具傳送任何請求的對外訊息

**啟用**：

```bash
openclaw hooks enable boot-md
```

## 最佳實踐

### 保持處理常式快速

Hooks 在命令處理期間執行。保持它們輕量：

```typescript
// ✓ 好 - 異步工作，立即返回
const handler: HookHandler = async (event) => {
  void processInBackground(event); // 觸發即忘記
};

// ✗ 不好 - 阻擋命令處理
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### 優雅地處理錯誤

始終包裝有風險的操作：

```typescript
const handler: HookHandler = async (event) => {
  try {
    await riskyOperation(event);
  } catch (err) {
    console.error("[my-handler] 失敗:", err instanceof Error ? err.message : String(err));
    // 不要拋出 - 讓其他處理常式執行
  }
};
```

### 及早篩選事件

如果事件不相關，則及早返回：

```typescript
const handler: HookHandler = async (event) => {
  // 僅處理 'new' 命令
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // 您的邏輯
};
```

### 使用特定的事件鍵

盡可能在中繼資料中指定確切的事件：

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # 特定
```

而不是：

```yaml
metadata: { "openclaw": { "events": ["command"] } } # 一般 - 更多開銷
```

## 偵錯

### 啟用 Hook 日誌記錄

Gateway 在啟動時會記錄 hook 載入：

```
Registered hook: session-memory -> command:new
Registered hook: bootstrap-extra-files -> agent:bootstrap
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### 檢查探索

列出所有探索到的 hooks：

```bash
openclaw hooks list --verbose
```

### 檢查註冊

在您的處理常式中，記錄呼叫時間：

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] 已觸發:", event.type, event.action);
  // 您的邏輯
};
```

### 驗證資格

檢查 hook 不符合資格的原因：

```bash
openclaw hooks info my-hook
```

尋找缺少的：

-   二進位檔 (檢查 PATH)
-   環境變數
-   設定值
-   作業系統相容性

### Hook 未執行

1.  驗證 hook 已啟用：

    ```bash
    openclaw hooks list
    # 啟用 hook 旁邊應顯示 ✓
    ```

2.  重新啟動您的 Gateway 程序，以便 hooks 重新載入。

3.  檢查 Gateway 日誌是否有錯誤：

    ```bash
    ./scripts/clawlog.sh | grep hook
    ```

### 處理常式錯誤

檢查 TypeScript/import 錯誤：

```bash
# 直接測試 import
node -e "import('./path/to/handler.ts').then(console.log)"
```

## 測試

### Gateway 日誌

監控 Gateway 日誌以查看 hook 執行：

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

test("我的處理常式運作正常", async () => {
  const event = createHookEvent("command", "new", "test-session", {
    foo: "bar",
  });

  await myHandler(event);

  // 斷言副作用
});
```

## 架構

### 核心組件

-   **`src/hooks/types.ts`**：類型定義
-   **`src/hooks/workspace.ts`**：目錄掃描和載入
-   **`src/hooks/frontmatter.ts`**：HOOK.md 中繼資料解析
-   **`src/hooks/config.ts`**：資格檢查
-   **`src/hooks/hooks-status.ts`**：狀態報告
-   **`src/hooks/loader.ts`**：動態模組載入器
-   **`src/cli/hooks-cli.ts`**：CLI 命令
-   **`src/gateway/server-startup.ts`**：在 Gateway 啟動時載入 hooks
-   **`src/auto-reply/reply/commands-core.ts`**：觸發命令事件

### 探索流程

```
Gateway 啟動
    ↓
掃描目錄 (工作區 → 管理 → 內建)
    ↓
解析 HOOK.md 檔案
    ↓
檢查資格 (二進位檔、環境變數、設定、作業系統)
    ↓
從符合條件的 hooks 載入處理常式
    ↓
為事件註冊處理常式
```

### 事件流程

```
使用者傳送 /new
    ↓
命令驗證
    ↓
建立 hook 事件
    ↓
觸發 hook (所有註冊的處理常式)
    ↓
命令處理繼續
    ↓
工作階段重設
```

## 疑難排解

### Hook 未探索

1.  檢查目錄結構：

    ```bash
    ls -la ~/.openclaw/hooks/my-hook/
    # 應顯示：HOOK.md, handler.ts
    ```

2.  驗證 HOOK.md 格式：

    ```bash
    cat ~/.openclaw/hooks/my-hook/HOOK.md
    # 應具有包含名稱和中繼資料的 YAML frontmatter
    ```

3.  列出所有探索到的 hooks：

    ```bash
    openclaw hooks list
    ```

### Hook 不符合資格

檢查需求：

```bash
openclaw hooks info my-hook
```

尋找缺少的：

-   二進位檔 (檢查 PATH)
-   環境變數
-   設定值
-   作業系統相容性

### Hook 未執行

1.  驗證 hook 已啟用：

    ```bash
    openclaw hooks list
    # 啟用 hook 旁邊應顯示 ✓
    ```

2.  重新啟動您的 Gateway 程序，以便 hooks 重新載入。

3.  檢查 Gateway 日誌是否有錯誤：

    ```bash
    ./scripts/clawlog.sh | grep hook
    ```

### 處理常式錯誤

檢查 TypeScript/import 錯誤：

```bash
# 直接測試 import
node -e "import('./path/to/handler.ts').then(console.log)"
```

## 遷移指南

### 從舊版設定遷移到探索

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

1.  建立 hook 目錄：

    ```bash
    mkdir -p ~/.openclaw/hooks/my-hook
    mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
    ```

2.  建立 HOOK.md：

    ```markdown
    ---
    name: my-hook
    description: "我的自訂 hook"
    metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
    ---

    # 我的 Hook

    執行有用的功能。
    ```

3.  更新設定：

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

4.  驗證並重新啟動您的 Gateway 程序：

    ```bash
    openclaw hooks list
    # 應顯示：🎯 my-hook ✓
    ```

**遷移優點**：

-   自動探索
-   CLI 管理
-   資格檢查
-   更好的文件
-   一致的結構

## 另請參閱

-   [CLI 參考：hooks](/cli/hooks)
-   [內建 Hooks README](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
-   [Webhook Hooks](/automation/webhook)
-   [設定](/gateway/configuration#hooks)
