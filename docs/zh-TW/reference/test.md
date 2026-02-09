---
summary: "如何在本機執行測試（Vitest）以及何時使用強制／涵蓋率模式"
read_when:
  - 執行或修復測試時
title: "測試"
---

# 測試

- 完整測試套件（測試組、即時、Docker）：[Testing](/help/testing)

- `pnpm test:force`：終止任何佔用預設控制連接埠的殘留 Gateway 閘道器 程序，然後以隔離的 Gateway 閘道器 連接埠執行完整的 Vitest 測試套件，避免伺服器測試與執行中的實例發生衝突。當先前的 Gateway 閘道器 執行導致連接埠 18789 被佔用時使用。 Use this when a prior gateway run left port 18789 occupied.

- `pnpm test:coverage`：以 V8 涵蓋率執行 Vitest。全域門檻為行數／分支／函式／陳述式 70%。涵蓋率會排除整合性較高的進入點（CLI 連線配置、gateway/telegram 橋接、webchat 靜態伺服器），以將目標聚焦於可進行單元測試的邏輯。 Global thresholds are 70% lines/branches/functions/statements. 為了讓目標聚焦於可進行單元測試的邏輯，覆蓋範圍不包含整合度高的進入點（CLI 佈線、gateway/telegram 橋接、webchat 靜態伺服器）。

- `pnpm test:e2e`：執行 Gateway 閘道器 端到端煙霧測試（多實例 WS／HTTP／節點配對）。

- `pnpm test:live`：執行提供者即時測試（minimax／zai）。需要 API 金鑰，並且需要 `LIVE=1`（或提供者特定的 `*_LIVE_TEST=1`）才能解除略過。 Requires API keys and `LIVE=1` (or provider-specific `*_LIVE_TEST=1`) to unskip.

## 模型延遲基準測試（本機金鑰）

腳本：[`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

用法：

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- 可選的環境變數：`MINIMAX_API_KEY`、`MINIMAX_BASE_URL`、`MINIMAX_MODEL`、`ANTHROPIC_API_KEY`
- Default prompt: “Reply with a single word: ok. No punctuation or extra text.”

最近一次執行（2025-12-31，20 次）：

- minimax 中位數 1279ms（最小 1114，最大 2431）
- opus 中位數 2454ms（最小 1224，最大 3170）

## 入門引導 E2E（Docker）

Docker 為選用；僅在需要容器化的入門引導煙霧測試時才需要。

在乾淨的 Linux 容器中完成完整的冷啟動流程：

```bash
scripts/e2e/onboard-docker.sh
```

This script drives the interactive wizard via a pseudo-tty, verifies config/workspace/session files, then starts the gateway and runs `openclaw health`.

## QR 匯入煙霧測試（Docker）

確保 `qrcode-terminal` 能在 Docker 中於 Node 22+ 下載入：

```bash
pnpm test:docker:qr
```
