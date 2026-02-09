---
title: "Pi 開發工作流程"
---

# Pi 開發工作流程

本指南總結了在 OpenClaw 中進行 Pi 整合時一個合理的工作流程。

## Type Checking and Linting

- 型別檢查與建置：`pnpm build`
- Lint: `pnpm lint`
- 格式檢查：`pnpm format`
- 推送前的完整關卡：`pnpm lint && pnpm build && pnpm test`

## 執行 Pi 測試

使用專用的指令碼來執行 Pi 整合測試集：

```bash
scripts/pi/run-tests.sh
```

To include the live test that exercises real provider behavior:

```bash
scripts/pi/run-tests.sh --live
```

該指令碼會透過以下這些 glob 執行所有與 Pi 相關的單元測試：

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## 手動測試

建議流程：

- 以開發模式執行 Gateway 閘道器：
  - `pnpm gateway:dev`
- 直接觸發代理程式：
  - `pnpm openclaw agent --message "Hello" --thinking low`
- 使用 TUI 進行互動式除錯：
  - `pnpm tui`

針對工具呼叫行為，請提示一個 `read` 或 `exec` 動作，以便查看工具串流與承載資料的處理。

## Clean Slate Reset

State lives under the OpenClaw state directory. Default is `~/.openclaw`. 若已設定 `OPENCLAW_STATE_DIR`，則改用該目錄。

要重設所有內容：

- `openclaw.json` 用於設定
- `credentials/` 用於驗證設定檔與權杖
- `agents/<agentId>/sessions/` 用於代理程式工作階段歷史
- `agents/<agentId>/sessions.json` 用於工作階段索引
- `sessions/` 若存在舊版路徑
- `workspace/` 若你想要一個空白的工作區

如果你只想重設工作階段，請刪除該代理程式的 `agents/<agentId>/sessions/` 與 `agents/<agentId>/sessions.json`。若不想重新進行身分驗證，請保留 `credentials/`。 Keep `credentials/` if you do not want to reauthenticate.

## 參考資料

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
