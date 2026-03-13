---
summary: "Stable, beta, and dev channels: semantics, switching, and tagging"
read_when:
  - You want to switch between stable/beta/dev
  - You are tagging or publishing prereleases
title: Development Channels
---

# 開發頻道

最後更新：2026-01-21

OpenClaw 提供三個更新頻道：

- **stable**：npm dist-tag `latest`。
- **beta**：npm dist-tag `beta`（測試中的版本）。
- **dev**：`main`（git）上的最新版本。npm dist-tag：`dev`（發布時）。

我們會先將版本發佈到 **beta**，進行測試，然後將經過驗證的版本**升級到 `latest`**，版本號不變 — dist-tag 是 npm 安裝的唯一依據。

## 切換頻道

Git 切換指令：

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` 會檢出最新的對應標籤（通常是相同標籤）。
- `dev` 會切換到 `main` 並基底重置（rebase）到上游。

npm/pnpm 全域安裝：

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

這會根據對應的 npm dist-tag（`latest`、`beta`、`dev`）進行更新。

當你**明確**使用 `--channel` 切換頻道時，OpenClaw 也會同步調整安裝方式：

- `dev` 確保執行 git checkout（預設為 `~/openclaw`，可用 `OPENCLAW_GIT_DIR` 覆寫），
  並更新後從該 checkout 安裝全域 CLI。
- `stable`/`beta` 則是從 npm 使用對應的 dist-tag 安裝。

小提示：如果你想同時使用 stable 和 dev，建議保留兩個 git clone，並將你的 gateway 指向 stable 的版本。

## 插件與頻道

當你使用 `openclaw update` 切換頻道時，OpenClaw 也會同步插件來源：

- `dev` 偏好使用 git 取出的內建插件。
- `stable` 和 `beta` 則會還原 npm 安裝的插件套件。

## 標籤最佳實踐

- 為你希望 git 取出版本對應的發行版本打標籤（`vYYYY.M.D` 用於穩定版，`vYYYY.M.D-beta.N` 用於測試版）。
- `vYYYY.M.D.beta.N` 也被識別為相容標籤，但建議優先使用 `-beta.N`。
- 舊有的 `vYYYY.M.D-<patch>` 標籤仍被視為穩定版（非測試版）。
- 標籤應保持不變：絕不可移動或重複使用標籤。
- npm dist-tags 仍是 npm 安裝的權威來源：
  - `latest` → 穩定版
  - `beta` → 候選版本
  - `dev` → 主快照（可選）

## macOS 應用程式可用性

測試版與開發版可能**不包含** macOS 應用程式發行版本。這是正常的：

- git 標籤與 npm dist-tag 仍可發布。
- 在發行說明或更新日誌中註明「此測試版無 macOS 建置」。
