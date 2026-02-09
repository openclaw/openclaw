---
summary: "用於 `openclaw hooks` 的 CLI 參考（代理程式 hooks）"
read_when:
  - 你想要管理代理程式 hooks
  - 你想要安裝或更新 hooks
title: "hooks"
---

# `openclaw hooks`

管理代理程式 hooks（針對如 `/new`、`/reset` 等指令以及 Gateway 啟動時的事件驅動自動化）。

Related:

- Hooks：[Hooks](/automation/hooks)
- Plugin hooks：[Plugins](/tools/plugin#plugin-hooks)

## 列出所有 Hooks

```bash
openclaw hooks list
```

列出從工作區、受管理目錄以及內建目錄中探索到的所有 hooks。

**選項：**

- `--eligible`：僅顯示符合資格的 hooks（需求已滿足）
- `--json`：以 JSON 輸出
- `-v, --verbose`：顯示包含缺失需求在內的詳細資訊

**範例輸出：**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
  😈 soul-evil ✓ - Swap injected SOUL content during a purge window or by random chance
```

**範例（詳細）：**

```bash
openclaw hooks list --verbose
```

顯示不符合資格之 hooks 的缺失需求。

**範例（JSON）：**

```bash
openclaw hooks list --json
```

Returns structured JSON for programmatic use.

## 取得 Hook 資訊

```bash
openclaw hooks info <name>
```

顯示特定 hook 的詳細資訊。

**引數：**

- `<name>`：Hook 名稱（例如：`session-memory`）

**選項：**

- `--json`：以 JSON 輸出

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

## 檢查 Hooks 資格狀態

```bash
openclaw hooks check
```

Show summary of hook eligibility status (how many are ready vs. not ready).

**選項：**

- `--json`：以 JSON 輸出

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

透過將其加入你的設定（`~/.openclaw/config.json`）來啟用特定 hook。

**注意：** 由插件管理的 hooks 會在 `openclaw hooks list` 中顯示 `plugin:<id>`，
且無法在此啟用或停用。請改為啟用／停用對應的插件。 Enable/disable the plugin instead.

**引數：**

- `<name>`：Hook 名稱（例如：`session-memory`）

**範例：**

```bash
openclaw hooks enable session-memory
```

**輸出：**

```
✓ Enabled hook: 💾 session-memory
```

**What it does:**

- 檢查 hook 是否存在且符合資格
- 更新你設定中的 `hooks.internal.entries.<name>.enabled = true`
- 將設定儲存至磁碟

**啟用後：**

- 重新啟動 Gateway，讓 hooks 重新載入（macOS 上重新啟動選單列應用程式，或在開發環境中重新啟動你的 Gateway 程序）。

## 停用 Hook

```bash
openclaw hooks disable <name>
```

透過更新你的設定來停用特定 hook。

**引數：**

- `<name>`：Hook 名稱（例如：`command-logger`）

**範例：**

```bash
openclaw hooks disable command-logger
```

**輸出：**

```
⏸ Disabled hook: 📝 command-logger
```

**停用後：**

- 重新啟動 Gateway，讓 hooks 重新載入

## 安裝 Hooks

```bash
openclaw hooks install <path-or-spec>
```

從本機資料夾／封存檔或 npm 安裝 hook 套件。

**What it does:**

- 將 hook 套件複製到 `~/.openclaw/hooks/<id>`
- 在 `hooks.internal.entries.*` 中啟用已安裝的 hooks
- 在 `hooks.internal.installs` 下記錄此次安裝

**選項：**

- `-l, --link`：連結本機目錄而非複製（將其加入 `hooks.internal.load.extraDirs`）

**支援的封存格式：** `.zip`、`.tgz`、`.tar.gz`、`.tar`

**範例：**

```bash
# Local directory
openclaw hooks install ./my-hook-pack

# Local archive
openclaw hooks install ./my-hook-pack.zip

# NPM package
openclaw hooks install @openclaw/my-hook-pack

# Link a local directory without copying
openclaw hooks install -l ./my-hook-pack
```

## 更新 Hooks

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

Update installed hook packs (npm installs only).

**選項：**

- `--all`：更新所有已追蹤的 hook 套件
- `--dry-run`：顯示將會變更的內容但不實際寫入

## 內建 Hooks

### session-memory

Saves session context to memory when you issue `/new`.

**啟用：**

```bash
openclaw hooks enable session-memory
```

**輸出：** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**參閱：** [session-memory 文件](/automation/hooks#session-memory)

### command-logger

將所有指令事件記錄到集中式稽核檔案。

**啟用：**

```bash
openclaw hooks enable command-logger
```

**輸出：** `~/.openclaw/logs/commands.log`

**檢視紀錄：**

```bash
# Recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**參閱：** [command-logger 文件](/automation/hooks#command-logger)

### soul-evil

在清除視窗期間或依隨機機率，將注入的 `SOUL.md` 內容替換為 `SOUL_EVIL.md`。

**啟用：**

```bash
openclaw hooks enable soul-evil
```

**參閱：** [SOUL Evil Hook](/hooks/soul-evil)

### boot-md

在 Gateway 啟動時（頻道啟動之後）執行 `BOOT.md`。

**事件**：`gateway:startup`

**啟用**：

```bash
openclaw hooks enable boot-md
```

**參閱：** [boot-md 文件](/automation/hooks#boot-md)
