---
summary: "npm dist-tag：`dev`（發佈時）。"
read_when:
  - 你想在 stable／beta／dev 之間切換
  - 你正在為 prerelease 進行標記或發佈
title: "開發通道"
---

# 開發通道

最後更新：2026-01-21

OpenClaw 提供三種更新通道：

- **stable**：npm dist-tag `latest`。
- **beta**：npm dist-tag `beta`（測試中的建置）。
- **dev**：`main`（git）的持續前進頭；npm dist-tag：`dev`（發佈時）。 外掛與頻道

我們會先將建置發佈到 **beta**、進行測試，然後**將經審核的建置提升為 `latest`**，
而不變更版本號 —— dist-tag 是 npm 安裝時的權威來源。

## 切換通道

Git 檢出：

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` 會檢出最新且符合的標記（通常是同一個標記）。
- `dev` 會切換到 `main`，並在上游基礎上 rebase。

npm／pnpm 全域安裝：

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

這會透過對應的 npm dist-tag 更新（`latest`、`beta`、`dev`）。

當你**明確**使用 `--channel` 切換通道時，OpenClaw 也會同步調整安裝方式：

- `dev` 會確保使用 git 檢出（預設 `~/openclaw`，可用 `OPENCLAW_GIT_DIR` 覆寫），
  更新後並從該檢出安裝全域 CLI。
- `stable`/`beta` 會使用相符的 dist-tag 從 npm 安裝。

提示：如果你想同時使用 stable 與 dev，請保留兩個 clone，並將 Gateway 閘道器 指向 stable 的那一個。

## 外掛與通道

當你使用 `openclaw update` 切換通道時，OpenClaw 也會同步外掛來源：

- 標記最佳實務
- `stable` 與 `beta` 會還原以 npm 安裝的外掛套件。

## 標記最佳實務

- 為你希望 git 檢出落點的版本加上標記（`vYYYY.M.D` 或 `vYYYY.M.D-<patch>`）。
- 保持標記不可變：不要移動或重複使用標記。
- npm dist-tag 仍是 npm 安裝的權威來源：
  - `latest` → stable
  - `beta` → 候選建置
  - `dev` → main 快照（選用）

## macOS App 可用性

Beta 與 dev 建置**可能**不包含 macOS App 發佈。這是可以接受的： Docker 是 **選用** 的。

- 仍可發佈 git 標記與 npm dist-tag。
- 請在發佈說明或變更紀錄中註明「此 beta 無 macOS 建置」。
