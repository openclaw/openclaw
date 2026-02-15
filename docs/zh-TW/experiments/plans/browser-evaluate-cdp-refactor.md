---
summary: "方案：使用 CDP 將瀏覽器的 act:evaluate 與 Playwright 佇列隔離，具備端到端期限與更安全的 ref 解析"
owner: "openclaw"
status: "draft"
last_updated: "2026-02-10"
title: "瀏覽器 Evaluate CDP 重構"
---

# 瀏覽器 Evaluate CDP 重構計畫

## 背景

`act:evaluate` 在頁面中執行使用者提供的 JavaScript。目前它是透過 Playwright（`page.evaluate` 或 `locator.evaluate`）執行。Playwright 會針對每個頁面序列化 CDP 指令，因此卡住或執行時間過長的 evaluate 可能會阻塞頁面指令佇列，導致該分頁後續的所有動作看起來都像「卡住了」。

PR #13498 增加了一個務實的安全網（受限的 evaluate、中止傳遞和盡力而為的恢復）。本檔案描述了一個更大型的重構，使 `act:evaluate` 在本質上與 Playwright 隔離，因此卡住的 evaluate 不會癱瘓正常的 Playwright 操作。

## 目標

- `act:evaluate` 不能永久阻塞同一分頁後續的瀏覽器動作。
- 逾時（Timeout）是端到端的單一事實來源，讓呼叫者可以依賴預算。
- 中止（Abort）和逾時在 HTTP 和行程內發送（in-process dispatch）中的處理方式一致。
- 支援針對 evaluate 的元素定位，且無需完全捨棄 Playwright。
- 維持對現有呼叫者和酬載（payload）的向下相容性。

## 非目標

- 取代所有瀏覽器動作（click、type、wait 等）為 CDP 實作。
- 移除 PR #13498 引入的現有安全網（它仍是很有用的後備方案）。
- 引入現有 `browser.evaluateEnabled` 門控之外的新不安全功能。
- 為 evaluate 加入行程隔離（工作行程/執行緒）。如果重構後仍看到難以恢復的卡死狀態，這將是後續的想法。

## 目前架構（為什麼會卡住）

從高層次來看：

- 呼叫者向瀏覽器控制服務發送 `act:evaluate`。
- 路由處理常式（route handler）呼叫 Playwright 來執行 JavaScript。
- Playwright 序列化分頁指令，因此永不結束的 evaluate 會阻塞佇列。
- 卡住的佇列代表該分頁後續的 click/type/wait 操作可能看起來會掛起。

## 建議架構

### 1. 期限傳遞 (Deadline Propagation)

引入單一預算概念並衍生所有內容：

- 呼叫者設定 `timeoutMs`（或未來的期限）。
- 外部請求逾時、路由處理常式邏輯以及頁面內部的執行預算均使用相同的預算，並根據需要為序列化開銷保留微小的緩衝空間。
- 中止訊息作為 `AbortSignal` 傳遞到各處，確保取消動作的一致性。

實作方向：

- 新增一個小型輔助工具（例如 `createBudget({ timeoutMs, signal })`），回傳：
  - `signal`: 關聯的 AbortSignal
  - `deadlineAtMs`: 絕對期限
  - `remainingMs()`: 子操作的剩餘預算
- 在以下位置使用此輔助工具：
  - `src/browser/client-fetch.ts` (HTTP 和行程內發送)
  - `src/node-host/runner.ts` (代理路徑)
  - 瀏覽器動作實作 (Playwright 和 CDP)

### 2. 獨立的 Evaluate 引擎 (CDP 路徑)

新增基於 CDP 的 evaluate 實作，該實作不共用 Playwright 的分頁指令佇列。關鍵特性是 evaluate 傳輸是一個獨立的 WebSocket 連線，且是附加到目標的獨立 CDP 工作階段。

實作方向：

