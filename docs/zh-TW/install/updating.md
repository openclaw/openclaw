---
summary: "安全更新 OpenClaw（全域安裝或原始碼安裝），以及回滾策略"
read_when:
  - 更新 OpenClaw 時
  - 更新後發生錯誤時
title: "更新"
---

# 更新

OpenClaw 發展迅速（目前處於 "1.0" 前版本）。請將更新視為發佈基礎設施：更新 → 執行檢查 → 重新啟動（或使用會自動重新啟動的 `openclaw update`） → 驗證。

## 建議方式：重新執行官網安裝程式（原地升級）

**偏好**的更新路徑是重新執行官網的安裝程式。它會偵測現有的安裝、進行原地升級，並在需要時執行 `openclaw doctor`。

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

附註：

- 如果您不希望再次執行新手導覽精靈，請加上 `--no-onboard`。
- 若是從 **原始碼安裝**，請使用：

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  安裝程式僅會在儲存庫乾淨的情況下執行 `git pull --rebase`。

- 對於 **全域安裝**，該指令碼會在後台使用 `npm install -g openclaw @latest`。
- 舊版附註：`clawdbot` 仍可作為相容性墊片（shim）使用。

## 更新前

- 確認您的安裝方式：**全域**（npm/pnpm）或從 **原始碼**（git clone）。
- 確認您的 Gateway 執行方式：**前景終端機**或 **受控服務**（launchd/systemd）。
- 備份您的自訂設定：
  - 設定：`~/.openclaw/openclaw.json`
  - 憑證：`~/.openclaw/credentials/`
  - 工作區：`~/.openclaw/workspace`

## 更新（全域安裝）

全域安裝（擇一使用）：

```bash
npm i -g openclaw @latest
```

```bash
pnpm add -g openclaw @latest
```

我們 **不建議** 將 Bun 用於 Gateway 執行環境（WhatsApp/Telegram 存在錯誤）。

切換更新通道（git + npm 安裝）：

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

使用 `--tag <dist-tag|version>` 來指定單次的安裝標籤或版本。

請參閱 [開發通道](/install/development-channels) 了解通道語義與版本資訊。

注意：使用 npm 安裝時，Gateway 會在啟動時記錄更新提示（檢查目前的通道標籤）。可透過 `update.checkOnStart: false` 停用。

接著執行：

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

附註：

- 如果您的 Gateway 作為服務執行，建議使用 `openclaw gateway restart`，而非手動刪除 PID。
- 如果您固定在特定版本，請參閱下方的「回滾 / 固定版本」。

## 更新（`openclaw update`）

對於 **原始碼安裝**（git checkout），建議使用：

```bash
openclaw update
```

它會執行一個相對安全的更新流程：

- 需要乾淨的工作樹（worktree）。
- 切換到選定的通道（標籤或分支）。
- 抓取（fetch）並對設定的上游（開發通道）進行重定基底（rebase）。
- 安裝依賴項目、建置、建置 Control UI，並執行 `openclaw doctor`。
- 預設會重新啟動 Gateway（使用 `--no-restart` 可跳過）。

如果您是透過 **npm/pnpm** 安裝（無 git 中繼資料），`openclaw update` 會嘗試透過套件管理員進行更新。如果無法偵測到安裝資訊，請改用「更新（全域安裝）」。

## 更新（Control UI / RPC）

Control UI 提供 **更新並重新啟動**（RPC: `update.run`）功能，它會：

1. 執行與 `openclaw update` 相同的原始碼更新流程（僅限 git checkout）。
2. 寫入包含結構化報告（stdout/stderr 結尾）的重新啟動哨兵檔案。
3. 重新啟動 Gateway 並將報告發送至最後一個活動的工作階段。

如果 rebase 失敗，Gateway 會中止更新並在不套用更新的情況下重新啟動。

## 更新（從原始碼）

從儲存庫檢出（checkout）目錄：

建議方式：

```bash
openclaw update
```

手動方式（效果等同）：

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # 首次執行時會自動安裝 UI 依賴項目
openclaw doctor
openclaw health
```

附註：

- 當您執行封裝好的 `openclaw` 二進位檔 ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) 或使用 Node 執行 `dist/` 時，`pnpm build` 至關重要。
- 如果您是在儲存庫檢出目錄執行且未進行全域安裝，請使用 `pnpm openclaw ...` 執行 CLI 指令。
- 如果您直接從 TypeScript 執行（`pnpm openclaw ...`），通常不需要重新建置，但 **設定遷移仍需套用** → 請執行 doctor。
- 在全域安裝與 git 安裝之間切換非常簡單：安裝另一種版本，然後執行 `openclaw doctor`，如此一來 Gateway 服務的進入點就會被重寫為目前的安裝版本。

## 務必執行：`openclaw doctor`

Doctor 是「安全更新」指令。它的功能刻意保持單純：修復 + 遷移 + 警告。

注意：如果您是從 **原始碼安裝**（git checkout），`openclaw doctor` 會建議先執行 `openclaw update`。

它通常執行的操作：

- 遷移已棄用的設定鍵值 / 舊版設定檔案位置。
- 稽核私訊原則，並針對具風險的「開放」設定發出警告。
- 檢查 Gateway 健康狀態，並提供重新啟動選項。
- 偵測舊版 Gateway 服務（launchd/systemd；舊版 schtasks）並遷移至目前的 OpenClaw 服務。
- 在 Linux 上，確保啟用了 systemd 使用者駐留（user lingering），以便 Gateway 在登出後仍能持續執行。

詳情：[Doctor](/gateway/doctor)

## 啟動 / 停止 / 重新啟動 Gateway

CLI（適用於各作業系統）：

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

如果您使用服務管理：

- macOS launchd (應用程式隨附的 LaunchAgent)：`launchctl kickstart -k gui/$UID/bot.molt.gateway`（請使用 `bot.molt.<profile>`；舊版的 `com.openclaw.*` 仍可運作）
- Linux systemd 使用者服務：`systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2)：`systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` 僅在服務已安裝時才有效；否則請執行 `openclaw gateway install`。

操作手冊 + 確切的服務標籤：[Gateway 操作手冊](/gateway)

## 回滾 / 固定版本（當發生錯誤時）

### 固定版本（全域安裝）

安裝已知正常的版本（將 `<version>` 替換為上一個正常的版本）：

```bash
npm i -g openclaw @<version>
```

```bash
pnpm add -g openclaw @<version>
```

提示：若要查看目前發佈的版本，請執行 `npm view openclaw version`。

然後重新啟動並再次執行 doctor：

```bash
openclaw doctor
openclaw gateway restart
```

### 依日期固定版本（原始碼安裝）

選取特定日期的提交（commit）（例如：「2026-01-01 時的 main 狀態」）：

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

然後重新安裝依賴項目並重新啟動：

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

## 如果您遇到困難

- 再次執行 `openclaw doctor` 並仔細閱讀輸出內容（它通常會告訴您修復方法）。
- 請查看：[疑難排解](/gateway/troubleshooting)
- 在 Discord 中提問：[https://discord.gg/clawd](https://discord.gg/clawd)
