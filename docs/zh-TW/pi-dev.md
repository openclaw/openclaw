---
title: "Pi 開發工作流程"
---

# Pi 開發工作流程

本指南總結了在 OpenClaw 中進行 Pi 整合開發的合理工作流程。

## 型別檢查與 Linting

- 型別檢查與建置：`pnpm build`
- Lint：`pnpm lint`
- 格式檢查：`pnpm format`
- 推送前的完整檢查：`pnpm lint && pnpm build && pnpm test`

## 執行 Pi 測試

使用 Pi 整合測試集的專用指令稿：

```bash
scripts/pi/run-tests.sh
```

若要包含測試真實供應商行為的即時測試 (live test)：

```bash
scripts/pi/run-tests.sh --live
```

該指令稿透過以下 glob 模式執行所有與 Pi 相關的單元測試：

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## 手動測試

建議流程：

- 以開發模式執行 Gateway：
  - `pnpm gateway:dev`
- 直接觸發智慧代理：
  - `pnpm openclaw agent --message "Hello" --thinking low`
- 使用 TUI 進行互動式除錯：
  - `pnpm tui`

針對工具呼叫行為，請提示進行 `read` 或 `exec` 動作，以便查看工具串流與酬載 (payload) 處理。

## 乾淨重設

狀態儲存在 OpenClaw 狀態目錄下。預設為 `~/.openclaw`。如果設定了 `OPENCLAW_STATE_DIR`，則改用該目錄。

若要重設所有內容：

- `openclaw.json` 用於設定
- `credentials/` 用於身份驗證設定檔與權杖
- `agents/<agentId>/sessions/` 用於智慧代理工作階段紀錄
- `agents/<agentId>/sessions.json` 用於工作階段索引
- `sessions/` 如果存在舊路徑
- `workspace/` 如果你想要一個空白的工作區

如果你只想重設工作階段，請刪除該智慧代理的 `agents/<agentId>/sessions/` 與 `agents/<agentId>/sessions.json`。如果你不想重新進行身份驗證，請保留 `credentials/`。

## 參考資料

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
