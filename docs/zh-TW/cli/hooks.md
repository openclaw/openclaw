---
summary: CLI reference for `openclaw hooks` (agent hooks)
read_when:
  - You want to manage agent hooks
  - You want to install or update hooks
title: hooks
---

# `openclaw hooks`

管理代理程式掛勾（針對指令如 `/new`、`/reset` 及閘道器啟動的事件驅動自動化）。

相關資訊：

- 掛勾： [Hooks](/automation/hooks)
- 外掛掛勾： [Plugins](/tools/plugin#plugin-hooks)

## 列出所有掛勾

```bash
openclaw hooks list
```

列出從工作區、管理目錄及打包目錄中發現的所有 hooks。

**選項：**

- `--eligible`：僅顯示符合資格的 hooks（符合需求）
- `--json`：以 JSON 格式輸出
- `-v, --verbose`：顯示詳細資訊，包括缺少的需求

**範例輸出：**

Hooks（4/4 已就緒）

已就緒：
🚀 boot-md ✓ - 在 gateway 啟動時執行 BOOT.md
📎 bootstrap-extra-files ✓ - 在 agent 啟動時注入額外的工作區啟動檔案
📝 command-logger ✓ - 將所有指令事件記錄到集中審計檔案
💾 session-memory ✓ - 當執行 /new 指令時，將會話上下文保存到記憶體中

**範例（詳細模式）：**

```bash
openclaw hooks list --verbose
```

顯示不符合資格的 hooks 缺少的需求。

**範例 (JSON):**

```bash
openclaw hooks list --json
```

回傳結構化 JSON 以供程式使用。

## 取得 Hook 資訊

```bash
openclaw hooks info <name>
```

顯示特定 hook 的詳細資訊。

**參數：**

- `<name>`：Hook 名稱（例如 `session-memory`）

**選項：**

- `--json`：以 JSON 格式輸出

**範例：**

```bash
openclaw hooks info session-memory
```

**輸出：**

💾 session-memory ✓ 準備就緒

當執行 /new 指令時，將會話上下文儲存到記憶體中。

詳細資訊：
來源：openclaw-bundled
路徑：/path/to/openclaw/hooks/bundled/session-memory/HOOK.md
處理器：/path/to/openclaw/hooks/bundled/session-memory/handler.ts
首頁：https://docs.openclaw.ai/automation/hooks#session-memory
事件：command:new

需求：
設定：✓ workspace.dir

## 檢查 Hooks 資格

```bash
openclaw hooks check
```

顯示 hook 資格狀態摘要（準備好與未準備好的數量）。

**選項：**

- `--json`：輸出為 JSON 格式

**範例輸出：**

Hooks 狀態

總掛勾數：4
已準備：4
未準備：0

## 啟用 Hook

```bash
openclaw hooks enable <name>
```

透過將特定 hook 新增到您的設定中來啟用它 (`~/.openclaw/config.json`)。

**注意：** 由外掛管理的 hooks 會在 `openclaw hooks list` 中顯示 `plugin:<id>`，無法在此處啟用或停用。請改為啟用或停用該外掛。

**參數：**

- `<name>`: 鉤子名稱（例如，`session-memory`）

**範例：**

```bash
openclaw hooks enable session-memory
```

**輸出：**

```
✓ Enabled hook: 💾 session-memory
```

**功能說明：**

- 檢查 hook 是否存在且符合條件
- 更新您設定中的 `hooks.internal.entries.<name>.enabled = true`
- 將設定儲存到磁碟

**啟用後：**

- 重新啟動 gateway 以重新載入 hooks（macOS 上重新啟動選單列應用程式，或在開發環境中重新啟動您的 gateway 進程）。

## 停用 Hook

```bash
openclaw hooks disable <name>
```

透過更新您的設定來停用特定的 hook。

**參數：**

- `<name>`：Hook 名稱（例如 `command-logger`）

**範例：**

```bash
openclaw hooks disable command-logger
```

**輸出：**

```
⏸ Disabled hook: 📝 command-logger
```

**停用後：**

- 重新啟動 gateway 以重新載入 hooks

## 安裝 Hooks

```bash
openclaw hooks install <path-or-spec>
openclaw hooks install <npm-spec> --pin
```

從本地資料夾/壓縮檔或 npm 安裝 hook 套件。

Npm 規格僅限於 **registry-only**（套件名稱 + 可選的 **精確版本** 或 **dist-tag**）。Git/URL/檔案規格及 semver 範圍皆不被接受。為了安全起見，依賴安裝會使用 `--ignore-scripts` 執行。

裸規格與 `@latest` 保持在穩定版本路線。如果 npm 將其中任一解析為預發行版本，OpenClaw 會停止並要求你明確選擇使用預發行標籤，如 `@beta`/`@rc` 或精確的預發行版本。

**功能說明：**

- 將 hook 套件複製到 `~/.openclaw/hooks/<id>`
- 啟用安裝於 `hooks.internal.entries.*` 的 hooks
- 在 `hooks.internal.installs` 中記錄安裝資訊

**選項：**

- `-l, --link`：連結本地目錄而非複製（會將其加入 `hooks.internal.load.extraDirs`）
- `--pin`：將 npm 安裝記錄為精確解析的 `name@version`，並存於 `hooks.internal.installs`

**支援的壓縮檔格式：** `.zip`、`.tgz`、`.tar.gz`、`.tar`

**範例：**

bash

# 本地目錄

openclaw hooks install ./my-hook-pack

# 本地壓縮檔

openclaw hooks install ./my-hook-pack.zip

# NPM 套件

openclaw hooks install @openclaw/my-hook-pack

# 連結本地目錄且不複製

openclaw hooks install -l ./my-hook-pack

## 更新 Hooks

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

更新已安裝的 hook 套件（僅限 npm 安裝）。

**選項：**

- `--all`：更新所有被追蹤的 hook 套件
- `--dry-run`：顯示將會變更的內容，但不進行寫入

當存在已儲存的完整性雜湊且擷取的 artifact 雜湊發生變化時，
OpenClaw 會顯示警告並在繼續前要求確認。使用全域 `--yes` 可在 CI/非互動式執行時跳過提示。

## 內建 Hooks

### session-memory

當你執行 `/new` 時，會將工作階段上下文儲存到記憶體中。

**啟用：**

```bash
openclaw hooks enable session-memory
```

**輸出：** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**參考：** [session-memory 文件](/automation/hooks#session-memory)

### bootstrap-extra-files

在 `agent:bootstrap` 過程中注入額外的 bootstrap 檔案（例如 monorepo-local `AGENTS.md` / `TOOLS.md`）。

**啟用：**

```bash
openclaw hooks enable bootstrap-extra-files
```

**參考：** [bootstrap-extra-files 文件說明](/automation/hooks#bootstrap-extra-files)

### command-logger

將所有指令事件記錄到集中式稽核檔案中。

**啟用：**

```bash
openclaw hooks enable command-logger
```

**輸出：** `~/.openclaw/logs/commands.log`

**查看日誌：**

bash

# 最近的指令

tail -n 20 ~/.openclaw/logs/commands.log

# 美化輸出

cat ~/.openclaw/logs/commands.log | jq .

# 依動作過濾

grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .

**參考：** [command-logger 文件](/automation/hooks#command-logger)

### boot-md

當閘道器啟動（通道啟動後）時執行 `BOOT.md`。

**事件**: `gateway:startup`

**啟用**:

```bash
openclaw hooks enable boot-md
```

**參考:** [boot-md 文件](/automation/hooks#boot-md)
