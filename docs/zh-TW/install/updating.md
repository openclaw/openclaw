---
summary: "安全更新 OpenClaw（全域安裝或原始碼），以及回滾策略"
read_when:
  - 更新 OpenClaw
  - 更新後發生問題
title: "更新"
---

# 更新

OpenClaw is moving fast (pre “1.0”). Treat updates like shipping infra: update → run checks → restart (or use `openclaw update`, which restarts) → verify.

## 建議作法：重新執行網站安裝程式（原地升級）

The **preferred** update path is to re-run the installer from the website. It
detects existing installs, upgrades in place, and runs `openclaw doctor` when
needed.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

注意事項：

- 若不想再次執行入門引導精靈，請加入 `--no-onboard`。

- 對於 **原始碼安裝**，請使用：

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  安裝程式**僅**在儲存庫為乾淨狀態時才會 `git pull --rebase`。

- 對於 **全域安裝**，腳本底層會使用 `npm install -g openclaw@latest`。

- 相容性備註：`clawdbot` 仍可作為相容性墊片使用。

## 更新前

- 確認你的安裝方式：**全域**（npm/pnpm）或 **原始碼**（git clone）。
- 確認你的 Gateway 閘道器如何執行：**前景終端機** 或 **受監管服務**（launchd/systemd）。
- 建立你的客製化快照：
  - 設定：`~/.openclaw/openclaw.json`
  - 憑證：`~/.openclaw/credentials/`
  - 工作區：`~/.openclaw/workspace`

## 更新（全域安裝）

40. 全域安裝（擇一）：

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

我們**不**建議將 Bun 用於 Gateway 閘道器執行階段（WhatsApp／Telegram 有已知問題）。

切換更新通道（git + npm 安裝）：

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

若要一次性指定安裝標籤／版本，請使用 `--tag <dist-tag|version>`。

通道語意與發行說明請見：[Development channels](/install/development-channels)。

注意：在 npm 安裝下，Gateway 閘道器會在啟動時記錄更新提示（檢查目前通道標籤）。可透過 `update.checkOnStart: false` 停用。 Disable via `update.checkOnStart: false`.

然後：

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

注意事項：

- 若你的 Gateway 閘道器以服務方式執行，建議使用 `openclaw gateway restart`，不要直接終止 PID。
- If you’re pinned to a specific version, see “Rollback / pinning” below.

## 更新（`openclaw update`）

對於 **原始碼安裝**（git checkout），建議使用：

```bash
openclaw update
```

它會執行一個相對安全的更新流程：

- 需要乾淨的工作樹。
- 切換到選定的通道（標籤或分支）。
- 針對已設定的上游（dev 通道）擷取並 rebase。
- 安裝相依套件、建置、建置 Control UI，並執行 `openclaw doctor`。
- Restarts the gateway by default (use `--no-restart` to skip).

若你是透過 **npm/pnpm** 安裝（沒有 git 中繼資料），`openclaw update` 會嘗試使用你的套件管理器更新。若無法偵測安裝，請改用「更新（全域安裝）」。 If it can’t detect the install, use “Update (global install)” instead.

## 更新（Control UI／RPC）

Control UI 提供 **Update & Restart**（RPC：`update.run`）。它會： 重新啟動閘道，並以報告 ping 最後一個作用中的工作階段。

1. 執行與 `openclaw update` 相同的原始碼更新流程（僅限 git checkout）。
2. 寫入包含結構化報告的重新啟動哨兵（stdout/stderr 尾端）。
3. Restarts the gateway and pings the last active session with the report.

If the rebase fails, the gateway aborts and restarts without applying the update.

## 更新（從原始碼）

在儲存庫 checkout 中：

建議：

```bash
openclaw update
```

手動（大致等同）：

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

注意事項：

- 當你執行封裝後的 `openclaw` 二進位檔（[`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)）或使用 Node 執行 `dist/` 時，`pnpm build` 很重要。
- 若你是從儲存庫 checkout 執行且沒有全域安裝，請使用 `pnpm openclaw ...` 來執行 CLI 指令。
- 若你直接從 TypeScript 執行（`pnpm openclaw ...`），通常不需要重新建置，但**設定遷移仍然適用** → 請執行 doctor。
- Switching between global and git installs is easy: install the other flavor, then run `openclaw doctor` so the gateway service entrypoint is rewritten to the current install.

## 務必執行：`openclaw doctor`

Doctor 是「安全更新」指令。它刻意保持單純：修復＋遷移＋警示。 It’s intentionally boring: repair + migrate + warn.

注意：若你使用 **原始碼安裝**（git checkout），`openclaw doctor` 會先提議執行 `openclaw update`。

它通常會做的事：

- 遷移已淘汰的設定鍵／舊版設定檔位置。
- Audit DM policies and warn on risky “open” settings.
- Check Gateway health and can offer to restart.
- 偵測並遷移舊版 Gateway 閘道器服務（launchd/systemd；舊版 schtasks）至目前的 OpenClaw 服務。
- 在 Linux 上，確保 systemd 使用者 lingering（讓 Gateway 閘道器在登出後仍可存活）。

詳細資訊：[Doctor](/gateway/doctor)

## 啟動／停止／重新啟動 Gateway 閘道器

CLI（不論作業系統皆可）：

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

若你使用受監管服務：

- macOS launchd（App 封裝的 LaunchAgent）：`launchctl kickstart -k gui/$UID/bot.molt.gateway`（使用 `bot.molt.<profile>`；舊版 `com.openclaw.*` 仍可用）
- Linux systemd 使用者服務：`systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows（WSL2）：`systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` 僅在已安裝服務時可用；否則請執行 `openclaw gateway install`。

作業手冊＋精確服務標籤：[Gateway runbook](/gateway)

## 釘選（全域安裝）

### Pin (global install)

安裝已知可用的版本（將 `<version>` 換成最後可正常運作的版本）：

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

提示：要查看目前已發佈的版本，請執行 `npm view openclaw version`。

接著重新啟動並再次執行 doctor：

```bash
openclaw doctor
openclaw gateway restart
```

### 依日期釘選（原始碼）

從特定日期選擇一個提交（例如：「截至 2026-01-01 的 main 狀態」）：

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

若之後想回到最新版本：

```bash
git checkout main
git pull
```

## 若你卡住了

- 再次執行 `openclaw doctor`，並仔細閱讀輸出（通常會告訴你修正方式）。
- 查看：[疑難排解](/gateway/troubleshooting)
- 到 Discord 詢問：[https://discord.gg/clawd](https://discord.gg/clawd)
