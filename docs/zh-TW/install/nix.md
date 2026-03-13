---
summary: Install OpenClaw declaratively with Nix
read_when:
  - "You want reproducible, rollback-able installs"
  - You're already using Nix/NixOS/Home Manager
  - You want everything pinned and managed declaratively
title: Nix
---

# Nix 安裝

推薦使用 Nix 執行 OpenClaw 的方式是透過 **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** — 一個內建完整功能的 Home Manager 模組。

## 快速開始

將以下內容貼給你的 AI 助理（Claude、Cursor 等）：

text
我想在我的 Mac 上設定 nix-openclaw。
Repository: github:openclaw/nix-openclaw

我需要你做的事：

1. 檢查是否已安裝 Determinate Nix（如果沒有，請安裝）
2. 使用 templates/agent-first/flake.nix 在 ~/code/openclaw-local 建立本地 flake
3. 協助我建立 Telegram 機器人（@BotFather）並取得我的聊天 ID（@userinfobot）
4. 設定秘密資訊（bot token、模型提供者 API key）— 以純文字檔放在 ~/.secrets/ 即可
5. 填寫範本中的佔位符並執行 home-manager switch
6. 驗證：launchd 正常運作，機器人能回應訊息

請參考 nix-openclaw README 了解模組選項。

> **📦 完整指南：[github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> nix-openclaw 倉庫是 Nix 安裝的權威來源。此頁面僅為快速概覽。

## 你將獲得的功能

- Gateway + macOS 應用程式 + 工具（whisper、spotify、攝影機）— 全部版本固定
- 可在重啟後持續運作的 launchd 服務
- 具聲明式設定的插件系統
- 即時回滾功能：`home-manager switch --rollback`

---

## Nix 模式執行時行為

當 `OPENCLAW_NIX_MODE=1` 被設定（nix-openclaw 會自動設定）：

OpenClaw 支援一種 **Nix 模式**，使設定具決定性並停用自動安裝流程。
可透過匯出以下環境變數啟用：

```bash
OPENCLAW_NIX_MODE=1
```

在 macOS 上，GUI 應用程式不會自動繼承 shell 環境變數。你也可以透過 defaults 啟用 Nix 模式：

```bash
defaults write ai.openclaw.mac openclaw.nixMode -bool true
```

### 設定與狀態路徑

OpenClaw 從 `OPENCLAW_CONFIG_PATH` 讀取 JSON5 設定，並將可變資料儲存在 `OPENCLAW_STATE_DIR`。必要時，你也可以設定 `OPENCLAW_HOME` 來控制用於內部路徑解析的基底家目錄。

- `OPENCLAW_HOME`（預設優先順序：`HOME` / `USERPROFILE` / `os.homedir()`）
- `OPENCLAW_STATE_DIR`（預設：`~/.openclaw`）
- `OPENCLAW_CONFIG_PATH`（預設：`$OPENCLAW_STATE_DIR/openclaw.json`）

在 Nix 環境下執行時，請明確設定這些為 Nix 管理的位置，以確保執行時狀態和設定不會存放在不可變的儲存區。

### Nix 模式下的執行行為

- 自動安裝與自我變更流程被停用
- 缺少的相依性會顯示 Nix 專屬的修復訊息
- UI 會顯示唯讀的 Nix 模式橫幅（banner）

## 打包說明（macOS）

macOS 的打包流程預期有一個穩定的 Info.plist 範本，位置為：

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) 會將此範本複製到應用程式包中，並修補動態欄位（bundle ID、版本/建置號、Git SHA、Sparkle 金鑰）。這樣可保持 plist 在 SwiftPM 打包與 Nix 建置時的確定性（不依賴完整的 Xcode 工具鏈）。

## 相關資源

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — 完整安裝指南
- [Wizard](/start/wizard) — 非 Nix CLI 安裝
- [Docker](/install/docker) — 容器化安裝
