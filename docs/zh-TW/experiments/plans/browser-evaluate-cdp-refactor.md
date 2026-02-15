---
summary: "Plan: isolate browser act:evaluate from Playwright queue using CDP, with end-to-end deadlines and safer ref resolution"
owner: "openclaw"
status: "draft"
last_updated: "2026-02-10"
title: "瀏覽器 Evaluate CDP 重構"
---

# 瀏覽器 Evaluate CDP 重構計畫

## 背景

`act:evaluate` 在頁面中執行使用者提供的 JavaScript。目前它透過 Playwright 執行
（`page.evaluate` 或 `locator.evaluate`）。Playwright 會對每個頁面的 CDP 命令進行序列化，因此
一個卡住或長時間運行的 evaluate 可能會阻塞頁面命令佇列，並使該分頁上的每個後續動作都看起來
「卡住」。

PR #13498 增加了一個實用的安全網（有界 evaluate、中止傳播和盡力復原）。
這份文件描述了一個更大的重構，使 `act:evaluate` 固有地與 Playwright 隔離，
這樣一個卡住的 evaluate 就不能阻礙正常的 Playwright 操作。

## 目標

- `act:evaluate` 不能永久阻塞同一分頁上的後續瀏覽器動作。
- 逾時是端到端單一資訊來源，因此呼叫者可以依賴預算。
- 中止和逾時在 HTTP 和程序內分派中被視為相同的方式。
- 在不將所有功能都從 Playwright 切換掉的情況下，支援 evaluate 的元素目標定位。
- 維護現有呼叫者和酬載的向後相容性。

## 非目標

- 用 CDP 實作替換所有瀏覽器動作（點擊、輸入、等待等）。
- 移除 PR #13498 中引入的現有安全網（它仍然是有用的備用方案）。
- 引入超出現有 `browser.evaluateEnabled` 閘門的新不安全功能。
- 為 evaluate 增加程序隔離（Worker 程序/執行緒）。如果我們在此次重構後仍然看到難以復原的
  卡住狀態，那將是一個後續的想法。

## 現有架構 (為何會卡住)

概括來說：

- 呼叫者將 `act:evaluate` 發送到瀏覽器控制服務。
- 路由處理程序呼叫 Playwright 執行 JavaScript。
- Playwright 序列化頁面命令，因此一個永遠不會完成的 evaluate 會阻塞佇列。
- 卡住的佇列意味著該分頁上的後續點擊/輸入/等待操作可能會出現停滯。

## 建議架構

### 1. 期限傳播

引入單一預算概念並從中推導一切：

- 呼叫者設定 `timeoutMs`（或未來的期限）。
- 外部請求逾時、路由處理程序邏輯以及頁面內部的執行預算
  都使用相同的預算，在需要時為序列化開銷預留少量餘裕。
- 中止作為 `AbortSignal` 傳播到所有地方，以確保取消的一致性。

實作方向：

- 增加一個小型輔助函式（例如 `createBudget({ timeoutMs, signal })`），它返回：
  - `signal`：連結的 AbortSignal
  - `deadlineAtMs`：絕對期限
  - `remainingMs()`：子操作的剩餘預算
- 在以下地方使用此輔助函式：
  - `src/browser/client-fetch.ts` (HTTP 和程序內分派)
  - `src/node-host/runner.ts` (代理路徑)
  - 瀏覽器動作實作（Playwright 和 CDP）

### 2. 獨立的 Evaluate 引擎 (CDP 路徑)

增加一個基於 CDP 的 evaluate 實作，它不與 Playwright 的每個頁面命令佇列共享。
關鍵特性是 evaluate 傳輸是一個獨立的 WebSocket 連線
和一個附加到目標的獨立 CDP 工作階段。

實作方向：

