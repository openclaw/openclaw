---
summary: >-
  Plan: isolate browser act:evaluate from Playwright queue using CDP, with
  end-to-end deadlines and safer ref resolution
read_when:
  - "Working on browser `act:evaluate` timeout, abort, or queue blocking issues"
  - Planning CDP based isolation for evaluate execution
owner: openclaw
status: draft
last_updated: "2026-02-10"
title: Browser Evaluate CDP Refactor
---

# Browser Evaluate CDP 重構計畫

## Context

`act:evaluate` 在頁面中執行用戶提供的 JavaScript。今天它是通過 Playwright 執行的 (`page.evaluate` 或 `locator.evaluate`)。Playwright 會根據每個頁面序列化 CDP 命令，因此一個卡住或長時間執行的 evaluate 可能會阻塞頁面命令隊列，並使該標籤上的每個後續操作看起來都像是「卡住」了。

PR #13498 增加了一個務實的安全網（有界評估、中止傳播和最佳努力恢復）。本文檔描述了一個更大的重構，使得 `act:evaluate` 本質上與 Playwright 隔離，這樣被卡住的評估就不會阻礙正常的 Playwright 操作。

## 目標

- `act:evaluate` 無法永久阻止同一標籤頁上的後續瀏覽器操作。
- 超時是端到端的單一真相來源，因此呼叫者可以依賴預算。
- 中止和超時在 HTTP 和進程內調度中以相同方式處理。
- 支援在不關閉 Playwright 的情況下進行元素目標評估。
- 為現有呼叫者和有效負載維持向後相容性。

## 非目標

- 將所有瀏覽器操作（點擊、輸入、等待等）替換為 CDP 實現。
- 移除在 PR #13498 中引入的現有安全網（它仍然是一個有用的後備方案）。
- 引入超出現有 `browser.evaluateEnabled` 門檻的新不安全功能。
- 為 evaluate 添加進程隔離（工作進程/線程）。如果在這次重構後仍然看到難以恢復的卡住狀態，這將是一個後續的想法。

## 當前架構（為什麼會卡住）

在高層次上：

- 呼叫者將 `act:evaluate` 發送到瀏覽器控制服務。
- 路由處理器調用 Playwright 來執行 JavaScript。
- Playwright 會序列化頁面命令，因此一個永遠不結束的 evaluate 會阻塞隊列。
- 隊列卡住意味著在該標籤上的後續點擊/輸入/等待操作可能會顯得無法響應。

## 提議的架構

### 1. 截止日期傳播

[[BLOCK_1]]  
介紹單一預算概念並從中推導所有內容：  
[[BLOCK_1]]

- 呼叫者設置 `timeoutMs`（或未來的截止日期）。
- 外部請求超時、路由處理邏輯以及頁面內的執行預算都使用相同的預算，並在需要的地方留有小幅的緩衝以應對序列化開銷。
- 中止作業作為 `AbortSignal` 在各處傳播，以確保取消的一致性。

實作方向：

- 添加一個小幫助器 (例如 `createBudget({ timeoutMs, signal })`)，返回：
  - `signal`: 連結的 AbortSignal
  - `deadlineAtMs`: 絕對截止時間
  - `remainingMs()`: 子操作的剩餘預算
- 在以下地方使用此幫助器：
  - `src/browser/client-fetch.ts` (HTTP 和內部處理)
  - `src/node-host/runner.ts` (代理路徑)
  - 瀏覽器操作實作 (Playwright 和 CDP)

### 2. 獨立評估引擎 (CDP 路徑)

新增一個基於 CDP 的 evaluate 實作，該實作不會共享 Playwright 的每頁命令佇列。其關鍵特性是 evaluate 傳輸使用一個獨立的 WebSocket 連接，並且附加到目標的獨立 CDP 會話。

實作方向：

