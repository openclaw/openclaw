---
summary: "安全更新 OpenClaw (全球安裝或從源碼安裝)，以及回溯策略"
read_when:
  - 更新 OpenClaw
  - 更新後出現問題
title: "更新"
---

# 更新

OpenClaw 正在快速發展（預「1.0」版本）。請將更新視為基礎設施交付：更新 → 執行檢查 → 重新啟動（或使用 `openclaw update`，它會重新啟動） → 驗證。

## 建議：重新執行網站安裝程式（原地升級）

**首選**的更新路徑是重新執行網站上的安裝程式。它會偵測現有的安裝、原地升級，並在需要時執行 `openclaw doctor`。

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

備註：

- 如果您不想再次執行新手導覽精靈，請新增 `--no-onboard`。
- 對於**從源碼安裝**，請使用：

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  安裝程式只會在儲存庫是乾淨的情況下執行 `git pull --rebase`。

- 對於**全球安裝**，此腳本在底層使用 `npm install -g openclaw @latest`。
- 舊版備註：`clawdbot` 仍可作為相容性 shim 使用。

## 更新之前

- 了解您的安裝方式：**全球安裝** (npm/pnpm) 或**從源碼安裝** (git clone)。
- 了解您的 Gateway 的執行方式：**前景終端機** 或 **受監督的服務** (launchd/systemd)。
- 建立您客製化設定的快照：
  - 設定：`~/.openclaw/openclaw.json`
  - 憑證：`~/.openclaw/credentials/`
  - 工作區：`~/.openclaw/workspace`

## 更新（全球安裝）

全球安裝（選擇一個）：

```bash
npm i -g openclaw @skills/stock-analysis/cache/hot_scan_latest.json
```

```bash
pnpm add -g openclaw @skills/stock-analysis/cache/hot_scan_latest.json
```

我們**不**建議使用 Bun 作為 Gateway 運行時（WhatsApp/Telegram 錯誤）。

要切換更新頻道 (git + npm 安裝)：

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

使用 `--tag <dist-tag|version>` 進行一次性安裝標籤/版本。

請參閱 [開發頻道](/install/development-channels) 以了解頻道語義和發行說明。

備註：在 npm 安裝中，Gateway 在啟動時會記錄更新提示（檢查當前頻道標籤）。可透過 `update.checkOnStart: false` 停用。

然後：

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

備註：

- 如果您的 Gateway 作為服務執行，`openclaw gateway restart` 比終止 PID 更受推薦。
- 如果您固定在特定版本，請參閱下面的「回溯 / 固定版本」。

## 更新 (`openclaw update`)

對於**從源碼安裝** (git checkout)，首選：

```bash
openclaw update
```

它會執行一個相對安全的更新流程：

- 需要一個乾淨的工作樹。
- 切換到選定的頻道（標籤或分支）。
- 取得並重新建立與配置上游 (dev 頻道) 的基礎。
- 安裝依賴項、建置、建置 Control UI，並執行 `openclaw doctor`。
- 預設重新啟動 Gateway（使用 `--no-restart` 跳過）。

如果您是透過 **npm/pnpm** 安裝（沒有 git 中繼資料），`openclaw update` 將嘗試透過您的套件管理器進行更新。如果它無法偵測到安裝，請改用「更新（全球安裝）」。

## 更新 (Control UI / RPC)

Control UI 具有 **更新與重新啟動** (RPC: `update.run`)。它：

1. 執行與 `openclaw update` 相同的源碼更新流程（僅限 git checkout）。
2. 寫入一個帶有結構化報告（標準輸出/標準錯誤尾部）的重新啟動標記。
3. 重新啟動 Gateway 並使用報告 Ping 最後一個活動工作階段。

如果 rebase 失敗，Gateway 將中止並重新啟動，而不應用更新。

## 更新（從源碼）

從儲存庫 checkout：

首選：

```bash
openclaw update
```

手動（大致等效）：

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # 首次執行時會自動安裝 UI 依賴項
openclaw doctor
openclaw health
```

備註：

- 當您執行打包的 `openclaw` 二進位檔案（[`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)）或使用 Node 執行 `dist/` 時，`pnpm build` 很重要。
- 如果您從儲存庫 checkout 執行而沒有全球安裝，請使用 `pnpm openclaw ...` 執行 CLI 指令。
- 如果您直接從 TypeScript 執行 (`pnpm openclaw ...`)，通常不需要重建，但**設定遷移仍適用** → 執行 doctor。
- 在全球安裝和 git 安裝之間切換很容易：安裝另一個版本，然後執行 `openclaw doctor`，以便將 Gateway 服務進入點重寫為當前安裝。

## 始終執行：`openclaw doctor`

Doctor 是「安全更新」指令。它刻意保持無聊：修復 + 遷移 + 警告。

備註：如果您是**從源碼安裝** (git checkout)，`openclaw doctor` 將會提供先執行 `openclaw update`。

它通常會執行以下操作：

- 遷移已棄用的設定鍵 / 舊版設定檔案位置。
- 稽核私訊策略並警告有風險的「開放」設定。
- 檢查 Gateway 健康狀況並可提供重新啟動。
- 偵測並將舊版 Gateway 服務 (launchd/systemd; 舊版 schtasks) 遷移到當前的 OpenClaw 服務。
- 在 Linux 上，確保 systemd 使用者持續存在（以便 Gateway 在登出後仍能存活）。

詳細資訊：[Doctor](/gateway/doctor)

## 啟動 / 停止 / 重新啟動 Gateway

CLI（無論作業系統如何）：

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

如果您是受監督的：

- macOS launchd (應用程式綁定的 LaunchAgent)：`launchctl kickstart -k gui/$UID/bot.molt.gateway` (使用 `bot.molt.<profile>`；舊版 `com.openclaw.*` 仍然有效)
- Linux systemd 使用者服務：`systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2)：`systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` 僅在服務已安裝時才有效；否則執行 `openclaw gateway install`。

運行手冊 + 確切的服務標籤：[Gateway 運行手冊](/gateway)

## 回溯 / 固定版本（當出現問題時）

### 固定版本（全球安裝）

安裝已知良好的版本（將 `<version>` 替換為上次工作版本）：

```bash
npm i -g openclaw @<version>
```

```bash
pnpm add -g openclaw @<version>
```

提示：要查看當前發佈的版本，請執行 `npm view openclaw version`。

然後重新啟動 + 重新執行 doctor：

```bash
openclaw doctor
openclaw gateway restart
```

### 固定版本（源碼）按日期

從日期中選擇一個提交（範例：「2026-01-01 的 main 狀態」）：

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

然後重新安裝依賴項 + 重新啟動：

```bash
pnpm install
pnpm build
openclaw gateway restart
```

如果您稍後想回到最新版本：

```bash
git checkout main
git pull
```

## 如果您遇到問題

- 再次執行 `openclaw doctor` 並仔細閱讀輸出（它通常會告訴您解決方案）。
- 檢查：[疑難排解](/gateway/troubleshooting)
- 在 Discord 中提問：[https://discord.gg/clawd](https://discord.gg/clawd)