- 新模組，例如 `src/browser/cdp-evaluate.ts`，它：
  - 連接到已設定的 CDP 端點（瀏覽器級別 Socket）。
  - 使用 `Target.attachToTarget({ targetId, flatten: true })` 取得 `sessionId`。
  - 執行以下其中一個：
    - `Runtime.evaluate` 用於頁面級別 evaluate，或
    - `DOM.resolveNode` 加上 `Runtime.callFunctionOn` 用於元素 evaluate。
  - 在逾時或中止時：
    - 盡力為該工作階段發送 `Runtime.terminateExecution`。
    - 關閉 WebSocket 並返回明確的錯誤。

注意事項：

- 這仍然會在頁面中執行 JavaScript，因此終止可能會產生副作用。優點
  是它不會阻礙 Playwright 佇列，並且可以透過終止 CDP 工作階段在傳輸
  層取消。

### 3. Ref 處理 (無需全面重寫即可實現元素目標定位)

困難的部分是元素目標定位。CDP 需要 DOM 句柄或 `backendDOMNodeId`，而
目前大多數瀏覽器動作都使用基於快照中 ref 的 Playwright 定位器。

建議的方法：保留現有 ref，但附加一個可選的 CDP 可解析 ID。

#### 3.1 擴展儲存的 Ref 資訊

擴展儲存的角色 ref 中繼資料以可選地包含 CDP ID：

- 目前：`{ role, name, nth }`
- 建議：`{ role, name, nth, backendDOMNodeId?: number }`

這使得所有現有基於 Playwright 的動作都能正常工作，並允許 CDP evaluate 接受
當 `backendDOMNodeId` 可用時的相同 `ref` 值。

#### 3.2 在快照建立時填充 backendDOMNodeId

產生角色快照時：

1. 像現在一樣產生現有的角色 ref 對應 (role, name, nth)。
2. 透過 CDP (`Accessibility.getFullAXTree`) 擷取 AX 樹，並使用相同的重複處理規則
   計算`(role, name, nth) -> backendDOMNodeId`的平行對應。
3. 將 ID 合併回當前分頁的儲存 ref 資訊中。

如果 ref 的對應失敗，則將 `backendDOMNodeId` 設為 undefined。這使得該功能
盡力而為並安全地推出。

#### 3.3 具有 Ref 的 Evaluate 行為

在 `act:evaluate` 中：

- 如果存在 `ref` 且具有 `backendDOMNodeId`，則透過 CDP 執行元素 evaluate。
- 如果存在 `ref` 但沒有 `backendDOMNodeId`，則回退到 Playwright 路徑（帶有
  安全網）。

可選的逃生通道：

- 擴展請求結構以直接接受 `backendDOMNodeId`，供進階呼叫者使用（以及
  用於偵錯），同時保留 `ref` 作為主要介面。

### 4. 保留最後一招的復原路徑

即使使用 CDP evaluate，仍然存在其他方法可以阻礙分頁或連線。保留
現有的復原機制（終止執行 + 斷開 Playwright）作為最後一招，適用於：

- 傳統呼叫者
- CDP 附加被阻止的環境
- 意外的 Playwright 邊緣案例

## 實作計畫 (單次疊代)

### 交付項目

- 一個基於 CDP 的 evaluate 引擎，在 Playwright 每個頁面命令佇列之外運行。
- 一個單一的端到端逾時/中止預算，被呼叫者和處理程序一致使用。
- Ref 中繼資料，可選地攜帶 `backendDOMNodeId` 用於元素 evaluate。
- `act:evaluate` 在可能的情況下優先選擇 CDP 引擎，否則回退到 Playwright。
- 測試證明卡住的 evaluate 不會阻礙後續動作。
- 日誌/指標使故障和回退可見。

### 實作清單

1. 增加一個共用的「預算」輔助函式，將 `timeoutMs` + 上游 `AbortSignal` 連結到：
   - 單一 `AbortSignal`
   - 絕對期限
   - `remainingMs()` 輔助函式，用於下游操作
