---
summary: CLI reference for `openclaw hooks` (agent hooks)
read_when:
  - You want to manage agent hooks
  - You want to install or update hooks
title: hooks
---

# `openclaw hooks`

管理代理鉤子（針對 `/new`、`/reset` 等命令以及網關啟動的事件驅動自動化）。

[[BLOCK_1]]

- Hooks: [Hooks](/automation/hooks)
- 插件鉤子: [Plugins](/tools/plugin#plugin-hooks)

## List All Hooks

```bash
openclaw hooks list
```

列出所有從工作區、管理和捆綁目錄中發現的掛鉤。

**選項：**

- `--eligible`: 僅顯示符合條件的鉤子（滿足要求）
- `--json`: 以 JSON 格式輸出
- `-v, --verbose`: 顯示詳細資訊，包括缺少的要求

**範例輸出：**

Hooks (4/4 已準備好)

Ready:
🚀 boot-md ✓ - 在網關啟動時執行 BOOT.md
📎 bootstrap-extra-files ✓ - 在代理啟動期間注入額外的工作區啟動檔案
📝 command-logger ✓ - 將所有命令事件記錄到集中式審計檔案
💾 session-memory ✓ - 當發出 /new 命令時將會話上下文保存到記憶體中

**範例 (詳細)：**

```bash
openclaw hooks list --verbose
```

顯示不符合資格的鉤子的缺失要求。

**範例 (JSON):**

```bash
openclaw hooks list --json
```

返回結構化的 JSON 以供程式化使用。

## 獲取 Hook 資訊

```bash
openclaw hooks info <name>
```

顯示有關特定 hook 的詳細資訊。

**Arguments:**

- `<name>`: 鉤子名稱（例如，`session-memory`）

**選項：**

- `--json`: 輸出為 JSON

**範例：**

```bash
openclaw hooks info session-memory
```

**Output:**

💾 session-memory ✓ 已準備好

在發出 /new 指令時，將會話上下文儲存到記憶體中。

[[BLOCK_1]]
詳細資訊：
來源：openclaw-bundled
路徑：/path/to/openclaw/hooks/bundled/session-memory/HOOK.md
處理器：/path/to/openclaw/hooks/bundled/session-memory/handler.ts
首頁：https://docs.openclaw.ai/automation/hooks#session-memory
事件：command:new
[[BLOCK_1]]

Requirements:
Config: ✓ workspace.dir

## 檢查 Hooks 資格

```bash
openclaw hooks check
```

顯示鉤子資格狀態的摘要（有多少個已準備好與未準備好）。

**選項：**

- `--json`: 輸出為 JSON

**範例輸出：**

Hooks 狀態

Total hooks: 4  
Ready: 4  
Not ready: 0

## 啟用 Hook

```bash
openclaw hooks enable <name>
```

透過將特定的 hook 添加到您的設定中來啟用它 (`~/.openclaw/config.json`)。

**注意：** 插件管理的 Hooks 在 `plugin:<id>` 中顯示 `openclaw hooks list`，無法在此啟用/禁用。請改為啟用/禁用插件。

**Arguments:**

- `<name>`: 鉤子名稱 (例如，`session-memory`)

**範例：**

```bash
openclaw hooks enable session-memory
```

**Output:**

```
✓ Enabled hook: 💾 session-memory
```

**它的功能：**

- 檢查 hook 是否存在且符合條件
- 更新 `hooks.internal.entries.<name>.enabled = true` 在你的設定中
- 將設定儲存到磁碟

**啟用後：**

- 重新啟動網關以便重新加載鉤子（在 macOS 上重新啟動選單欄應用程式，或在開發環境中重新啟動您的網關進程）。

## 停用一個 Hook

```bash
openclaw hooks disable <name>
```

透過更新您的設定來禁用特定的鉤子。

**Arguments:**

- `<name>`: 鉤子名稱 (例如，`command-logger`)

**範例：**

```bash
openclaw hooks disable command-logger
```

**Output:**

```
⏸ Disabled hook: 📝 command-logger
```

**停用後：**

- 重新啟動網關以便重新加載鉤子

## Install Hooks

```bash
openclaw hooks install <path-or-spec>
openclaw hooks install <npm-spec> --pin
```

從本地資料夾/壓縮檔或 npm 安裝掛鉤包。

Npm 規格是 **僅限於註冊表**（套件名稱 + 可選的 **確切版本** 或 **dist-tag**）。Git/URL/檔案規格和 semver 範圍會被拒絕。依賴安裝以 `--ignore-scripts` 進行，以確保安全。

Bare specs 和 `@latest` 會保持在穩定的路徑上。如果 npm 將其中任何一個解析為預發行版本，OpenClaw 會停止並要求您明確選擇使用預發行標籤，例如 `@beta`/`@rc` 或一個確切的預發行版本。

**它的功能：**

- 將掛鉤包複製到 `~/.openclaw/hooks/<id>`
- 在 `hooks.internal.entries.*` 中啟用已安裝的掛鉤
- 在 `hooks.internal.installs` 下記錄安裝情況

**選項：**

- `-l, --link`: 連結本地目錄而不是複製（將其添加到 `hooks.internal.load.extraDirs`）
- `--pin`: 將 npm 安裝記錄為精確解析的 `name@version` 在 `hooks.internal.installs` 中

**支援的檔案格式：** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**範例：**

bash

# 本地目錄

openclaw hooks install ./my-hook-pack

# 本地檔案

openclaw hooks install ./my-hook-pack.zip

# NPM 套件

openclaw hooks install @openclaw/my-hook-pack

# 連結本地目錄而不進行複製

openclaw hooks install -l ./my-hook-pack

## Update Hooks

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

更新已安裝的掛鉤包（僅限 npm 安裝）。

**選項：**

- `--all`: 更新所有追蹤的掛鉤包
- `--dry-run`: 顯示如果不寫入會發生什麼變更

當存在已儲存的完整性雜湊且擷取的工件雜湊發生變更時，OpenClaw 會印出警告並要求確認後再繼續。使用全域 `--yes` 來在 CI/非互動式執行中跳過提示。

## Bundled Hooks

### session-memory

當你發出 `/new` 時，會將會話上下文儲存到記憶體中。

**Enable:**

```bash
openclaw hooks enable session-memory
```

`~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**參考：** [session-memory 文件](/automation/hooks#session-memory)

### bootstrap-extra-files

在 `agent:bootstrap` 期間注入額外的啟動檔案（例如 monorepo-local `AGENTS.md` / `TOOLS.md`）。

**Enable:**

```bash
openclaw hooks enable bootstrap-extra-files
```

**參考：** [bootstrap-extra-files 文件](/automation/hooks#bootstrap-extra-files)

### command-logger

將所有命令事件記錄到集中式審計檔案中。

**Enable:**

```bash
openclaw hooks enable command-logger
```

`~/.openclaw/logs/commands.log`

**檢視日誌：**

bash

# 最近的指令

tail -n 20 ~/.openclaw/logs/commands.log

# 美化輸出

cat ~/.openclaw/logs/commands.log | jq .

# 根據動作過濾

grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .

**參考：** [command-logger 文件](/automation/hooks#command-logger)

### boot-md

當網關啟動時（在通道啟動後）執行 `BOOT.md`。

**事件**: `gateway:startup`

**Enable**:

```bash
openclaw hooks enable boot-md
```

**參考：** [boot-md 文件](/automation/hooks#boot-md)
