---
summary: "OpenClaw 的進階設定與開發工作流程"
read_when:
  - 設定新機器時
  - 想要在不破壞個人設定的情況下體驗「最新且最強大」的功能
title: "設定"
---

# 設定

<Note>
如果您是第一次設定，請從 [入門指南](/start/getting-started) 開始。
有關精靈的詳細資訊，請參閱 [新手導覽精靈](/start/wizard)。
</Note>

最後更新日期：2026-01-01

## 重點摘要

- **自訂內容儲存在儲存庫之外：** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (設定)。
- **穩定版工作流程：** 安裝 macOS 應用程式；讓它執行內建的 Gateway。
- **開發版（Bleeding edge）工作流程：** 透過 `pnpm gateway:watch` 自行執行 Gateway，然後讓 macOS 應用程式以 Local 模式連線。

## 前置作業（從原始碼編譯）

- Node `>=22`
- `pnpm`
- Docker（選用；僅用於容器化設定/e2e — 請參閱 [Docker](/install/docker)）

## 自訂策略（確保更新時不受影響）

如果您想要「完全符合個人需求」且能輕鬆更新，請將您的自訂內容保留在：

- **設定：** `~/.openclaw/openclaw.json` (JSON/JSON5 格式)
- **工作空間：** `~/.openclaw/workspace`（Skills、提示詞、記憶；建議將其設為私有 git 儲存庫）

執行一次初始化設定：

```bash
openclaw setup
```

在此儲存庫內部，使用本地 CLI 入口點：

```bash
openclaw setup
```

如果您尚未安裝全域版本，請透過 `pnpm openclaw setup` 執行。

## 從此儲存庫執行 Gateway

執行 `pnpm build` 後，您可以直接執行封裝好的 CLI：

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## 穩定版工作流程（以 macOS 應用程式優先）

1. 安裝並啟動 **OpenClaw.app**（選單列）。
2. 完成新手導覽/權限檢查清單（TCC 提示）。
3. 確保 Gateway 處於 **Local** 模式且正在執行（由應用程式管理）。
4. 連結平台（例如：WhatsApp）：

```bash
openclaw channels login
```

5. 完整性檢查：

```bash
openclaw health
```

如果您的版本中沒有新手導覽功能：

- 請執行 `openclaw setup`，接著執行 `openclaw channels login`，最後手動啟動 Gateway (`openclaw gateway`)。

## 開發版工作流程（在終端機中執行 Gateway）

目標：開發 TypeScript Gateway、獲得熱重載功能，並保持 macOS 應用程式介面的連線。

### 0)（選用）同樣從原始碼執行 macOS 應用程式

如果您也想使用開發版的 macOS 應用程式：

```bash
./scripts/restart-mac.sh
```

### 1) 啟動開發版 Gateway

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` 會在監看模式下執行 Gateway，並在 TypeScript 程式碼變更時重新載入。

### 2) 將 macOS 應用程式指向正在執行的 Gateway

在 **OpenClaw.app** 中：

- 連線模式：**Local**
  應用程式將連線至已設定連接埠上執行中的 Gateway。

### 3) 驗證

- 應用程式內的 Gateway 狀態應顯示 **「Using existing gateway …」（使用現有的 Gateway...）**
- 或透過 CLI：

```bash
openclaw health
```

### 常見問題（陷阱）

- **連接埠錯誤：** Gateway WS 預設為 `ws://127.0.0.1:18789`；請確保應用程式與 CLI 使用相同的連接埠。
- **狀態儲存位置：**
  - 憑證：`~/.openclaw/credentials/`
  - 工作階段：`~/.openclaw/agents/<agentId>/sessions/`
  - 記錄檔：`/tmp/openclaw/`

## 憑證儲存對照表

在偵錯驗證或決定要備份哪些內容時使用：

- **WhatsApp**：`~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**：設定/環境變數或 `channels.telegram.tokenFile`
- **Discord bot token**：設定/環境變數（尚未支援 token 檔案）
- **Slack tokens**：設定/環境變數 (`channels.slack.*`)
- **配對白名單**：`~/.openclaw/credentials/<channel>-allowFrom.json`
- **模型驗證設定檔**：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **舊版 OAuth 匯入**：`~/.openclaw/credentials/oauth.json`
  更多細節請參閱：[安全性](/gateway/security#credential-storage-map)。

## 更新（且不破壞您的設定）

- 將 `~/.openclaw/workspace` 和 `~/.openclaw/` 保留為「您的個人資料」；不要將個人提示詞/設定放入 `openclaw` 儲存庫中。
- 更新原始碼：`git pull` + `pnpm install`（當 lockfile 變更時）+ 繼續使用 `pnpm gateway:watch`。

## Linux (systemd 使用者服務)

Linux 安裝程式使用 systemd **使用者（user）** 服務。預設情況下，systemd 會在登出/閒置時停止使用者服務，這會導致 Gateway 終止。新手導覽會嘗試為您啟用持久執行（lingering）（可能會提示輸入 sudo 密碼）。如果仍然關閉，請執行：

```bash
sudo loginctl enable-linger $USER
```

對於需要恆常啟動或多使用者的伺服器，請考慮使用 **系統（system）** 服務而非使用者服務（不需要啟用 lingering）。請參閱 [Gateway 執行指南](/gateway) 以了解 systemd 的相關說明。

## 相關文件

- [Gateway 執行指南](/gateway)（旗標、監控、連接埠）
- [Gateway 設定](/gateway/configuration)（設定結構 + 範例）
- [Discord](/channels/discord) 和 [Telegram](/channels/telegram)（回覆標籤 + replyToMode 設定）
- [OpenClaw 助理設定](/start/openclaw)
- [macOS 應用程式](/platforms/macos)（Gateway 生命週期）
