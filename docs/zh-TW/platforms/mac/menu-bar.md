---
summary: "功能列狀態邏輯以及呈現給使用者的資訊"
read_when:
  - 調整 Mac 選單 UI 或狀態邏輯時
title: "功能列"
---

# 功能列狀態邏輯

## 顯示內容

- 我們在功能列圖示和選單的第一個狀態列中呈現當前智慧代理的工作狀態。
- 工作進行時會隱藏運作狀態（Health status）；當所有工作階段皆閒置時，該資訊會重新顯示。
- 選單中的「Nodes」區塊僅列出**裝置**（透過 `node.list` 配對的節點），不包含用戶端或在線狀態項目。
- 當供應商使用情況快照可用時，Context 下方會出現「Usage」部分。

## 狀態模型

- 工作階段：事件隨承載資料（payload）中的 `runId`（每次執行）和 `sessionKey` 一起到達。主工作階段的鍵名為 `main`；如果不存在，我們會回退到最近更新的工作階段。
- 優先順序：`main` 優先級最高。若 `main` 處於活動狀態，會立即顯示其狀態。若 `main` 閒置，則顯示最近活動的非主工作階段。我們不會在活動中途來回切換；僅在當前工作階段變為閒置或 `main` 變為活動時才切換。
- 活動類型：
  - `job`：高階命令執行（`state: started|streaming|done|error`）。
  - `tool`：`phase: start|result`，包含 `toolName` 和 `meta/args`。

## IconState 列舉 (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (除錯覆蓋)

### ActivityKind → 圖示

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- 預設 → 🛠️

### 視覺映射

- `idle`：正常的小生物圖示。
- `workingMain`：帶有圖示的徽章、完全上色、腿部「工作中」動畫。
- `workingOther`：帶有圖示的徽章、暗淡色調、無跑動動畫。
- `overridden`：無論活動為何，皆使用選定的圖示/色調。

## 狀態列文字 (選單)

- 工作進行中：`<Session role> · <activity label>`
  - 範例：`Main · exec: pnpm test`、`Other · read: apps/macos/Sources/OpenClaw/AppState.swift`。
- 閒置時：回退到運作狀態摘要。

## 事件攝取

- 來源：控制頻道（control-channel）的 `agent` 事件（`ControlChannel.handleAgentEvent`）。
- 解析欄位：
  - `stream: "job"` 配合 `data.state` 判斷開始/停止。
  - `stream: "tool"` 包含 `data.phase`、`name`、選用的 `meta`/`args`。
- 標籤：
  - `exec`：`args.command` 的第一行。
  - `read`/`write`：縮短後的路徑。
  - `edit`：路徑加上從 `meta`/diff 計數推斷的變更類型。
  - fallback：工具名稱。

## 除錯覆蓋

- 設定 ▸ 除錯 ▸ 「圖示覆蓋」選取器：
  - `System (auto)` (預設)
  - `Working: main` (依工具類型)
  - `Working: other` (依工具類型)
  - `Idle`
- 透過 `@AppStorage("iconOverride")` 儲存；映射至 `IconState.overridden`。

## 測試檢查清單

- 觸發主工作階段任務：驗證圖示立即切換，且狀態列顯示 main 標籤。
- 在主工作階段閒置時觸發非主工作階段任務：圖示/狀態顯示 non-main；保持穩定直到完成。
- 在其他活動進行時啟動主工作階段：圖示立即切換為 main。
- 快速連續工具呼叫：確保徽章不會閃爍（對工具結果設有 TTL 寬限期）。
- 一旦所有工作階段閒置，運作狀態列會重新出現。
