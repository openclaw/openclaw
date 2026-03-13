---
summary: How to run tests locally (vitest) and when to use force/coverage modes
read_when:
  - Running or fixing tests
title: Tests
---

# 測試

- 完整測試套件（套件、實時、Docker）：[Testing](/help/testing)

- `pnpm test:force`：終止任何佔用預設控制埠的殘留 gateway 進程，然後使用獨立的 gateway 埠執行完整的 Vitest 套件，避免伺服器測試與正在執行的實例衝突。當先前的 gateway 執行導致埠 18789 被佔用時使用此命令。
- `pnpm test:coverage`：使用 V8 覆蓋率（透過 `vitest.unit.config.ts`）執行單元測試套件。全域門檻為 70% 的行數/分支/函式/語句覆蓋率。覆蓋率排除整合度高的入口點（CLI 連接、gateway/telegram 橋接、webchat 靜態伺服器），以保持目標聚焦於可單元測試的邏輯。
- `pnpm test` 在 Node 24+ 上：OpenClaw 會自動停用 Vitest `vmForks`，並使用 `forks` 以避免 `ERR_VM_MODULE_LINK_FAILURE` / `module is already linked`。你可以透過 `OPENCLAW_TEST_VM_FORKS=0|1` 強制指定行為。
- `pnpm test`：預設執行快速核心單元測試路線，以便快速本地回饋。
- `pnpm test:channels`：執行以頻道為主的測試套件。
- `pnpm test:extensions`：執行擴充功能/插件測試套件。
- Gateway 整合：可透過 `OPENCLAW_TEST_INCLUDE_GATEWAY=1 pnpm test` 或 `pnpm test:gateway` 選擇性啟用。
- `pnpm test:e2e`：執行 gateway 端對端冒煙測試（多實例 WS/HTTP/節點配對）。預設使用 `vmForks` + `vitest.e2e.config.ts` 中的自適應工作者；可透過 `OPENCLAW_E2E_WORKERS=<n>` 調整，並設定 `OPENCLAW_E2E_VERBOSE=1` 以取得詳細日誌。
- `pnpm test:live`：執行提供者實時測試（minimax/zai）。需要 API 金鑰及 `LIVE=1`（或提供者專用的 `*_LIVE_TEST=1`）以取消跳過。

## 本地 PR 門檻

本地 PR 合併/門檻檢查，請執行：

- `pnpm check`
- `pnpm build`
- `pnpm test`
- `pnpm check:docs`

若 `pnpm test` 在負載較高的主機上不穩定，請先重新執行一次，再視為回歸，然後使用 `pnpm vitest run <path/to/test>` 進行隔離。對於記憶體受限的主機，請使用：

- `OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test`

## 模型延遲基準測試（本地金鑰）

腳本：[`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

使用方式：

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- 可選環境變數：`MINIMAX_API_KEY`、`MINIMAX_BASE_URL`、`MINIMAX_MODEL`、`ANTHROPIC_API_KEY`
- 預設提示語：「請用一個字回覆：ok。不要標點符號或額外文字。」

最近執行（2025-12-31，20 次）：

- minimax 中位數 1279ms（最短 1114，最長 2431）
- opus 中位數 2454ms（最短 1224，最長 3170）

## CLI 啟動基準測試

Script: [`scripts/bench-cli-startup.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-cli-startup.ts)

用法：

- `pnpm tsx scripts/bench-cli-startup.ts`
- `pnpm tsx scripts/bench-cli-startup.ts --runs 12`
- `pnpm tsx scripts/bench-cli-startup.ts --entry dist/entry.js --timeout-ms 45000`

此腳本基準測試以下指令：

- `--version`
- `--help`
- `health --json`
- `status --json`
- `status`

輸出包含每個指令的平均值、p50、p95、最小/最大值，以及退出碼/訊號分佈。

## 新手引導端對端測試（Docker）

Docker 是可選的；僅在容器化的新手引導冒煙測試中需要使用。

在乾淨的 Linux 容器中執行完整冷啟動流程：

```bash
scripts/e2e/onboard-docker.sh
```

此腳本透過偽終端驅動互動式精靈，驗證設定/工作區/會話檔案，然後啟動閘道並執行 `openclaw health`。

## QR 匯入冒煙測試（Docker）

確保 `qrcode-terminal` 能在支援的 Docker Node 執行環境下載入（預設 Node 24，兼容 Node 22）：

```bash
pnpm test:docker:qr
```
