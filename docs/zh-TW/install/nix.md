---
summary: "使用 Nix 宣告式安裝 OpenClaw"
read_when:
  - 您需要可重現、可回溯的安裝
  - 您已經在使用 Nix/NixOS/Home Manager
  - 您希望所有項目都宣告式地固定和管理
title: "Nix"
---

# Nix 安裝

使用 Nix 執行 OpenClaw 的推薦方式是透過 **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** — 一個包含所有功能的 Home Manager 模組。

## 快速開始

將以下內容貼到您的 AI 智慧代理（Claude、Cursor 等）：

```text
I want to set up nix-openclaw on my Mac.
Repository: github:openclaw/nix-openclaw

What I need you to do:
1. Check if Determinate Nix is installed (if not, install it)
2. Create a local flake at ~/code/openclaw-local using templates/agent-first/flake.nix
3. Help me create a Telegram bot ( @BotFather) and get my chat ID ( @userinfobot)
4. Set up secrets (bot token, Anthropic key) - plain files at ~/.secrets/ is fine
5. Fill in the template placeholders and run home-manager switch
6. Verify: launchd running, bot responds to messages

Reference the nix-openclaw README for module options.
```

> **📦 完整指南：[github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> nix-openclaw 儲存庫是 Nix 安裝的真實來源。本頁面僅為快速概述。

## 您將獲得

- Gateway + macOS 應用程式 + 工具（whisper、spotify、cameras）— 所有項目都已固定
- 重新啟動後仍可運作的 Launchd 服務
- 帶有宣告式設定的外掛系統
- 即時回溯：`home-manager switch --rollback`

---

## Nix 模式執行期行為

當 `OPENCLAW_NIX_MODE=1` 設定時（nix-openclaw 自動啟用）：

OpenClaw 支援 **Nix 模式**，可使設定具有確定性並禁用自動安裝流程。
透過匯出以下內容來啟用它：

```bash
OPENCLAW_NIX_MODE=1
```

在 macOS 上，GUI 應用程式不會自動繼承 shell 環境變數。您也可以透過預設設定啟用 Nix 模式：

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### 設定 + 狀態路徑

OpenClaw 從 `OPENCLAW_CONFIG_PATH` 讀取 JSON5 設定，並將可變動資料儲存在 `OPENCLAW_STATE_DIR` 中。
必要時，您也可以設定 `OPENCLAW_HOME` 來控制用於內部路徑解析的基礎主目錄。

- `OPENCLAW_HOME` (預設優先順序：`HOME` / `USERPROFILE` / `os.homedir()`)
- `OPENCLAW_STATE_DIR` (預設：`~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` (預設：`$OPENCLAW_STATE_DIR/openclaw.json`)

在 Nix 下執行時，請明確將這些設定為 Nix 管理的位置，以便執行期狀態和設定不會存儲在不可變更的儲存中。

### Nix 模式下的執行期行為

- 自動安裝和自我變異流程已禁用
- 遺失的依賴項會顯示 Nix 特定的修復訊息
- 存在時，UI 會顯示只讀的 Nix 模式橫幅

## 打包注意事項 (macOS)

macOS 打包流程預期在以下位置有一個穩定的 Info.plist 範本：

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 會將此範本複製到應用程式套件中並修補動態欄位（bundle ID、版本/建置、Git SHA、Sparkle 鍵）。這使得 SwiftPM 打包和 Nix 建置（不依賴完整的 Xcode 工具鏈）的 plist 具有確定性。

## 相關

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — 完整設定指南
- [Wizard](/start/wizard) — 非 Nix CLI 設定
- [Docker](/install/docker) — 容器化設定
