---
summary: "完整解除安裝 OpenClaw (CLI、服務、狀態、工作空間)"
read_when:
  - 您想要從機器中移除 OpenClaw 時
  - 解除安裝後 Gateway 服務仍持續執行時
title: "解除安裝"
---

# 解除安裝

兩種方式：

- **簡易方式** 如果 `openclaw` 仍然安裝著。
- **手動移除服務** 如果 CLI 已移除但服務仍持續執行。

## 簡易方式 (CLI 仍然安裝著)

建議：使用內建的解除安裝程式：

```bash
openclaw uninstall
```

非互動式 (自動化 / npx)：

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

手動步驟 (相同結果)：

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

如果您將 `OPENCLAW_CONFIG_PATH` 設定為狀態目錄以外的自訂位置，請一併刪除該檔案。

4. 刪除您的工作空間 (選用，會移除智慧代理檔案)：

```bash
rm -rf ~/.openclaw/workspace
```

5. 移除 CLI 安裝 (選擇您使用的安裝方式)：

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

- 如果您使用了設定檔 (`--profile` / `OPENCLAW_PROFILE`)，請為每個狀態目錄重複步驟 3 (預設值為 `~/.openclaw-<profile>`)。
- 在遠端模式中，狀態目錄位於 **Gateway 主機**上，因此請也在該處執行步驟 1-4。

## 手動移除服務 (CLI 未安裝)

如果 Gateway 服務持續執行但 `openclaw` 遺失，請使用此方式。

### macOS (launchd)

預設標籤為 `bot.molt.gateway` (或 `bot.molt.<profile>`；舊版 `com.openclaw.*` 可能仍然存在)：

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

如果您使用了設定檔，請將標籤和 plist 名稱替換為 `bot.molt.<profile>`。如果存在，請移除任何舊版 `com.openclaw.*` plist。

### Linux (systemd 使用者單元)

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

如果您使用了設定檔，請刪除相符的工作名稱和 `~\.openclaw-<profile>\gateway.cmd`。

## 一般安裝 vs 原始碼檢出

### 一般安裝 (install.sh / npm / pnpm / bun)

如果您使用了 `https://openclaw.ai/install.sh` 或 `install.ps1`，CLI 是透過 `npm install -g openclaw @latest` 安裝的。
使用 `npm rm -g openclaw` 移除它 (如果您是透過這種方式安裝，則使用 `pnpm remove -g` / `bun remove -g`)。

### 原始碼檢出 (git clone)

如果您是從儲存庫檢出 (`git clone` + `openclaw ...` / `bun run openclaw ...`) 執行：

1. 在刪除儲存庫**之前**解除安裝 Gateway 服務 (使用上述簡易方式或手動移除服務)。
2. 刪除儲存庫目錄。
3. 移除如上所示的狀態 + 工作空間。
