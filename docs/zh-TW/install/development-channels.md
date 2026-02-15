---
summary: "穩定版、測試版（beta）與開發版（dev）頻道：語義、切換與標記"
read_when:
  - 您想要在穩定版/測試版/開發版之間切換
  - 您正在標記或發布預覽版本
title: "開發頻道"
---

# 開發頻道

最後更新：2026-01-21

OpenClaw 提供三個更新頻道：

- **stable** (穩定版)：npm dist-tag 為 `latest`。
- **beta** (測試版)：npm dist-tag 為 `beta`（測試中的組建）。
- **dev** (開發版)：`main` 分支（git）的最新狀態。發布時的 npm dist-tag 為 `dev`。

我們將組建發布至 **beta**，進行測試，然後**將經過驗證的組建提升為 `latest`** 而不變更版本號 —— dist-tags 是 npm 安裝的唯一真實來源。

## 切換頻道

Git 檢出：

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` 會檢出最新的對應標籤（通常是同一個標籤）。
- `dev` 會切換到 `main` 並對上游進行 rebase。

npm/pnpm 全域安裝：

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

這會透過對應的 npm dist-tag（`latest`、`beta`、`dev`）進行更新。

當您使用 `--channel` **明確地**切換頻道時，OpenClaw 也會同步安裝方式：

- `dev` 會確保使用 git 檢出（預設為 `~/openclaw`，可透過 `OPENCLAW_GIT_DIR` 覆蓋），更新該檢出內容，並從中安裝全域 CLI。
- `stable`/`beta` 則會使用對應的 dist-tag 從 npm 安裝。

提示：如果您想同時擁有穩定版與開發版，請保留兩個複製本（clones），並將您的 Gateway 指向穩定版。

## 外掛程式與頻道

當您使用 `openclaw update` 切換頻道時，OpenClaw 也會同步外掛程式來源：

- `dev` 優先使用來自 git 檢出的隨附外掛程式。
- `stable` 與 `beta` 則會還原成透過 npm 安裝的外掛程式套件。

## 標記最佳實踐

- 為您希望 git 檢出定位的發布版本加上標籤（例如 `vYYYY.M.D` 或 `vYYYY.M.D-<patch>`）。
- 保持標籤不可變：切勿移動或重複使用標籤。
- npm dist-tags 仍然是 npm 安裝的唯一真實來源：
  - `latest` → 穩定版 (stable)
  - `beta` → 候選組建 (candidate build)
  - `dev` → main 快照（選填）

## macOS 應用程式可用性

測試版與開發版組建可能**不**包含 macOS 應用程式的發布。這沒關係：

- Git 標籤與 npm dist-tag 仍可發布。
- 在版本說明或變更日誌中註明「此測試版不提供 macOS 組建」。
