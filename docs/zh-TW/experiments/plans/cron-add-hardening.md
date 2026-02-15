---
summary: "強化 cron.add 輸入處理、對齊 schema 並改進 cron UI 與智慧代理工具"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Cron Add 強化"
---

# Cron Add 強化與 Schema 對齊

## 背景

最近的 Gateway 記錄顯示 `cron.add` 因無效參數（缺少 `sessionTarget`、`wakeMode`、`payload` 以及格式錯誤的 `schedule`）而重複失敗。這表示至少有一個用戶端（可能是智慧代理工具呼叫路徑）正在傳送經封裝或僅部分指定的任務酬載。此外，TypeScript、Gateway schema、CLI 旗標與 UI 表單類型中的 cron 供應商列舉（enums）之間存在差異，且 `cron.status` 的 UI 存在不匹配情形（預期為 `jobCount`，但 Gateway 回傳 `jobs`）。

## 目標

- 透過標準化常見的封裝酬載並推斷缺少的 `kind` 欄位，來停止 `cron.add` 的 INVALID_REQUEST 垃圾訊息。
- 對齊 Gateway schema、cron 類型、CLI 文件與 UI 表單中的 cron 供應商列表。
- 明確化智慧代理 cron 工具的 schema，使 LLM 能產生正確的任務酬載。
- 修復 Control UI cron 狀態的任務數量顯示。
- 增加測試以涵蓋標準化與工具行為。

## 非目標

- 更改 cron 排程語義或任務執行行為。
- 增加新的排程種類或 cron 表達式解析。
- 除了必要的欄位修復外，不對 cron 的 UI/UX 進行大改。

## 發現（當前差距）

- Gateway 中的 `CronPayloadSchema` 排除 `signal` + `imessage`，但 TS 類型卻包含它們。
- Control UI CronStatus 預期為 `jobCount`，但 Gateway 回傳 `jobs`。
- 智慧代理 cron 工具 schema 允許任意的 `job` 物件，導致輸入格式錯誤。
- Gateway 嚴格驗證 `cron.add` 且無標準化處理，導致經封裝的酬載失敗。

## 變更內容

- `cron.add` 與 `cron.update` 現在會標準化常見的封裝形式，並在安全的情況下推斷缺少的 `kind` 欄位。
- 智慧代理 cron 工具 schema 已與 Gateway schema 匹配，減少了無效酬載。
- 供應商列舉在 Gateway、CLI、UI 與 macOS 選擇器中已達成對齊。
- Control UI 現在使用 Gateway 的 `jobs` 計數欄位來顯示狀態。

## 當前行為

- **標準化：** 封裝的 `data`/`job` 酬載會被拆封；`schedule.kind` 與 `payload.kind` 會在安全的情況下進行推斷。
- **預設值：** 缺失時會套用 `wakeMode` 與 `sessionTarget` 的安全預設值。
- **供應商：** Discord/Slack/Signal/iMessage 現在一致地出現在 CLI/UI 中。

請參閱 [Cron 任務](/automation/cron-jobs) 以了解標準化後的格式與範例。

## 驗證

- 觀察 Gateway 記錄，確認 `cron.add` 的 INVALID_REQUEST 錯誤是否減少。
- 重新整理後確認 Control UI cron 狀態顯示任務數量。

## 選用後續工作

- 手動 Control UI 冒煙測試：為每個供應商新增一個 cron 任務並驗證狀態的任務數量。

## 開放性問題

- `cron.add` 是否應接受來自用戶端的明確 `state`（目前 schema 不允許）？
- 我們是否應允許 `webchat` 作為明確的傳遞供應商（目前在傳遞解析中被過濾）？