- 新模組，例如 `src/browser/cdp-evaluate.ts`，其功能為：
  - 連接到設定的 CDP 端點（瀏覽器層級的 socket）。
  - 使用 `Target.attachToTarget({ targetId, flatten: true })` 來獲取 `sessionId`。
  - 執行以下其中一項：
    - `Runtime.evaluate` 進行頁面層級的評估，或
    - `DOM.resolveNode` 加上 `Runtime.callFunctionOn` 進行元素評估。
  - 在超時或中止時：
    - 發送 `Runtime.terminateExecution` 以最佳努力方式處理會話。
    - 關閉 WebSocket 並返回明確的錯誤。

[[BLOCK_1]]

- 這仍然會在頁面中執行 JavaScript，因此終止可能會有副作用。好處是它不會阻塞 Playwright 的佇列，並且可以透過終止 CDP 會話在傳輸層進行取消。

### 3. 參考故事（元素定位而不需完全重寫）

困難的部分是元素定位。CDP 需要一個 DOM 處理句柄或 `backendDOMNodeId`，而目前大多數瀏覽器操作使用基於快照的引用的 Playwright 定位器。

建議的方法：保留現有的引用，但附加一個可選的 CDP 可解析 ID。

#### 3.1 擴充儲存的參考資訊

擴充儲存的角色參考元資料，以選擇性地包含 CDP ID：

- 今天: `{ role, name, nth }`
- 提議: `{ role, name, nth, backendDOMNodeId?: number }`

這樣可以保持所有現有的基於 Playwright 的操作正常運作，並允許 CDP evaluate 在 `backendDOMNodeId` 可用時接受相同的 `ref` 值。

#### 3.2 在快照時間填充 backendDOMNodeId

在產生角色快照時：

1. 生成當前的角色參考映射 (role, name, nth)。
2. 通過 CDP 獲取 AX 樹 (`Accessibility.getFullAXTree`)，並使用相同的重複處理規則計算 `(role, name, nth) -> backendDOMNodeId` 的平行映射。
3. 將 id 合併回當前標籤的存儲參考資訊中。

如果對於一個引用的映射失敗，則將 `backendDOMNodeId` 保留為未定義。這使得該功能能夠以最佳努力的方式執行，並且安全地推出。

#### 3.3 使用 Ref 評估行為

`act:evaluate`

- 如果 `ref` 存在且具有 `backendDOMNodeId`，則透過 CDP 執行元素評估。
- 如果 `ref` 存在但沒有 `backendDOMNodeId`，則回退到 Playwright 路徑（並帶有安全網）。

可選的逃生閥：

- 擴充請求形狀以直接接受 `backendDOMNodeId` 供進階呼叫者（以及用於除錯）使用，同時保持 `ref` 作為主要介面。

### 4. 保持最後的恢復路徑

即使使用 CDP 評估，仍然有其他方法可以插入一個標籤或連接。將現有的恢復機制（終止執行 + 斷開 Playwright 連接）作為最後的手段，適用於：

- 遺留呼叫者
- CDP 附加被阻擋的環境
- 意外的 Playwright 邊緣案例

## 實施計畫（單次迭代）

### Deliverables

- 一個基於 CDP 的評估引擎，執行在 Playwright 每頁命令隊列之外。
- 一個單一的端到端超時/中止預算，由呼叫者和處理者一致使用。
- 參考元資料可以選擇性地攜帶 `backendDOMNodeId` 以進行元素評估。
- `act:evaluate` 優先使用 CDP 引擎，當無法使用時則回退到 Playwright。
- 測試證明卡住的評估不會阻礙後續操作。
- 日誌/指標使失敗和回退變得可見。

### 實作檢查清單

1. 新增一個共享的 "budget" 助手，以連結 `timeoutMs` + 上游 `AbortSignal` 成為：
   - 一個單一的 `AbortSignal`
   - 一個絕對的截止日期
   - 一個 `remainingMs()` 助手用於下游操作
