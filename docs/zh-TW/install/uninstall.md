---
summary: "Uninstall OpenClaw completely (CLI, service, state, workspace)"
read_when:
  - You want to remove OpenClaw from a machine
  - The gateway service is still running after uninstall
title: Uninstall
---

# 移除安裝

兩種方式：

- 如果 `openclaw` 仍然安裝，使用 **簡易方式**。
- 如果 CLI 已移除但服務仍在執行，則需 **手動移除服務**。

## 簡易方式（CLI 仍安裝）

建議：使用內建的移除安裝程式：

```bash
openclaw uninstall
```

非互動式（自動化 / npx）：

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

手動步驟（結果相同）：

1. 停止 gateway 服務：

```bash
openclaw gateway stop
```

2. 移除 gateway 服務（launchd/systemd/schtasks）：

```bash
openclaw gateway uninstall
```

3. 刪除狀態與設定：

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

如果你將 `OPENCLAW_CONFIG_PATH` 設定為狀態目錄外的自訂位置，也請刪除該檔案。

4. 刪除你的工作區（可選，會移除代理程式檔案）：

```bash
rm -rf ~/.openclaw/workspace
```

5. 移除 CLI 安裝（選擇你使用的版本）：

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. 如果你安裝了 macOS 應用程式：

```bash
rm -rf /Applications/OpenClaw.app
```

注意事項：

- 如果你使用了設定檔（`--profile` / `OPENCLAW_PROFILE`），請對每個狀態目錄重複步驟 3（預設為 `~/.openclaw-<profile>`）。
- 在遠端模式下，狀態目錄位於 **gateway 主機**，因此也請在該處執行步驟 1-4。

## 手動移除服務（未安裝 CLI）

當 gateway 服務持續運作但 `openclaw` 不見時，請使用此方法。

### macOS（launchd）

預設標籤為 `ai.openclaw.gateway`（或 `ai.openclaw.<profile>`；舊版 `com.openclaw.*` 可能仍存在）：

```bash
launchctl bootout gui/$UID/ai.openclaw.gateway
rm -f ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

如果你使用了設定檔，請將標籤和 plist 名稱替換為 `ai.openclaw.<profile>`。若有舊版 `com.openclaw.*` plist，請一併移除。

### Linux（systemd 使用者單元）

預設的單元名稱是 `openclaw-gateway.service`（或 `openclaw-gateway-<profile>.service`）：

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows（排程任務）

預設的任務名稱是 `OpenClaw Gateway`（或 `OpenClaw Gateway (<profile>)`）。
任務腳本位於您的狀態目錄下。

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

如果您使用過設定檔，請刪除相符的任務名稱和 `~\.openclaw-<profile>\gateway.cmd`。

## 一般安裝 vs 原始碼檢出

### 一般安裝（install.sh / npm / pnpm / bun）

如果您使用 `https://openclaw.ai/install.sh` 或 `install.ps1`，CLI 是透過 `npm install -g openclaw@latest` 安裝的。
請使用 `npm rm -g openclaw`（或如果您是用那種方式安裝，則用 `pnpm remove -g` / `bun remove -g`）來移除它。

### 原始碼檢出（git clone）

如果您是從 repo 檢出執行（`git clone` + `openclaw ...` / `bun run openclaw ...`）：

1. 在刪除 repo 之前，先解除安裝 gateway 服務（可使用上述簡易方式或手動移除服務）。
2. 刪除 repo 目錄。
3. 如上所示，移除狀態與工作區。
