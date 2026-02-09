---
summary: "OpenClaw 的進階設定與開發工作流程"
read_when:
  - 設定新機器時
  - 想要「最新 + 最強」但不破壞你的個人設定
title: "設定"
---

# 設定

<Note>
如果你是第一次設定，請從 [Getting Started](/start/getting-started) 開始。
如需精靈的詳細資訊，請參閱 [Onboarding Wizard](/start/wizard)。
</Note>

最後更新：2026-01-01

## TL;DR

- **客製化放在儲存庫之外：** `~/.openclaw/workspace`（workspace）+ `~/.openclaw/openclaw.json`（config）。
- **穩定工作流程：** 安裝 macOS 應用程式；讓它執行內建的 Gateway 閘道器。
- **前沿工作流程：** 透過 `pnpm gateway:watch` 自行執行 Gateway 閘道器，然後讓 macOS 應用程式以 Local 模式附加。

## 先決條件（來自原始碼）

- Node `>=22`
- `pnpm`
- Docker（選用；僅用於容器化設定／端到端測試 — 請參見 [Docker](/install/docker)）

## 客製化策略（讓更新不會傷到你）

如果你想要「100% 依照我」_同時_ 又能輕鬆更新，請把你的客製化放在：

- **Config：** `~/.openclaw/openclaw.json`（JSON／類 JSON5）
- **Workspace：** `~/.openclaw/workspace`（skills、prompts、memories；建議做成私有 git 儲存庫）

只需 bootstrap 一次：

```bash
openclaw setup
```

在此儲存庫內，使用本地 CLI 入口：

```bash
openclaw setup
```

如果你尚未有全域安裝，請透過 `pnpm openclaw setup` 執行。

## 39. 從此 repo 執行 Gateway

在 `pnpm build` 之後，你可以直接執行封裝好的 CLI：

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## 穩定工作流程（macOS 應用程式優先）

1. 安裝並啟動 **OpenClaw.app**（選單列）。
2. 完成入門引導／權限檢查清單（TCC 提示）。
3. 確認 Gateway 為 **Local** 且正在執行（由應用程式管理）。
4. 連結介面（範例：WhatsApp）：

```bash
openclaw channels login
```

5. 基本健全性檢查：

```bash
openclaw health
```

如果你的版本沒有提供入門引導：

- 執行 `openclaw setup`，接著 `openclaw channels login`，然後手動啟動 Gateway（`openclaw gateway`）。

## 前沿工作流程（在終端機中執行 Gateway）

目標：開發 TypeScript Gateway、取得熱重載，同時保持 macOS 應用程式 UI 已附加。

### 0)（選用）也從原始碼執行 macOS 應用程式

如果你也想讓 macOS 應用程式保持在前沿版本：

```bash
./scripts/restart-mac.sh
```

### 1. 啟動開發用 Gateway

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` 會以 watch 模式執行 gateway，並在 TypeScript 變更時重新載入。

### 2. 讓 macOS 應用程式指向你正在執行的 Gateway

在 **OpenClaw.app** 中：

- 連線模式：**Local**
  應用程式會附加到設定連接埠上的執行中 gateway。

### 3. 驗證

- 應用程式內的 Gateway 狀態應顯示 **「Using existing gateway …」**
- 或透過 CLI：

```bash
openclaw health
```

### 常見陷阱

- **錯誤的連接埠：** Gateway WS 預設為 `ws://127.0.0.1:18789`；請確保應用程式與 CLI 使用相同的連接埠。
- **狀態儲存位置：**
  - 憑證：`~/.openclaw/credentials/`
  - 工作階段：`~/.openclaw/agents/<agentId>/sessions/`
  - 記錄：`/tmp/openclaw/`

## 憑證儲存對照表

在除錯驗證或決定要備份哪些項目時使用：

- **WhatsApp**：`~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram 機器人權杖**：config／env 或 `channels.telegram.tokenFile`
- **Discord 機器人 token**：config/env（尚未支援 token 檔案）
- **Slack 權杖**：config／env（`channels.slack.*`）
- **配對允許清單**：`~/.openclaw/credentials/<channel>-allowFrom.json`
- **模型身分驗證設定檔**：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **舊版 OAuth 匯入**：`~/.openclaw/credentials/oauth.json`
  更多細節：[安全性](/gateway/security#credential-storage-map)。

## 更新（不破壞你的設定）

- 將 `~/.openclaw/workspace` 與 `~/.openclaw/` 視為「你的東西」；不要把個人 prompts／config 放進 `openclaw` 儲存庫。
- 更新原始碼：`git pull` + `pnpm install`（當 lockfile 變更時）+ 持續使用 `pnpm gateway:watch`。

## Linux（systemd 使用者服務）

Linux installs use a systemd **user** service. 預設情況下，systemd 會在登出/閒置時停止使用者
服務，這會終止 Gateway。 新手引導會嘗試為你啟用
lingering（可能會要求 sudo）。 47. 如果仍然未啟用，請執行：

```bash
sudo loginctl enable-linger $USER
```

對於需要常駐或多使用者的伺服器，請考慮使用 **系統**服務而非
使用者服務（不需要 lingering）。請參閱 [Gateway runbook](/gateway) 的 systemd 說明。 48. 有關 systemd 的說明，請參閱 [Gateway runbook](/gateway)。

## 49. 相關文件

- [Gateway runbook](/gateway)（旗標、監管、連接埠）
- [Gateway configuration](/gateway/configuration)（設定結構描述 + 範例）
- [Discord](/channels/discord) 與 [Telegram](/channels/telegram)（回覆標籤 + replyToMode 設定）
- [OpenClaw assistant setup](/start/openclaw)
- [macOS app](/platforms/macos)（gateway 生命週期）