2. 更新所有呼叫路徑以使用該助手，使得 `timeoutMs` 在各處的意義相同：
   - `src/browser/client-fetch.ts` (HTTP 和進程內調度)
   - `src/node-host/runner.ts` (節點代理路徑)
   - 調用 `/act` 的 CLI 包裝器 (將 `--timeout-ms` 添加到 `browser evaluate`)
3. 實現 `src/browser/cdp-evaluate.ts`：
   - 連接到瀏覽器級別的 CDP 插座
   - `Target.attachToTarget` 以獲取 `sessionId`
   - 執行 `Runtime.evaluate` 以進行頁面評估
   - 執行 `DOM.resolveNode` + `Runtime.callFunctionOn` 以進行元素評估
   - 在超時/中止時：最佳努力 `Runtime.terminateExecution` 然後關閉插座
4. 擴充存儲的角色引用元數據，以選擇性地包含 `backendDOMNodeId`：
   - 保持現有 `{ role, name, nth }` 行為以用於 Playwright 操作
   - 為 CDP 元素定位添加 `backendDOMNodeId?: number`
5. 在快照創建期間填充 `backendDOMNodeId` (最佳努力)：
   - 通過 CDP 獲取 AX 樹 (`Accessibility.getFullAXTree`)
   - 計算 `(role, name, nth) -> backendDOMNodeId` 並合併到存儲的引用映射中
   - 如果映射模糊或缺失，則將 id 保持為未定義
6. 更新 `act:evaluate` 路由：
   - 如果沒有 `ref`：始終使用 CDP 評估
   - 如果 `ref` 解析為 `backendDOMNodeId`：使用 CDP 元素評估
   - 否則：回退到 Playwright 評估（仍然是有界且可中止的）
7. 保持現有的 "最後手段" 恢復路徑作為後備，而不是預設路徑。
8. 添加測試：
   - 被卡住的評估在預算內超時，下一次點擊/輸入成功
   - 中止取消評估（用戶端斷開或超時）並解除後續操作的阻塞
   - 映射失敗乾淨地回退到 Playwright
9. 添加可觀察性：
   - 評估持續時間和超時計數器
   - terminateExecution 使用情況
   - 回退率 (CDP -> Playwright) 及原因

### Acceptance Criteria

- 一個故意掛起的 `act:evaluate` 會在呼叫者的預算內返回，並且不會阻塞後續操作的標籤。
- `timeoutMs` 在 CLI、代理工具、節點代理和內部調用中表現一致。
- 如果 `ref` 可以映射到 `backendDOMNodeId`，則元素評估使用 CDP；否則，備援路徑仍然是有界且可恢復的。

## 測試計畫

- 單元測試：
  - `(role, name, nth)` 角色參考與 AX 樹節點之間的匹配邏輯。
  - 預算輔助功能行為（頭部空間、剩餘時間計算）。
- 整合測試：
  - CDP 評估超時在預算內返回，並且不會阻塞下一個動作。
  - 中止取消評估並觸發最佳努力終止。
- 合約測試：
  - 確保 `BrowserActRequest` 和 `BrowserActResponse` 保持相容。

## 風險與緩解措施

- 映射並不完美：
  - 緩解措施：最佳努力映射，回退到 Playwright evaluate，並添加調試工具。
- `Runtime.terminateExecution` 具有副作用：
  - 緩解措施：僅在超時/中止時使用，並在錯誤中記錄行為。
- 額外開銷：
  - 緩解措施：僅在請求快照時獲取 AX 樹，按目標進行快取，並保持 CDP 會話短暫。
- 擴充中繼限制：
  - 緩解措施：在每頁套接字不可用時使用瀏覽器級別的附加 API，並保持當前的 Playwright 路徑作為回退。

## 開放性問題

- 新引擎應該設定為 `playwright`、`cdp` 還是 `auto`？
- 我們是否想要為進階使用者公開一種新的 "nodeRef" 格式，還是僅保留 `ref`？
- 幀快照和選擇器範圍快照應如何參與 AX 映射？
