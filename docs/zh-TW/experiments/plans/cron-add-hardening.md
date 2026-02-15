---
summary: "強化 cron.add 輸入處理、對齊架構，並改進 cron UI/智慧代理工具"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Cron Add 強化"
---

# Cron Add 強化與架構對齊

## 背景

最近的 Gateway 紀錄顯示，`cron.add` 重複出現因無效參數（缺少 `sessionTarget`、`wakeMode`、`payload` 和格式錯誤的 `schedule`）導致的失敗。這表示至少一個客戶端（可能是智慧代理工具呼叫路徑）正在傳送經過包裝或部分指定的排程工作酬載。此外，TypeScript 中的 cron 供應商列舉、Gateway 架構、CLI 旗標和 UI 表單類型之間存在差異，且 `cron.status` 的 UI 不匹配（預期 `jobCount`，而 Gateway 返回 `jobs`）。

## 目標

- 透過正規化常見的包裝酬載並推斷缺失的 `kind` 欄位，停止 `cron.add` INVALID_REQUEST 的訊息氾濫。
- 在 Gateway 架構、cron 類型、CLI 文件和 UI 表單之間對齊 cron 供應商列表。
- 使智慧代理 cron 工具架構明確，以便 LLM 產生正確的工作酬載。
- 修復控制台 UI cron 狀態的工作計數顯示。
- 新增測試以涵蓋正規化和工具行為。

## 非目標

- 更改 cron 排程語義或工作執行行為。
- 新增排程種類或 cron 表達式解析。
- 除了必要的欄位修復外，全面改革 cron 的 UI/UX。

## 發現（當前差距）

- Gateway 中的 `CronPayloadSchema` 不包含 `signal` + `imessage`，而 TS 類型包含它們。
- 控制台 UI CronStatus 預期 `jobCount`，但 Gateway 返回 `jobs`。
- 智慧代理 cron 工具架構允許任意 `job` 物件，導致輸入格式錯誤。
- Gateway 嚴格驗證 `cron.add`，不進行正規化，因此包裝的酬載會失敗。

## 變更內容

- `cron.add` 和 `cron.update` 現在會正規化常見的包裝形式並推斷缺失的 `kind` 欄位。
- 智慧代理 cron 工具架構與 Gateway 架構匹配，從而減少無效酬載。
- 供應商列舉在 Gateway、CLI、UI 和 macOS 選取器之間保持一致。
- 控制台 UI 使用 Gateway 的 `jobs` 計數欄位來顯示狀態。

請參閱 [Cron 工作](/automation/cron-jobs) 以了解正規化後的格式和範例。

## 驗證

- 觀察 Gateway 紀錄，確認 `cron.add` INVALID_REQUEST 錯誤已減少。
- 確認重新整理後，控制台 UI cron 狀態顯示工作計數。

## 可選的後續行動

- 手動控制台 UI 冒煙測試：為每個供應商新增一個 cron 工作 + 驗證狀態工作計數。

## 待解決問題

- `cron.add` 是否應接受來自客戶端的明確 `state`（目前架構不允許）？
- 我們是否應允許 `webchat` 作為明確的傳送供應商（目前在傳送解析中被過濾）？
