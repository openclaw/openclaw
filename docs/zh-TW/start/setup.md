---
summary: Advanced setup and development workflows for OpenClaw
read_when:
  - Setting up a new machine
  - You want “latest + greatest” without breaking your personal setup
title: Setup
---

# 設定說明

<Note>
如果您是第一次設定，請從 [快速入門](/start/getting-started) 開始。
關於精靈詳細資訊，請參考 [啟動精靈](/start/wizard)。
</Note>

最後更新日期：2026-01-01

## 簡要說明

- **個人化設定存放於倉庫外：** `~/.openclaw/workspace`（工作區）+ `~/.openclaw/openclaw.json`（設定檔）。
- **穩定工作流程：** 安裝 macOS 應用程式；讓它執行內建的 Gateway。
- **最新功能工作流程：** 透過 `pnpm gateway:watch` 自行執行 Gateway，然後讓 macOS 應用程式以本機模式附加。

## 先決條件（從原始碼）

- Node `>=22`
- `pnpm`
- Docker（選用；僅用於容器化設定或端對端測試 — 請參考 [Docker](/install/docker)）

## 個人化策略（避免更新造成困擾）

如果您想要「100% 專屬於我」且方便更新，請將自訂內容保留在：

- **設定檔：** `~/.openclaw/openclaw.json`（JSON/類 JSON5 格式）
- **工作區：** `~/.openclaw/workspace`（技能、提示、記憶；建議設為私人 git 倉庫）

初始化一次：

```bash
openclaw setup
```

在此倉庫內，使用本地 CLI 入口：

```bash
openclaw setup
```

如果您尚未全域安裝，請透過 `pnpm openclaw setup` 執行。

## 從此倉庫執行 Gateway

在 `pnpm build` 之後，你可以直接執行已打包的 CLI：

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## 穩定工作流程（macOS 應用優先）

1. 安裝並啟動 **OpenClaw.app**（選單列）。
2. 完成新手引導／權限清單（TCC 提示）。
3. 確認 Gateway 是 **本地** 且正在執行（由應用程式管理）。
4. 連結介面（範例：WhatsApp）：

```bash
openclaw channels login
```

5. 健全性檢查：

```bash
openclaw health
```

如果你的版本沒有新手引導：

- 執行 `openclaw setup`，接著 `openclaw channels login`，然後手動啟動 Gateway（`openclaw gateway`）。

## 最新開發流程（在終端機執行 Gateway）

目標：開發 TypeScript Gateway，實現熱重載，並保持 macOS 應用 UI 連接。

### 0) （可選）也從原始碼執行 macOS 應用

如果你也想要 macOS 應用保持最新開發狀態：

```bash
./scripts/restart-mac.sh
```

### 1) 啟動開發 Gateway

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` 以監看模式執行 Gateway，並在 TypeScript 變更時重新載入。

### 2) 將 macOS 應用程式指向你正在執行的 Gateway

在 **OpenClaw.app** 中：

- 連線模式：**本機**
  應用程式會連接到設定埠號上正在執行的 Gateway。

### 3) 驗證

- 應用程式內的 Gateway 狀態應顯示 **「使用現有的 gateway …」**
- 或透過 CLI：

```bash
openclaw health
```

### 常見錯誤陷阱

- **錯誤的埠號：** Gateway 的 WS 預設為 `ws://127.0.0.1:18789`；請確保應用程式與 CLI 使用相同埠號。
- **狀態存放位置：**
  - 憑證：`~/.openclaw/credentials/`
  - 會話：`~/.openclaw/agents/<agentId>/sessions/`
  - 日誌：`/tmp/openclaw/`

## 憑證存放對照表

用於除錯認證或決定備份內容時參考：

- **WhatsApp**：`~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram 機器人 token**：config/env 或 `channels.telegram.tokenFile`（僅限一般檔案；不接受符號連結）
- **Discord 機器人 token**：config/env 或 SecretRef（env/file/exec 提供者）
- **Slack token**：config/env（`channels.slack.*`）
- **配對允許清單**：
  - `~/.openclaw/credentials/<channel>-allowFrom.json`（預設帳號）
  - `~/.openclaw/credentials/<channel>-<accountId>-allowFrom.json`（非預設帳號）
- **模型認證設定檔**：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **檔案備份的秘密資料載體（選用）**：`~/.openclaw/secrets.json`
- **舊版 OAuth 匯入**：`~/.openclaw/credentials/oauth.json`
  詳細資訊請參考：[安全性](/gateway/security#credential-storage-map)。

## 更新（不破壞你的設定）

- 保持 `~/.openclaw/workspace` 和 `~/.openclaw/` 為「你的東西」；不要將個人提示/設定放入 `openclaw` 倉庫。
- 更新來源：`git pull` + `pnpm install`（當 lockfile 有變更時）+ 持續使用 `pnpm gateway:watch`。

## Linux（systemd 使用者服務）

Linux 安裝使用 systemd 的 **使用者** 服務。預設情況下，systemd 在登出或閒置時會停止使用者服務，這會導致 Gateway 被終止。安裝過程會嘗試為你啟用 lingering（可能會提示輸入 sudo 密碼）。如果仍未啟用，請執行：

```bash
sudo loginctl enable-linger $USER
```

對於需要持續運作或多使用者的伺服器，建議使用 **系統** 服務而非使用者服務（不需要 lingering）。請參考 [Gateway 執行手冊](/gateway) 中的 systemd 相關說明。

## 相關文件

- [Gateway 執行手冊](/gateway)（旗標、監控、埠號）
- [Gateway 設定](/gateway/configuration)（設定架構與範例）
- [Discord](/channels/discord) 與 [Telegram](/channels/telegram)（回覆標籤與 replyToMode 設定）
- [OpenClaw 助手設定](/start/openclaw)
- [macOS 應用程式](/platforms/macos)（gateway 生命週期）
