---
summary: "Updating OpenClaw safely (global install or source), plus rollback strategy"
read_when:
  - Updating OpenClaw
  - Something breaks after an update
title: Updating
---

# 更新

OpenClaw 發展迅速（尚未達「1.0」版本）。請將更新視為部署基礎架構：更新 → 執行檢查 → 重啟（或使用 `openclaw update`，會自動重啟）→ 驗證。

## 推薦：重新執行網站安裝程式（原地升級）

**首選**的更新方式是重新執行網站上的安裝程式。它會偵測現有安裝，原地升級，並在需要時執行 `openclaw doctor`。

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

注意事項：

- 如果不想讓新手導覽精靈再次執行，請加入 `--no-onboard`。
- 對於 **原始碼安裝**，請使用：

```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
```

安裝程式只會在版本庫乾淨時執行 `git pull --rebase`。

- 對於 **全域安裝**，腳本底層會使用 `npm install -g openclaw@latest`。
- 傳統說明：`clawdbot` 仍保留作為相容性橋接。

## 更新前準備

- 確認你的安裝方式：**全域安裝**（npm/pnpm）或 **原始碼安裝**（git clone）。
- 確認 Gateway 的執行方式：**前景終端機**或 **受監控服務**（launchd/systemd）。
- 快照你的客製化設定：
  - 設定檔：`~/.openclaw/openclaw.json`
  - 憑證：`~/.openclaw/credentials/`
  - 工作區：`~/.openclaw/workspace`

## 更新（全域安裝）

全域安裝（擇一執行）：

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

我們**不建議**在 Gateway 執行環境使用 Bun（WhatsApp/Telegram 有錯誤）。

切換更新頻道（git + npm 安裝）：

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

使用 `--tag <dist-tag|version>` 進行一次性安裝標籤/版本。

請參考 [開發頻道](/install/development-channels) 了解頻道語意與發行說明。

注意：npm 安裝時，gateway 啟動會在日誌中顯示更新提示（會檢查目前頻道標籤）。可透過 `update.checkOnStart: false` 關閉。

### 核心自動更新器（可選）

自動更新器預設**關閉**，是 Gateway 的核心功能（非外掛）。

```json
{
  "update": {
    "channel": "stable",
    "auto": {
      "enabled": true,
      "stableDelayHours": 6,
      "stableJitterHours": 12,
      "betaCheckIntervalHours": 1
    }
  }
}
```

行為：

- `stable`：當偵測到新版本時，OpenClaw 會等待 `stableDelayHours`，接著在 `stableJitterHours` 內套用每次安裝的確定性隨機延遲（分散推出）。
- `beta`：以 `betaCheckIntervalHours` 頻率檢查（預設：每小時），有更新時自動套用。
- `dev`：不自動套用；需手動使用 `openclaw update`。

使用 `openclaw update --dry-run` 預覽更新動作，然後再啟用自動化。

接著：

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

備註：

- 如果您的 Gateway 是以服務方式執行，`openclaw gateway restart` 比直接殺掉 PID 更推薦。
- 如果您已鎖定特定版本，請參考下方「回滾 / 鎖定版本」說明。

## 更新 (`openclaw update`)

對於 **原始碼安裝**（git checkout），建議使用：

```bash
openclaw update
```

它執行一個相對安全的更新流程：

- 需要工作目錄是乾淨的。
- 切換到所選的頻道（標籤或分支）。
- 從設定的上游（開發頻道）抓取並 rebase。
- 安裝相依套件、編譯、編譯控制介面，並執行 `openclaw doctor`。
- 預設會重新啟動 Gateway（若要跳過，請使用 `--no-restart`）。

如果您是透過 **npm/pnpm** 安裝（無 git 資料），`openclaw update` 會嘗試透過您的套件管理工具更新。如果無法偵測安裝方式，請改用「更新（全域安裝）」。

## 更新（控制介面 / RPC）

控制介面有 **更新並重新啟動** 功能（RPC: `update.run`）。它會：

1. 執行與 `openclaw update` 相同的原始碼更新流程（僅限 git checkout）。
2. 寫入帶有結構化報告（stdout/stderr 尾端）的重新啟動標記。
3. 重新啟動 Gateway，並用報告通知最後一個活躍的工作階段。

如果 rebase 失敗，Gateway 會中止並重新啟動，但不會套用更新。

## 從原始碼更新

從倉庫檢出：

建議：

```bash
openclaw update
```

手動（大致相當）：

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

注意事項：

- 執行封裝好的 `openclaw` 二進位檔 (`openclaw.mjs`(https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) 或使用 Node 執行 `dist/` 時，`pnpm build` 很重要。
- 如果從原始碼倉庫檢出且沒有全域安裝，請使用 `pnpm openclaw ...` 來執行 CLI 指令。
- 如果直接從 TypeScript (`pnpm openclaw ...`) 執行，通常不需要重新編譯，但 **設定遷移仍然適用** → 請執行 doctor。
- 在全域安裝與 git 安裝間切換很簡單：安裝另一種版本後，執行 `openclaw doctor`，這樣 gateway 服務的入口點會被重寫為目前的安裝版本。

## 必須執行：`openclaw doctor`

Doctor 是「安全更新」指令。它故意設計得很簡單：修復 + 遷移 + 警告。

注意：如果你是使用 **原始碼安裝**（git 檢出），`openclaw doctor` 會先建議你執行 `openclaw update`。

它通常會做的事情：

- 遷移已棄用的設定鍵 / 舊版設定檔位置。
- 審核 DM 政策並警告風險較高的「開放」設定。
- 檢查 Gateway 狀態，並可提供重新啟動選項。
- 偵測並遷移較舊的 gateway 服務（launchd/systemd；舊版 schtasks）到目前的 OpenClaw 服務。
- 在 Linux 上，確保 systemd 使用者持續執行（讓 Gateway 登出後仍持續運作）。

詳細資訊：[Doctor](/gateway/doctor)

## 啟動 / 停止 / 重新啟動 Gateway

CLI（跨作業系統皆適用）：

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

如果你是被監控的環境：

- macOS launchd（應用程式綁定的 LaunchAgent）：`launchctl kickstart -k gui/$UID/ai.openclaw.gateway`（使用 `ai.openclaw.<profile>`；舊版 `com.openclaw.*` 仍可使用）
- Linux systemd 使用者服務：`systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows（WSL2）：`systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` 僅在服務已安裝時有效；否則請執行 `openclaw gateway install`。

Runbook + 精確服務標籤：[Gateway runbook](/gateway)

## 回滾 / 鎖定版本（當系統出錯時）

### 鎖定（全域安裝）

安裝已知可用版本（將 `<version>` 替換為最後可用版本）：

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

提示：要查看目前發佈的版本，請執行 `npm view openclaw version`。

接著重新啟動並重新執行 doctor：

```bash
openclaw doctor
openclaw gateway restart
```

### 依日期鎖定（原始碼）

選擇某日期的 commit（範例：「main 分支截至 2026-01-01 的狀態」）：

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

然後重新安裝相依套件並重新啟動：

```bash
pnpm install
pnpm build
openclaw gateway restart
```

如果你想稍後回到最新版本：

```bash
git checkout main
git pull
```

## 如果你卡住了

- 再次執行 `openclaw doctor` 並仔細閱讀輸出（通常會告訴你如何修正）。
- 查看：[故障排除](/gateway/troubleshooting)
- 在 Discord 詢問：[https://discord.gg/clawd](https://discord.gg/clawd)
