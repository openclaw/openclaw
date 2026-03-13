---
summary: Move (migrate) a OpenClaw install from one machine to another
read_when:
  - You are moving OpenClaw to a new laptop/server
  - "You want to preserve sessions, auth, and channel logins (WhatsApp, etc.)"
title: Migration Guide
---

# 將 OpenClaw 遷移到新機器

本指南說明如何將 OpenClaw Gateway 從一台機器遷移到另一台機器，**無需重新進行上線設定**。

遷移的概念很簡單：

- 複製 **state 目錄** (`$OPENCLAW_STATE_DIR`，預設為 `~/.openclaw/`) — 包含設定、認證、會話及頻道狀態。
- 複製你的 **workspace**（預設為 `~/.openclaw/workspace/`）— 包含你的代理檔案（記憶、提示等）。

但在處理 **profile**、**權限** 和 **部分複製** 時，常會遇到陷阱。

## 開始前（你要遷移的內容）

### 1) 確認你的 state 目錄

大多數安裝會使用預設值：

- **State 目錄：** `~/.openclaw/`

但如果你使用以下方式，可能會不同：

- `--profile <name>`（通常會變成 `~/.openclaw-<profile>/`）
- `OPENCLAW_STATE_DIR=/some/path`

如果不確定，請在**舊機器**上執行：

```bash
openclaw status
```

在輸出中尋找 `OPENCLAW_STATE_DIR` / profile 的相關資訊。如果你執行多個 gateway，請對每個 profile 重複此步驟。

### 2) 確認你的 workspace

常見預設值：

- `~/.openclaw/workspace/`（推薦的工作區）
- 你自行建立的自訂資料夾

你的工作區是存放像 `MEMORY.md`、`USER.md` 和 `memory/*.md` 這類檔案的地方。

### 3) 了解你將會保留的內容

如果你同時複製狀態目錄和工作區，你將保留：

- Gateway 設定 (`openclaw.json`)
- 認證設定檔 / API 金鑰 / OAuth token
- 會話歷史與代理狀態
- 通道狀態（例如 WhatsApp 登入/會話）
- 你的工作區檔案（記憶、技能筆記等）

如果你只複製工作區（例如透過 Git），你將**不會**保留：

- 會話
- 認證資料
- 通道登入資訊

這些資料都存放在 `$OPENCLAW_STATE_DIR` 底下。

## 遷移步驟（推薦）

### 步驟 0 — 備份（舊機器）

在**舊機器**上，先停止 gateway，避免複製過程中檔案變動：

```bash
openclaw gateway stop
```

（可選但推薦）將狀態目錄和工作區打包備份：

bash

# 如果你使用 profile 或自訂路徑，請調整路徑

cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace

如果你有多個設定檔/狀態目錄（例如 `~/.openclaw-main`、`~/.openclaw-work`），請分別打包。

### 第一步 — 在新機器上安裝 OpenClaw

在**新**機器上，安裝 CLI（以及需要的話安裝 Node）：

- 參考：[安裝](/install)

此階段，如果 onboarding 建立了新的 `~/.openclaw/` 也沒關係 — 你會在下一步覆蓋它。

### 第二步 — 將狀態目錄和工作區複製到新機器

請同時複製：

- `$OPENCLAW_STATE_DIR`（預設為 `~/.openclaw/`）
- 你的工作區（預設為 `~/.openclaw/workspace/`）

常見做法：

- `scp` 壓縮包並解壓
- 透過 SSH `rsync -a`
- 外接硬碟

複製後，請確認：

- 隱藏目錄有包含在內（例如 `.openclaw/`）
- 檔案擁有權對執行 gateway 的使用者是正確的

### 第三步 — 執行 Doctor（遷移與服務修復）

在**新**機器上：

```bash
openclaw doctor
```

Doctor 是「安全無趣」的指令。它會修復服務、套用設定遷移，並警告不匹配的情況。

然後：

```bash
openclaw gateway restart
openclaw status
```

## 常見陷阱（以及如何避免）

### 陷阱：profile / state-dir 不匹配

如果你用舊的 gateway 搭配某個 profile（或 `OPENCLAW_STATE_DIR`）執行，而新的 gateway 使用不同的，會出現以下症狀：

- 設定變更沒有生效
- 頻道消失／登出
- 空的會話歷史

解決方法：使用你遷移時**相同**的 profile/state 目錄來執行 gateway/service，然後重新執行：

```bash
openclaw doctor
```

### 陷阱：只複製 `openclaw.json`

`openclaw.json` 不夠。許多提供者會將狀態存放在：

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

務必遷移整個 `$OPENCLAW_STATE_DIR` 資料夾。

### 陷阱：權限／擁有者設定

如果你是以 root 身份複製或切換使用者，gateway 可能無法讀取憑證/會話。

解決方法：確保 state 目錄和工作區的擁有者是執行 gateway 的使用者。

### 風險提示：在遠端/本地模式間遷移

- 如果你的 UI（WebUI/TUI）指向 **遠端** gateway，遠端主機擁有會話存儲和工作區。
- 遷移你的筆電不會移動遠端 gateway 的狀態。

如果你處於遠端模式，請遷移 **gateway 主機**。

### 風險提示：備份中的機密資訊

`$OPENCLAW_STATE_DIR` 包含機密資訊（API 金鑰、OAuth token、WhatsApp 憑證）。請將備份視為生產環境的機密資料：

- 以加密方式儲存
- 避免透過不安全的管道分享
- 若懷疑外洩，請立即更換金鑰

## 驗證清單

在新機器上確認：

- `openclaw status` 顯示 gateway 正在執行
- 你的頻道仍然連線（例如 WhatsApp 不需重新配對）
- 儀表板能開啟並顯示現有會話
- 你的工作區檔案（記憶體、設定）存在

## 相關連結

- [診斷工具](/gateway/doctor)
- [Gateway 疑難排解](/gateway/troubleshooting)
- [OpenClaw 的資料存放位置？](/help/faq#where-does-openclaw-store-its-data)
