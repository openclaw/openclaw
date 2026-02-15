---
summary: "OpenClaw 的進階設定與開發工作流程"
read_when:
  - 設定新機器時
  - 您希望獲得「最新 + 最棒」的版本，同時不破壞您的個人設定
title: "設定"
---

# 設定

<Note>
如果您是首次設定，請從[入門指南](/start/getting-started)開始。
有關精靈的詳細資訊，請參閱[新手導覽精靈](/start/wizard)。
</Note>

最後更新：2026-01-01

## 總結

- **客製化內容位於儲存庫之外：** `~/.openclaw/workspace`（工作空間）+ `~/.openclaw/openclaw.json`（設定）。
- **穩定工作流程：** 安裝 macOS 應用程式；讓它執行捆綁的 Gateway。
- **搶先體驗工作流程：** 透過 `pnpm gateway:watch`自行執行 Gateway，然後讓 macOS 應用程式以 Local 模式連接。

## 先決條件（從原始碼）

- Node `>=22`
- `pnpm`
- Docker（可選；僅用於容器化設定/端對端測試 — 請參閱 [Docker](/install/docker)）

## 客製化策略（以避免更新造成困擾）

如果您希望「100% 為我客製化」_並且_方便更新，請將您的客製化內容保留在：

- **設定：** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)
- **工作空間：** `~/.openclaw/workspace`（Skills、提示、記憶體；將其設為私人 Git 儲存庫）

首次啟動：

```bash
openclaw setup
```

在此儲存庫內部，使用本機 CLI 入口：

```bash
openclaw setup
```

如果您尚未進行全域安裝，請透過 `pnpm openclaw setup` 執行。

## 從此儲存庫執行 Gateway

在 `pnpm build` 之後，您可以直接執行打包好的 CLI：

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## 穩定工作流程（macOS 應用程式優先）

1. 安裝 + 啟動 **OpenClaw.app**（選單列）。
2. 完成新手導覽/權限檢查清單（TCC 提示）。
3. 確保 Gateway 為 **Local** 模式且正在執行（應用程式會管理它）。
4. 連結介面（例如：WhatsApp）：

```bash
openclaw channels login
```

5. 完整性檢查：

```bash
openclaw health
```

如果您的建置中沒有新手導覽：

- 執行 `openclaw setup`，然後 `openclaw channels login`，再手動啟動 Gateway（`openclaw gateway`）。

## 搶先體驗工作流程（在終端機中執行 Gateway）

目標：在 TypeScript Gateway 上工作，獲得熱重新載入，並保持 macOS 應用程式 UI 連接。

### 0) (可選) 也從原始碼執行 macOS 應用程式

如果您也希望 macOS 應用程式使用搶先體驗版本：

```bash
./scripts/restart-mac.sh
```

### 1) 啟動開發用 Gateway

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` 會在監看模式下執行 Gateway，並在 TypeScript 變更時重新載入。

### 2) 將 macOS 應用程式指向您正在執行的 Gateway

在 **OpenClaw.app** 中：

- 連線模式：**Local**
  應用程式將連接到在配置埠上運行的 Gateway。

### 3) 驗證

- 應用程式內的 Gateway 狀態應顯示 **「使用現有 Gateway …」**
- 或者透過 CLI：

```bash
openclaw health
```

### 常見問題

- **錯誤的埠：** Gateway WS 預設為 `ws://127.0.0.1:18789`；請保持應用程式 + CLI 使用相同的埠。
- **狀態儲存位置：**
  - 憑證：`~/.openclaw/credentials/`
  - 工作階段：`~/.openclaw/agents/<agentId>/sessions/`
  - 日誌：`/tmp/openclaw/`

## 憑證儲存對應表

在偵錯憑證或決定備份哪些內容時使用此對應表：

- **WhatsApp**：`~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram 機器人憑證**：設定/環境變數或 `channels.telegram.tokenFile`
- **Discord 機器人憑證**：設定/環境變數（尚不支援憑證檔案）
- **Slack 憑證**：設定/環境變數（`channels.slack.*`）
- **配對允許清單**：`~/.openclaw/credentials/<channel>-allowFrom.json`
- **模型憑證設定檔**：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **舊版 OAuth 匯入**：`~/.openclaw/credentials/oauth.json`
  更多詳細資訊：[安全性](/gateway/security#credential-storage-map)。

## 更新（不破壞您的設定）

- 將 `~/.openclaw/workspace` 和 `~/.openclaw/` 保留為「您的內容」；請勿將個人提示/設定放入 `openclaw` 儲存庫。
- 更新原始碼：`git pull` + `pnpm install`（當鎖定檔案變更時）+ 繼續使用 `pnpm gateway:watch`。

## Linux (systemd 使用者服務)

Linux 安裝使用 systemd **使用者**服務。依預設，systemd 會在登出/閒置時停止使用者服務，這會終止 Gateway。新手導覽會嘗試為您啟用持續執行（可能會提示您輸入 sudo 密碼）。如果它仍然關閉，請執行：

```bash
sudo loginctl enable-linger $USER
```

對於永遠開啟或多使用者伺服器，請考慮使用**系統**服務而不是使用者服務（無需持續執行）。有關 systemd 筆記，請參閱 [Gateway 操作手冊](/gateway)。

## 相關文件

- [Gateway 操作手冊](/gateway)（旗標、監控、埠）
- [Gateway 設定](/gateway/configuration)（設定綱要 + 範例）
- [Discord](/channels/discord) 和 [Telegram](/channels/telegram)（回覆標籤 + replyToMode 設定）
- [OpenClaw 助理設定](/start/openclaw)
- [macOS 應用程式](/platforms/macos)（Gateway 生命週期）