- 新模組，例如 `src/browser/cdp-evaluate.ts`：
  - 連線到設定的 CDP 端點（瀏覽器層級 socket）。
  - 使用 `Target.attachToTarget({ targetId, flatten: true })` 取得 `sessionId`。
  - 執行以下其中之一：
    - 分頁層級 evaluate 使用 `Runtime.evaluate`。
    - 元素 evaluate 使用 `DOM.resolveNode` 搭配 `Runtime.callFunctionOn`。
  - 逾時或中止時：
    - 針對該工作階段發送盡力而為的 `Runtime.terminateExecution`。
    - 關閉 WebSocket 並回傳明確的錯誤。

備註：

- 這仍然是在頁面中執行 JavaScript，因此終止執行可能會有副作用。優點是它不會癱瘓 Playwright 佇列，且可以透過刪除 CDP 工作階段在傳輸層級取消。

### 3. Ref 方案（無需完全重寫的元素定位）

難點在於元素定位。CDP 需要 DOM 控制代碼（handle）或 `backendDOMNodeId`，而目前的瀏覽器動作多使用基於快照 ref 的 Playwright locator。

建議做法：保留現有 ref，但附加一個選用的 CDP 可解析 ID。

#### 3.1 擴充儲存的 Ref 資訊

擴充儲存的角色 ref 中繼資料，選用性地包含 CDP ID：

- 目前：`{ role, name, nth }`
- 建議：`{ role, name, nth, backendDOMNodeId?: number }`

這讓所有現有的 Playwright 動作保持運作，並在 `backendDOMNodeId` 可用時允許 CDP evaluate 接受相同的 `ref` 值。

#### 3.2 在快照期間填入 backendDOMNodeId

產生角色快照時：

1. 像目前一樣產生現有的角色 ref 映射（role, name, nth）。
2. 透過 CDP 獲取 AX 樹（`Accessibility.getFullAXTree`），並使用相同的重複處理規則計算 `(role, name, nth) -> backendDOMNodeId` 的平行映射。
3. 將 ID 合併回目前分頁儲存的 ref 資訊。

如果 ref 映射失敗，則將 `backendDOMNodeId` 留空（undefined）。這使該功能成為盡力而為且可安全推出。

#### 3.3 搭配 Ref 的 Evaluate 行為

在 `act:evaluate` 中：

- 如果存在 `ref` 且具有 `backendDOMNodeId`，則透過 CDP 執行元素 evaluate。
- 如果存在 `ref` 但沒有 `backendDOMNodeId`，則回退到 Playwright 路徑（帶有安全網）。

選用的逃生艙口：

- 擴充請求格式以直接接受 `backendDOMNodeId` 供進階呼叫者（及偵錯）使用，同時保留 `ref` 作為主要介面。

### 4. 保留最後手段的恢復路徑

即便有 CDP evaluate，仍有其他方式會癱瘓分頁或連線。保留現有的恢復機制（終止執行 + 中斷 Playwright 連線）作為最後手段，用於：

- 舊版呼叫者
- CDP 附加被封鎖的環境
- 非預期的 Playwright 邊際情況

## 實作計畫（單次迭代）

### 交付物

- 基於 CDP 的 evaluate 引擎，在 Playwright 分頁指令佇列之外執行。
- 呼叫者與處理常式一致使用的單一端到端逾時/中止預算。
- 可選用帶有 `backendDOMNodeId` 的 ref 中繼資料，用於元素 evaluate。
- `act:evaluate` 優先使用 CDP 引擎，不可行時回退至 Playwright。
- 證明卡住的 evaluate 不會癱瘓後續動作的測試。
- 使失敗與回退可視化的記錄/指標。

### 實作檢查清單

1. 新增共享的 "budget" 輔助工具，將 `timeoutMs` + 上游 `AbortSignal` 連結至：
   - 單一 `AbortSignal`
   - 絕對期限
   - 供下游操作使用的 `remainingMs()` 輔助工具
