---
summary: "完整解除安裝 OpenClaw（CLI、服務、狀態、工作區）"
read_when:
  - 你想要從一台機器移除 OpenClaw
  - 解除安裝後 Gateway 閘道器服務仍在執行
title: "解除安裝"
---

# 解除安裝

27. 兩種路徑：

- **簡易方式**：如果 `openclaw` 仍然已安裝。
- **手動移除服務**：如果 CLI 已不存在，但服務仍在執行。

## 簡易方式（CLI 仍然已安裝）

`.`

```bash
openclaw uninstall
```

非互動式（自動化 / npx）：

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

手動步驟（結果相同）：

1. 停止 Gateway 閘道器服務：

```bash
openclaw gateway stop
```

2. 解除安裝 Gateway 閘道器服務（launchd / systemd / schtasks）：

```bash
openclaw gateway uninstall
```

3. 刪除狀態與設定：

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

如果你將 `OPENCLAW_CONFIG_PATH` 設定為狀態目錄之外的自訂位置，也請一併刪除該檔案。

4. 刪除你的工作區（選用，會移除代理程式檔案）：

```bash
rm -rf ~/.openclaw/workspace
```

5. 移除 CLI 安裝（選擇你當初使用的方式）：

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

- 如果你使用了設定檔（`--profile` / `OPENCLAW_PROFILE`），請針對每個狀態目錄重複步驟 3（預設值為 `~/.openclaw-<profile>`）。
- 在遠端模式下，狀態目錄位於 **閘道器主機** 上，因此步驟 1–4 也需要在該主機上執行。

## 手動移除服務（未安裝 CLI）

如果 Gateway 閘道器服務仍在執行，但 `openclaw` 不存在，請使用此方式。

### macOS（launchd）

預設標籤為 `bot.molt.gateway`（或 `bot.molt.<profile>`；舊版 `com.openclaw.*` 可能仍存在）：

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

如果你使用了設定檔，請將標籤與 plist 名稱替換為 `bot.molt.<profile>29. `. `。若存在任何舊版 `com.openclaw.\*\` plist，也請一併移除。

### Linux（systemd 使用者單元）

預設單元名稱為 `openclaw-gateway.service`（或 `openclaw-gateway-<profile>.service`）：

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows（排程工作）

預設工作名稱為 `OpenClaw Gateway`（或 `OpenClaw Gateway (<profile>)`）。
工作腳本位於你的狀態目錄下。
30. 任務腳本位於你的狀態目錄之下。

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

如果你使用了設定檔，請刪除對應的工作名稱以及 `~\.openclaw-<profile>\gateway.cmd`。

## 使用 `npm rm -g openclaw` 移除（若你是用該方式安裝，則使用 `pnpm remove -g` / `bun remove -g`）。

### 一般安裝（install.sh / npm / pnpm / bun）

如果你使用 `https://openclaw.ai/install.sh` 或 `install.ps1`，CLI 是透過 `npm install -g openclaw@latest` 安裝的。
請使用 `npm rm -g openclaw` 移除（如果你是用其他方式安裝，則使用 `pnpm remove -g` / `bun remove -g`）。
在刪除儲存庫之前 **先** 解除安裝閘道服務（使用上方的簡易路徑或手動移除服務）。

### 原始碼檢出（git clone）

如果你是從儲存庫檢出來執行（`git clone` + `openclaw ...` / `bun run openclaw ...`）：

1. Uninstall the gateway service **before** deleting the repo (use the easy path above or manual service removal).
2. 如上所示移除狀態資料 + 工作區。
3. Remove state + workspace as shown above.
