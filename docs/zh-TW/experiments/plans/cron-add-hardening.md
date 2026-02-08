---
summary: 「強化 cron.add 的輸入處理、對齊結構定義，並改善 cron UI／代理程式工具」
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: 「Cron Add 強化」
x-i18n:
  source_path: experiments/plans/cron-add-hardening.md
  source_hash: d7e469674bd9435b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:56Z
---

# Cron Add 強化與結構定義對齊

## 背景

近期的 Gateway 閘道器日誌顯示，因為參數無效（缺少 `sessionTarget`、`wakeMode`、`payload`，以及格式錯誤的 `schedule`）而反覆出現 `cron.add` 失敗。這表示至少有一個用戶端（很可能是代理程式工具呼叫路徑）正在傳送被包裝或僅部分指定的工作負載。另一方面，TypeScript、Gateway 閘道器結構定義、CLI 旗標與 UI 表單型別之間的 cron provider 列舉值出現漂移，此外 UI 在 `cron.status` 上也有不一致（期望 `jobCount`，但 Gateway 閘道器回傳 `jobs`）。

## 目標

- 透過正規化常見的包裝負載並推斷遺漏的 `kind` 欄位，停止 `cron.add` INVALID_REQUEST 垃圾訊息。
- 在 Gateway 閘道器結構定義、cron 型別、CLI 文件與 UI 表單之間對齊 cron provider 清單。
- 讓代理程式 cron 工具的結構定義更明確，使 LLM 能產生正確的工作負載。
- 修正 Control UI 中 cron 狀態的工作數量顯示。
- 新增測試以涵蓋正規化與工具行為。

## 非目標

- 變更 cron 排程語意或工作執行行為。
- 新增新的排程種類或 cron 表達式解析。
- 除必要的欄位修正外，不對 cron 的 UI／UX 進行全面改造。

## 發現（目前缺口）

- Gateway 閘道器中的 `CronPayloadSchema` 排除了 `signal` 與 `imessage`，但 TS 型別包含它們。
- Control UI 的 CronStatus 期望 `jobCount`，但 Gateway 閘道器回傳 `jobs`。
- 代理程式 cron 工具的結構定義允許任意的 `job` 物件，導致可能出現格式錯誤的輸入。
- Gateway 閘道器對 `cron.add` 進行嚴格驗證且沒有正規化，因此被包裝的負載會失敗。

## 變更內容

- `cron.add` 與 `cron.update` 現在會正規化常見的包裝形狀，並推斷遺漏的 `kind` 欄位。
- 代理程式 cron 工具的結構定義已與 Gateway 閘道器結構定義對齊，降低無效負載的發生。
- Provider 列舉值已在 Gateway 閘道器、CLI、UI 與 macOS 選擇器之間完成對齊。
- Control UI 使用 Gateway 閘道器的 `jobs` 計數欄位來顯示狀態。

## 目前行為

- **正規化：** 被包裝的 `data`／`job` 負載會被解包；在安全的情況下會推斷 `schedule.kind` 與 `payload.kind`。
- **預設值：** 當缺少時，會為 `wakeMode` 與 `sessionTarget` 套用安全的預設值。
- **Providers：** Discord／Slack／Signal／iMessage 現在會一致地在 CLI／UI 中呈現。

請參閱 [Cron jobs](/automation/cron-jobs) 以了解正規化後的結構與範例。

## 驗證

- 監看 Gateway 閘道器日誌，確認 `cron.add` INVALID_REQUEST 錯誤減少。
- 重新整理後，確認 Control UI 的 cron 狀態顯示工作數量。

## 可選後續事項

- Control UI 手動冒煙測試：為每個 provider 新增一個 cron 工作，並驗證狀態中的工作數量。

## 未解決問題

- `cron.add` 是否應接受用戶端明確提供的 `state`（目前在結構定義中被禁止）？
- 是否應允許 `webchat` 作為明確的傳遞 provider（目前在傳遞解析中被過濾）？