2. 更新所有呼叫者路徑以使用該輔助工具，確保 `timeoutMs` 在各處意義相同：
   - `src/browser/client-fetch.ts` (HTTP 和行程內發送)
   - `src/node-host/runner.ts` (node 代理路徑)
   - 呼叫 `/act` 的 CLI 包裝器（為 `browser evaluate` 增加 `--timeout-ms`）
3. 實作 `src/browser/cdp-evaluate.ts`：
   - 連線到瀏覽器層級的 CDP socket
   - 使用 `Target.attachToTarget` 取得 `sessionId`
   - 分頁 evaluate 執行 `Runtime.evaluate`
   - 元素 evaluate 執行 `DOM.resolveNode` + `Runtime.callFunctionOn`
   - 逾時/中止時：盡力發送 `Runtime.terminateExecution` 並關閉 socket
4. 擴充儲存的角色 ref 中繼資料，選用性地包含 `backendDOMNodeId`：
   - Playwright 動作保留現有的 `{ role, name, nth }` 行為
   - 為 CDP 元素定位新增 `backendDOMNodeId?: number`
5. 在建立快照期間填入 `backendDOMNodeId`（盡力而為）：
   - 透過 CDP 獲取 AX 樹 (`Accessibility.getFullAXTree`)
   - 計算 `(role, name, nth) -> backendDOMNodeId` 並合併至儲存的 ref 映射
   - 如果映射模糊或遺失，則將 ID 留空
6. 更新 `act:evaluate` 路由：
   - 若無 `ref`：一律使用 CDP evaluate
   - 若 `ref` 解析為 `backendDOMNodeId`：使用 CDP 元素 evaluate
   - 否則：回退到 Playwright evaluate（仍受限且可中止）
7. 保留現有的「最後手段」恢復路徑作為後備，而非預設路徑。
8. 新增測試：
   - 卡住的 evaluate 在預算內逾時，且下一次 click/type 成功
   - 中止可取消 evaluate（用戶端中斷連線或逾時）並解除後續動作的阻塞
   - 映射失敗時能乾淨地回退至 Playwright
9. 增加可觀測性：
   - evaluate 持續時間與逾時計數器
   - `terminateExecution` 使用情形
   - 回退率（CDP -> Playwright）與原因

### 驗收標準

- 刻意掛起的 `act:evaluate` 在呼叫者預算內回傳，且不會癱瘓分頁的後續動作。
- `timeoutMs` 在 CLI、智慧代理工具、node 代理以及行程內呼叫中的行為一致。
- 若 `ref` 能映射至 `backendDOMNodeId`，元素 evaluate 則使用 CDP；否則後備路徑仍受限且可恢復。

## 測試計畫

- 單元測試：
  - 角色 ref 與 AX 樹節點之間的 `(role, name, nth)` 匹配邏輯。
  - 預算輔助工具行為（緩衝空間、剩餘時間計算）。
- 整合測試：
  - CDP evaluate 逾時在預算內回傳，且不阻塞下一個動作。
  - 中止可取消 evaluate 並觸發盡力而為的終止執行。
- 合約測試：
  - 確保 `BrowserActRequest` 與 `BrowserActResponse` 維持相容。

## 風險與緩解措施

- 映射不完美：
  - 緩解措施：盡力而為映射，回退到 Playwright evaluate，並增加偵錯工具。
- `Runtime.terminateExecution` 有副作用：
  - 緩解措施：僅在逾時/中止時使用，並在錯誤訊息中記錄此行為。
- 額外開銷：
  - 緩解措施：僅在請求快照時獲取 AX 樹，按目標快取，並保持 CDP 工作階段生命週期短暫。
- 擴充元件中繼（Extension relay）限制：
  - 緩解措施：當分頁 socket 不可用時，使用瀏覽器層級的附加 API，並保留目前的 Playwright 路徑作為後備。

## 開放性問題

- 新引擎是否應可設定為 `playwright`、`cdp` 或 `auto`？
- 我們是否要為進階使用者開放新的 "nodeRef" 格式，還是僅保留 `ref`？
- 框架（frame）快照和選取器範圍（selector scoped）快照應如何參與 AX 映射？
