---
summary: "使用 Nix 以宣告式方式安裝 OpenClaw"
read_when:
  - 想要可重現、可回溯的安裝方式
  - 已經在使用 Nix/NixOS/Home Manager
  - 希望以宣告式方式固定版本並管理所有內容
title: "Nix"
---

# Nix 安裝

在 Nix 上執行 OpenClaw 的推薦方式是透過 **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** — 一個功能完備的 Home Manager 模組。

## 快速開始

將此內容貼給您的 AI 智慧代理（Claude、Cursor 等）：

```text
我想在我的 Mac 上設定 nix-openclaw。
Repository: github:openclaw/nix-openclaw

我需要你執行以下操作：
1. 檢查是否已安裝 Determinate Nix（如果沒有，請安裝它）
2. 使用 templates/agent-first/flake.nix 在 ~/code/openclaw-local 建立一個本地 flake
3. 協助我建立 Telegram 機器人（@BotFather）並取得我的聊天 ID（@userinfobot）
4. 設定秘密資訊（機器人 token、Anthropic 金鑰）- 儲存在 ~/.secrets/ 的純文字檔即可
5. 填寫範本佔位符並執行 home-manager switch
6. 驗證：launchd 正在執行，機器人會回應訊息

參考 nix-openclaw 的 README 以了解模組選項。
```

> **📦 完整指南：[github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> nix-openclaw 儲存庫是 Nix 安裝的權威來源。本頁面僅提供快速總覽。

## 您將獲得

- Gateway + macOS 應用程式 + 工具（whisper、spotify、攝影機）— 全部固定版本
- 重啟後仍能運行的 Launchd 服務
- 具有宣告式設定的插件系統
- 即時回溯：`home-manager switch --rollback`

---

## Nix 模式執行期行為

當設定 `OPENCLAW_NIX_MODE=1` 時（nix-openclaw 會自動設定）：

OpenClaw 支援 **Nix 模式**，該模式會使設定具有確定性，並停用自動安裝流程。
透過匯出以下變數來啟用：

```bash
OPENCLAW_NIX_MODE=1
```

在 macOS 上，GUI 應用程式不會自動繼承 shell 環境變數。您也可以透過 defaults 啟用 Nix 模式：

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### 設定 + 狀態路徑

OpenClaw 從 `OPENCLAW_CONFIG_PATH` 讀取 JSON5 設定，並將可變動資料儲存在 `OPENCLAW_STATE_DIR`。
需要時，您也可以設定 `OPENCLAW_HOME` 來控制內部路徑解析所使用的基礎家目錄。

- `OPENCLAW_HOME`（預設優先順序：`HOME` / `USERPROFILE` / `os.homedir()`）
- `OPENCLAW_STATE_DIR`（預設：`~/.openclaw`）
- `OPENCLAW_CONFIG_PATH`（預設：`$OPENCLAW_STATE_DIR/openclaw.json`）

在 Nix 下執行時，請將這些明確設定為 Nix 管理的位置，以便執行期狀態與設定不會進入不可變的 store 中。

### Nix 模式下的執行期行為

- 自動安裝和自我變動流程已停用
- 缺失的依賴項會顯示 Nix 特有的修復訊息
- UI 會在啟用時顯示唯讀的 Nix 模式橫幅

## 封裝說明 (macOS)

macOS 封裝流程預期在以下位置有一個穩定的 Info.plist 範本：

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 會將此範本複製到應用程式套件 (app bundle) 中，並修補動態欄位（bundle ID、版本/組建、Git SHA、Sparkle 金鑰）。這可以讓 plist 在 SwiftPM 封裝和 Nix 建置（不依賴完整的 Xcode 工具鏈）中保持確定性。

## 相關內容

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — 完整設定指南
- [精靈](/start/wizard) — 非 Nix 的 CLI 設定
- [Docker](/install/docker) — 容器化設定
