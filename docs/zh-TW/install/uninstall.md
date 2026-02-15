---
summary: "完整解除安裝 OpenClaw (CLI、服務、狀態、工作空間)"
read_when:
  - 您想從機器上移除 OpenClaw
  - 解除安裝後 Gateway 服務仍在執行
title: "解除安裝"
---

# 解除安裝

兩種路徑：

- 若 `openclaw` 仍已安裝，請使用 **簡易路徑**。
- 若 CLI 已移除但服務仍在執行，請使用 **手動移除服務**。

## 簡易路徑 (CLI 仍已安裝)

建議：使用內建的解除安裝程式：

```bash
openclaw uninstall
```

非互動式 (自動化 / npx)：

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

手動步驟 (效果相同)：

1. 停止 Gateway 服務：

```bash
openclaw gateway stop
```

2. 解除安裝 Gateway 服務 (launchd/systemd/schtasks)：

```bash
openclaw gateway uninstall
```

3. 刪除狀態 + 設定：

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

如果您將 `OPENCLAW_CONFIG_PATH` 設定在狀態目錄之外的自定義位置，請也刪除該檔案。

4. 刪除您的工作空間 (選填，會移除智慧代理檔案)：

```bash
rm -rf ~/.openclaw/workspace
```

5. 移除已安裝的 CLI (選擇您使用的工具)：

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. 如果您安裝了 macOS 應用程式：

```bash
rm -rf /Applications/OpenClaw.app
```

備註：

- 如果您使用了設定檔 (`--profile` / `OPENCLAW_PROFILE`)，請對每個狀態目錄重複步驟 3 (預設為 `~/.openclaw-<profile>`)。
- 在遠端模式下，狀態目錄位於 **Gateway 主機**上，因此也要在該處執行步驟 1-4。

## 手動移除服務 (CLI 未安裝)

如果 Gateway 服務持續執行但缺少 `openclaw`，請使用此方法。

### macOS (launchd)

預設標籤為 `bot.molt.gateway` (或 `bot.molt.<profile>`；可能仍存在舊版的 `com.openclaw.*`)：

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

如果您使用了設定檔，請將標籤和 plist 檔案名稱替換為 `bot.molt.<profile>`。如果存在任何舊版的 `com.openclaw.*` plist，請將其移除。

### Linux (systemd user unit)

預設單元名稱為 `openclaw-gateway.service` (或 `openclaw-gateway-<profile>.service`)：

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (排程工作)

預設工作名稱為 `OpenClaw Gateway` (或 `OpenClaw Gateway (<profile>)`)。
工作指令碼位於您的狀態目錄下。

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

如果您使用了設定檔，請刪除對應的工作名稱和 `~\.openclaw-<profile>\gateway.cmd`。

## 一般安裝 vs 從原始碼檢出

### 一般安裝 (install.sh / npm / pnpm / bun)

如果您使用了 `https://openclaw.ai/install.sh` 或 `install.ps1`，則 CLI 是透過 `npm install -g openclaw @latest` 安裝的。
使用 `npm rm -g openclaw` 移除它 (如果您是透過其他方式安裝，請使用 `pnpm remove -g` 或 `bun remove -g`)。

### 從原始碼檢出 (git clone)

如果您是從儲存庫檢出執行 (`git clone` + `openclaw ...` / `bun run openclaw ...`)：

1. 在刪除儲存庫 **之前**，先解除安裝 Gateway 服務 (使用上述的簡易路徑或手動移除服務)。
2. 刪除儲存庫目錄。
3. 如上所示移除狀態 + 工作空間。
