---
summary: "如何在本機執行測試 (vitest) 以及何時使用 force/coverage 模式"
read_when:
  - 執行或修復測試時
title: "測試"
---

# 測試

- 完整測試套件 (suites, live, Docker)：[測試](/help/testing)

- `pnpm test:force`：強制結束任何佔用預設控制連接埠的殘留 Gateway 程序，接著使用隔離的 Gateway 連接埠執行完整的 Vitest 套件，以免伺服器測試與正在執行的執行個體衝突。當先前的 Gateway 執行導致連接埠 18789 被佔用時，請使用此命令。
- `pnpm test:coverage`：使用 V8 覆蓋率執行 Vitest。全域門檻值為 70% 行數/分支/函式/陳述句 (lines/branches/functions/statements)。覆蓋率排除高度整合的進入點 (CLI 連接、Gateway/Telegram 橋接、webchat 靜態伺服器)，以確保目標集中在可進行單元測試的邏輯上。
- `pnpm test` 在 Node 24+ 環境：OpenClaw 會自動停用 Vitest 的 `vmForks` 並使用 `forks`，以避免 `ERR_VM_MODULE_LINK_FAILURE` / `module is already linked` 錯誤。你可以透過 `OPENCLAW_TEST_VM_FORKS=0|1` 強制指定行為。
- `pnpm test:e2e`：執行 Gateway 端對端冒煙測試 (多個執行個體 WS/HTTP/節點配對)。預設在 `vitest.e2e.config.ts` 中使用 `vmForks` + 自適應工作執行緒 (workers)；可透過 `OPENCLAW_E2E_WORKERS=<n>` 進行調整，並設定 `OPENCLAW_E2E_VERBOSE=1` 以顯示詳細日誌。
- `pnpm test:live`：執行供應商實測 (minimax/zai)。需要 API 金鑰並設定 `LIVE=1` (或特定供應商的 `*_LIVE_TEST=1`) 才能取消略過。

## 模型延遲基準測試 (本機金鑰)

腳本：[`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

用法：

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- 選用環境變數：`MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- 預設提示詞：“Reply with a single word: ok. No punctuation or extra text.”

最後執行時間 (2025-12-31，執行 20 次)：

- minimax 中位數 1279ms (最小值 1114，最大值 2431)
- opus 中位數 2454ms (最小值 1224，最大值 3170)

## 新手導覽端對端測試 (Docker)

Docker 為選用項目；僅在需要進行容器化的新手導覽冒煙測試時才需要。

在乾淨的 Linux 容器中進行完整的冷啟動流程：

```bash
scripts/e2e/onboard-docker.sh
```

此腳本會透過虛擬終端 (pseudo-tty) 執行互動式精靈，驗證設定/工作空間/工作階段檔案，接著啟動 Gateway 並執行 `openclaw health`。

## QR 匯入冒煙測試 (Docker)

確保 `qrcode-terminal` 在 Docker 中的 Node 22+ 環境下可正常載入：

```bash
pnpm test:docker:qr
```
