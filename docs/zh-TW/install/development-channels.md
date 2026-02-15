---
summary: "穩定、測試版和開發版頻道：語義、切換和標記"
read_when:
  - 您想在穩定版/測試版/開發版之間切換時
  - 您正在標記或發布預發行版時
title: "開發頻道"
---

# 開發頻道

最後更新：2026-01-21

OpenClaw 提供三種更新頻道：

- **穩定版**：npm dist-tag `latest`。
- **測試版**：npm dist-tag `beta` (正在測試中的建構版本)。
- **開發版**：`main` 分支的最新版本 (git)。npm dist-tag: `dev` (發布時)。

我們將建構版本發布到 **測試版**，進行測試，然後將 **經過驗證的建構版本提升為 `latest`**，而不更改版本號——dist-tag 是 npm 安裝的真實來源。

## 切換頻道

Git 檢查出：

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `穩定版`/`測試版` 檢查出最新匹配的標籤 (通常是相同的標籤)。
- `開發版` 切換到 `main` 並在上游進行變基。

npm/pnpm 全域安裝：

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

這會透過對應的 npm dist-tag (`latest`、`beta`、`dev`) 進行更新。

當您使用 `--channel` **明確地** 切換頻道時，OpenClaw 也會對齊安裝方法：

- `開發版` 確保 git 檢查出 (預設 `~/openclaw`，可使用 `OPENCLAW_GIT_DIR` 覆寫)，更新它，並從該檢查出安裝全域 CLI。
- `穩定版`/`測試版` 使用匹配的 dist-tag 從 npm 安裝。

提示：如果您想同時使用穩定版 + 開發版，請保留兩個複製並將您的 Gateway 指向穩定版。

## 插件與頻道

當您使用 `openclaw update` 切換頻道時，OpenClaw 也會同步插件來源：

- `開發版` 優先使用來自 git 檢查出的捆綁插件。
- `穩定版` 和 `測試版` 恢復 npm 安裝的插件包。

## 標記最佳實踐

- 標記您希望 git 檢查出所指向的版本 (`vYYYY.M.D` 或 `vYYYY.M.D-<patch>`)。
- 保持標籤不可變：切勿移動或重複使用標籤。
- npm dist-tag 仍然是 npm 安裝的真實來源：
  - `latest` → 穩定版
  - `beta` → 候選建構版本
  - `dev` → main 快照 (選用)

## macOS 應用程式可用性

測試版和開發版建構版本可能**不**包含 macOS 應用程式發布。這沒關係：

- git 標籤和 npm dist-tag 仍然可以發布。
- 在發布說明或變更日誌中指出「此測試版沒有 macOS 建構版本」。