2. 更新所有呼叫者路徑以使用該輔助函式，以便 `timeoutMs` 在所有地方都意味著相同的事情：
   - `src/browser/client-fetch.ts` (HTTP 和程序內分派)
   - `src/node-host/runner.ts` (節點代理路徑)
   - 呼叫 `/act` 的 CLI 包裝器（為 `browser evaluate` 增加 `--timeout-ms`）
3. 實作 `src/browser/cdp-evaluate.ts`：
   - 連接到瀏覽器級別的 CDP Socket
   - `Target.attachToTarget` 以取得 `sessionId`
   - 執行 `Runtime.evaluate` 用於頁面 evaluate
   - 執行 `DOM.resolveNode` + `Runtime.callFunctionOn` 用於元素 evaluate
   - 在逾時/中止時：盡力 `Runtime.terminateExecution` 然後關閉 Socket
4. 擴展儲存的角色 ref 中繼資料以可選地包含 `backendDOMNodeId`：
   - 為 Playwright 動作保留現有的 `{ role, name, nth }` 行為
   - 為 CDP 元素目標定位增加 `backendDOMNodeId?: number`
5. 在快照建立期間填充 `backendDOMNodeId`（盡力而為）：
   - 透過 CDP (`Accessibility.getFullAXTree`) 擷取 AX 樹
   - 計算 `(role, name, nth) -> backendDOMNodeId` 並合併到儲存的 ref 對應中
   - 如果對應模糊或缺失，則將 ID 設為 undefined
6. 更新 `act:evaluate` 路由：
   - 如果沒有 `ref`：始終使用 CDP evaluate
   - 如果 `ref` 解析為 `backendDOMNodeId`：使用 CDP 元素 evaluate
   - 否則：回退到 Playwright evaluate（仍然有界限且可中止）
7. 保留現有的「最後一招」復原路徑作為備用方案，而不是預設路徑。
8. 增加測試：
   - 卡住的 evaluate 在預算內逾時，並且下一個點擊/輸入成功
   - 中止取消 evaluate（客戶端斷開連線或逾時）並解除後續動作的阻塞
   - 對應失敗乾淨地回退到 Playwright
9. 增加可觀察性：
   - evaluate 持續時間和逾時計數器
   - terminateExecution 使用情況
   - 回退率（CDP -> Playwright）和原因

### 驗收標準

- 故意掛起的 `act:evaluate` 在呼叫者預算內返回，並且不會阻礙
  後續動作的分頁。
- `timeoutMs` 在 CLI、智慧代理工具、節點代理和程序內呼叫之間保持一致。
- 如果 `ref` 可以對應到 `backendDOMNodeId`，元素 evaluate 會使用 CDP；否則
  回退路徑仍然有界限且可復原。

## 測試計畫

- 單元測試：
  - (role, name, nth) 在角色 ref 和 AX 樹節點之間的匹配邏輯。
  - 預算輔助函式行為（餘裕、剩餘時間計算）。
- 整合測試：
  - CDP evaluate 逾時在預算內返回，並且不會阻塞下一個動作。
  - 中止取消 evaluate 並盡力觸發終止。
- 契約測試：
  - 確保 `BrowserActRequest` 和 `BrowserActResponse` 保持相容。

## 風險與緩解

- 對應不完美：
  - 緩解：盡力對應，回退到 Playwright evaluate，並增加偵錯工具。
- `Runtime.terminateExecution` 有副作用：
  - 緩解：僅在逾時/中止時使用，並在錯誤中說明其行為。
- 額外開銷：
  - 緩解：僅在請求快照時擷取 AX 樹，每個目標快取，並保持 CDP 工作階段短暫。
- 擴展中繼限制：
  - 緩解：當每個頁面 Socket 不可用時，使用瀏覽器級別的附加 API，並
    保留目前的 Playwright 路徑作為回退。

## 未解決的問題

- 新引擎是否應可配置為 `playwright`、`cdp` 或 `auto`？
- 我們是否要為進階使用者公開新的「nodeRef」格式，還是只保留 `ref`？
- 框架快照和選擇器範圍快照如何參與 AX 對應？
</code>
