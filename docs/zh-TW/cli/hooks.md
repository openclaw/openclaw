---
summary: "CLI reference for `openclaw hooks` (智慧代理 hooks)"
read_when:
  - 您想管理智慧代理 hooks
  - 您想安裝或更新 hooks
title: "hooks"
---

# `openclaw hooks`

管理智慧代理 hooks（用於 `/new`、`/reset` 等指令以及 Gateway 啟動的事件驅動自動化）。

相關資訊：

- Hooks: [Hooks](/automation/hooks)
- 外掛程式 hooks: [外掛程式](/tools/plugin#plugin-hooks)

## 列出所有 Hooks

```bash
openclaw hooks list
```

列出從 workspace、受管理和捆綁目錄中發現的所有 hooks。

**選項：**

- `--eligible`: 僅顯示符合資格的 hooks（要求已滿足）
- `--json`: 以 JSON 格式輸出
- `-v, --verbose`: 顯示詳細資訊，包括遺失的要求

**範例輸出：**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📎 bootstrap-extra-files ✓ - Inject extra workspace bootstrap files during agent bootstrap
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
```

**範例（詳細）：**

```bash
openclaw hooks list --verbose
```

顯示不符合資格 hooks 的遺失要求。

**範例（JSON）：**

```bash
openclaw hooks list --json
```

傳回結構化的 JSON，供程式使用。

## 取得 Hook 資訊

```bash
openclaw hooks info <name>
```

顯示特定 hook 的詳細資訊。

**參數：**

- `<name>`: Hook 名稱（例如：`session-memory`）

**選項：**

- `--json`: 以 JSON 格式輸出

**範例：**

```bash
openclaw hooks info session-memory
```

**輸出：**

```
💾 session-memory ✓ Ready

Save session context to memory when /new command is issued

Details:
  Source: openclaw-bundled
  Path: /path/to/openclaw/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/openclaw/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.openclaw.ai/hooks#session-memory
  Events: command:new

Requirements:
  Config: ✓ workspace.dir
```

## 檢查 Hooks 資格

```bash
openclaw hooks check
```

顯示 hook 資格狀態的摘要（有多少已就緒與未就緒）。

**選項：**

- `--json`: 以 JSON 格式輸出

**範例輸出：**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## 啟用 Hook

```bash
openclaw hooks enable <name>
```

透過將特定 hook 新增至您的設定 (`~/.openclaw/config.json`) 來啟用它。

**請注意：** 由外掛程式管理的 hooks 會在 `openclaw hooks list` 中顯示 `plugin:<id>`，
且無法在此處啟用/停用。請改為啟用/停用該外掛程式。

**參數：**

- `<name>`: Hook 名稱（例如：`session-memory`）

**範例：**

```bash
openclaw hooks enable session-memory
```

**輸出：**

```
✓ Enabled hook: 💾 session-memory
```

**功能：**

- 檢查 hook 是否存在且符合資格
- 更新您設定中的 `hooks.internal.entries.<name>.enabled = true`
- 將設定儲存到磁碟

**啟用後：**

- 重新啟動 Gateway 以重新載入 hooks (macOS 上的選單列應用程式重新啟動，或在開發中重新啟動您的 Gateway 程式)。

## 停用 Hook

```bash
openclaw hooks disable <name>
```

透過更新您的設定來停用特定 hook。

**參數：**

- `<name>`: Hook 名稱（例如：`command-logger`）

**範例：**

```bash
openclaw hooks disable command-logger
```

**輸出：**

```
⏸ Disabled hook: 📝 command-logger
```

**停用後：**

- 重新啟動 Gateway 以重新載入 hooks

## 安裝 Hooks

```bash
openclaw hooks install <path-or-spec>
```

從本機資料夾/壓縮檔或 npm 安裝 hook 套件。

**功能：**

- 將 hook 套件複製到 `~/.openclaw/hooks/<id>`
- 在 `hooks.internal.entries.*` 中啟用已安裝的 hooks
- 將安裝記錄在 `hooks.internal.installs` 下

**選項：**

- `-l, --link`: 連結本機目錄而不是複製（將其新增至 `hooks.internal.load.extraDirs`）

**支援的壓縮檔：** `.zip`、`.tgz`、`.tar.gz`、`.tar`

**範例：**

```bash
# 本機目錄
openclaw hooks install ./my-hook-pack

# 本機壓縮檔
openclaw hooks install ./my-hook-pack.zip

# NPM 套件
openclaw hooks install @openclaw/my-hook-pack

# 連結本機目錄而不複製
openclaw hooks install -l ./my-hook-pack
```

## 更新 Hooks

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

更新已安裝的 hook 套件（僅限 npm 安裝）。

**選項：**

- `--all`: 更新所有追蹤的 hook 套件
- `--dry-run`: 顯示將會變更的內容而不寫入

## 捆綁 Hooks

### session-memory

當您發出 `/new` 時，將工作階段內容儲存到記憶體中。

**啟用：**

```bash
openclaw hooks enable session-memory
```

**輸出：** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**請參閱：** [session-memory 文件](/automation/hooks#session-memory)

### bootstrap-extra-files

在 `agent:bootstrap` 期間注入額外的 bootstrap 檔案（例如單一儲存庫的本機 `AGENTS.md` / `TOOLS.md`）。

**啟用：**

```bash
openclaw hooks enable bootstrap-extra-files
```

**請參閱：** [bootstrap-extra-files 文件](/automation/hooks#bootstrap-extra-files)

### command-logger

將所有指令事件記錄到集中的稽核檔案。

**啟用：**

```bash
openclaw hooks enable command-logger
```

**輸出：** `~/.openclaw/logs/commands.log`

**檢視記錄：**

```bash
# 最近的指令
tail -n 20 ~/.openclaw/logs/commands.log

# 美化列印
cat ~/.openclaw/logs/commands.log | jq .

# 依動作篩選
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**請參閱：** [command-logger 文件](/automation/hooks#command-logger)

### boot-md

當 Gateway 啟動時（在頻道啟動之後）執行 `BOOT.md`。

**事件**：`gateway:startup`

**啟用**：

```bash
openclaw hooks enable boot-md
```

**請參閱：** [boot-md 文件](/automation/hooks#boot-md)
