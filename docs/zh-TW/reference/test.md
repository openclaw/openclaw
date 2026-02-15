---
summary: "如何在本地執行測試 (vitest) 以及何時使用 force/coverage 模式"
read_when:
  - 執行或修復測試時
title: "測試"
---

# 測試

- 完整測試套件 (套件、即時、Docker): [測試](/help/testing)

- `pnpm test:force`: 終止任何殘留的 Gateway 程式佔用預設控制連接埠，然後執行完整的 Vitest 套件，使用獨立的 Gateway 連接埠，這樣伺服器測試就不會與正在運行的實例衝突。當先前的 Gateway 運行導致連接埠 18789 被佔用時使用此功能。
- `pnpm test:coverage`: 使用 V8 覆蓋率運行 Vitest。全域閾值為 70% 的程式碼行/分支/函數/陳述。覆蓋率排除整合密集的入口點（CLI 接線、Gateway/Telegram 橋接、Webchat 靜態伺服器），以使目標專注於可單元測試的邏輯。
- `pnpm test` 在 Node 24+ 上: OpenClaw 會自動停用 Vitest `vmForks` 並使用 `forks` 以避免 `ERR_VM_MODULE_LINK_FAILURE` / `模組已連結`。您可以使用 `OPENCLAW_TEST_VM_FORKS=0|1` 強制執行此行為。
- `pnpm test:e2e`: 運行 Gateway 端對端冒煙測試（多實例 WS/HTTP/node 配對）。在 `vitest.e2e.config.ts` 中預設為 `vmForks` + 自適應工作執行緒；使用 `OPENCLAW_E2E_WORKERS=<n>` 調整並設定 `OPENCLAW_E2E_VERBOSE=1` 以取得詳細記錄。
- `pnpm test:live`: 運行供應商即時測試 (minimax/zai)。需要 API 金鑰和 `LIVE=1`（或特定供應商的 `*_LIVE_TEST=1`）才能取消跳過。

## 模型延遲基準測試 (本地金鑰)

指令稿: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

用法:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- 可選環境變數: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- 預設提示: 「以單詞回覆：ok。不含標點符號或額外文字。」

上次運行 (2025-12-31, 20 次運行):

- minimax 中位數 1279ms (最小 1114, 最大 2431)
- opus 中位數 2454ms (最小 1224, 最大 3170)

## 新手導覽 E2E (Docker)

Docker 是可選的；這僅用於容器化的新手導覽冒煙測試。

在乾淨的 Linux 容器中執行完整的冷啟動流程：

```bash
scripts/e2e/onboard-docker.sh
```

此指令稿透過偽終端機驅動互動式精靈，驗證設定/工作區/工作階段檔案，然後啟動 Gateway 並運行 `openclaw health`。

## QR 匯入冒煙測試 (Docker)

確保 `qrcode-terminal` 在 Docker 中於 Node 22+ 下載入：

```bash
pnpm test:docker:qr
```
