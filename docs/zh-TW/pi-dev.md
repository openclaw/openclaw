---
title: Pi Development Workflow
summary: "Developer workflow for Pi integration: build, test, and live validation"
read_when:
  - Working on Pi integration code or tests
  - "Running Pi-specific lint, typecheck, and live test flows"
---

# Pi 開發工作流程

本指南總結了在 OpenClaw 中進行 pi 整合的合理工作流程。

## 型別檢查與程式碼風格檢查

- 型別檢查與建置：`pnpm build`
- 程式碼風格檢查 (Lint)：`pnpm lint`
- 格式檢查：`pnpm format`
- 推送前完整檢查流程：`pnpm lint && pnpm build && pnpm test`

## 執行 Pi 測試

直接使用 Vitest 執行 Pi 專注的測試集：

```bash
pnpm test -- \
  "src/agents/pi-*.test.ts" \
  "src/agents/pi-embedded-*.test.ts" \
  "src/agents/pi-tools*.test.ts" \
  "src/agents/pi-settings.test.ts" \
  "src/agents/pi-tool-definition-adapter*.test.ts" \
  "src/agents/pi-extensions/**/*.test.ts"
```

若要包含 live provider 測試：

```bash
OPENCLAW_LIVE_TEST=1 pnpm test -- src/agents/pi-embedded-runner-extraparams.live.test.ts
```

涵蓋主要的 Pi 單元測試套件：

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## 手動測試

建議流程：

- 以開發模式啟動 gateway：
  - `pnpm gateway:dev`
- 直接觸發 agent：
  - `pnpm openclaw agent --message "Hello" --thinking low`
- 使用 TUI 進行互動式除錯：
  - `pnpm tui`

針對工具呼叫行為，請提示 `read` 或 `exec` 動作，以便觀察工具串流與負載處理。

## 全新重置

狀態資料存放於 OpenClaw 狀態目錄下。預設為 `~/.openclaw`。若設定了 `OPENCLAW_STATE_DIR`，則改用該目錄。

要重置所有內容：

- `openclaw.json` 用於設定檔
- `credentials/` 用於認證設定檔與 token
- `agents/<agentId>/sessions/` 用於代理程式的會話歷史
- `agents/<agentId>/sessions.json` 用於會話索引
- `sessions/` 若存在舊版路徑
- `workspace/` 若你想要一個空白工作區

若只想重置會話，刪除該代理程式的 `agents/<agentId>/sessions/` 和 `agents/<agentId>/sessions.json`。若不想重新認證，請保留 `credentials/`。

## 參考資料

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
