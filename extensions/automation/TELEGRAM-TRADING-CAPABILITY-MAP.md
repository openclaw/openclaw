# Telegram 交易中控台：一次性功能盤點與製作清單

> 目標：把 OpenClaw Telegram 交易操作做成可用中控入口（先 paper-only，真單保持封鎖）。
> 範圍：`/quote`、`/capital_status` 指令、Capital 交易腳本、SEMI 審查鏈路、報價/風控回報。

## 1) 目前已具備功能（As-Is）

1. `/quote` Telegram 原生指令已註冊，並可在聊天室直接觸發。
2. `/quote status` 可輸出即時/封鎖狀態、freshness、風控封鎖訊息。
3. `/quote telegram` 可輸出 Telegram 單一入口自檢狀態。
4. `/quote simlive ...` 可走模擬真單（paper-only），明確 `sentOrder=false`。
5. 報價回覆與模擬真單回覆都走 JSON 產生器，具可檢測輸出狀態。
6. `/capital_status` 可彙總「報價 / 下單 / 回報 / 查詢」總狀態與下一步建議。

## 2) 應該要有的功能（To-Be）

1. Telegram 內要有交易中控按鈕，不只純文字回覆。
2. 要能在 Telegram 直接進入 SEMI 審查流程（查看/確認/拒絕）。
3. 每個按鈕都要可追溯到可驗證腳本與狀態檔，避免「按了沒動作」。
4. 風控邏輯要固定：任何流程都不得開啟 live trading 或 broker write。
5. 交易控制面可見文案（按鈕、總狀態回覆）要統一中文，避免混雜英文狀態字。

## 3) 缺少功能（Gap）

1. `/quote` 按鈕先前缺少 SEMI 審查/確認/拒絕入口。
2. `openclaw-capital-quote-telegram-reply` 先前沒有處理 `semi` 類查詢。
3. Telegram 點擊後雖能跑模擬下單，但缺少「SEMI callback 寫入 reviewChecklist」的入口閉環。
4. 交易按鈕與狀態回覆曾混用英文（如 READY/BLOCKED、paper-only），閱讀門檻高。

## 4) 本輪已完成製作（Closed in this task）

1. `/quote` 按鈕升級為交易中控按鈕：
   - 刷新報價
   - 入口自檢
   - 模擬買 / 模擬賣
   - SEMI 審查 / SEMI 確認 / SEMI 拒絕
   - 台指近快捷查詢
2. 新增 `/capital_status` 指令（交易總狀態）：
   - 合併 `openclaw-capital-service-status` + `openclaw-capital-master-flow-checklist`
   - 單一回覆顯示：報價 / 下單 / 回報 / 查詢 + 下一步
3. 交易可見文案中文化：
   - 按鈕文案改為全中文
   - `/capital_status` 回覆中的狀態字改為「正常 / 部分 / 阻擋 / 未完成 / 封鎖」
   - `paper-only` 改為「僅紙上模擬」
4. `openclaw-capital-quote-telegram-reply.mjs` 新增 `semi` 查詢分流：
   - `semi` -> `openclaw-capital-telegram-semi-approval-gate`
   - `semi approve|reject|refresh` -> `openclaw-capital-telegram-semi-approval-callback`
5. 保持風控封鎖：
   - `humanApproved` 不會被設定為 `true`
   - `allowLiveTrading=false`
   - `writeBrokerOrders=false`
   - `sentOrder=false`

## 5) 下一輪最小安全任務（單一 TASK）

把 `capital_semi_*` callback token 接到 Telegram callback handler（`extensions/telegram/src/bot-handlers.runtime.ts`），讓按鈕能以 token 直接回寫對應 `reviewChecklist`，並回覆全中文固定格式狀態訊息。

## 6) 驗證命令

```bash
pnpm capital:telegram:quote-command:check
pnpm capital:telegram:simulated-live:check
pnpm capital:telegram:semi-approval:check
pnpm capital:telegram:semi-callback:check
```
