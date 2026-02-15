---
summary: "選單列狀態邏輯以及向使用者顯示的內容"
read_when:
  - 調整 Mac 選單 UI 或狀態邏輯
title: "選單列"
---

# 選單列狀態邏輯

## 顯示內容

- 我們會在選單列圖示和選單的第一個狀態列中顯示目前的智慧代理工作狀態。
- 當工作進行中時，健康狀態會隱藏；當所有工作階段都閒置時，健康狀態會重新出現。
- 選單中的「節點」區塊僅列出 **裝置**（透過 `node.list` 配對的節點），而非用戶端/在線狀態條目。
- 當供應商使用快照可用時，「用量」區塊會出現在「內容」下方。

## 狀態模型

- 工作階段：事件會附帶 `runId`（每次執行）和酬載中的 `sessionKey`。 「主要」工作階段是鍵名 `main`；如果不存在，我們將退回至最近更新的工作階段。
- 優先順序：主要工作階段總是優先。如果主要工作階段處於活動狀態，其狀態會立即顯示。如果主要工作階段閒置，則會顯示最近活動的非主要工作階段。我們不會在活動進行中來回切換；我們只會在目前工作階段閒置或主要工作階段變為活動狀態時才切換。
- 活動類型：
  - `job`：高階指令執行（`state: started|streaming|done|error`）。
  - `tool`：`phase: start|result` 搭配 `toolName` 以及 `meta/args`。

## IconState enum (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (除錯覆寫)

### ActivityKind → 圖示

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- `default` → 🛠️

### 視覺對應

- `idle`：正常圖示。
- `workingMain`：帶有圖示的徽章、完整色調、腿部「工作中」動畫。
- `workingOther`：帶有圖示的徽章、柔和色調、無匆忙移動。
- `overridden`：無論活動如何，都使用所選的圖示/色調。

## 狀態列文字 (選單)

- 當工作進行中時：`<工作階段角色> · <活動標籤>`
  - 範例：`Main · exec: pnpm test`、`Other · read: apps/macos/Sources/OpenClaw/AppState.swift`。
- 閒置時：退回至健康摘要。

## 事件擷取

- 來源：控制通道智慧代理事件（`ControlChannel.handleAgentEvent`）。
- 解析欄位：
  - `stream: "job"` 搭配 `data.state` 進行啟動/停止。
  - `stream: "tool"` 搭配 `data.phase`、`name`、選用 `meta`/`args`。
- 標籤：
  - `exec`：`args.command` 的第一行。
  - `read`/`write`：縮短的路徑。
  - `edit`：路徑加上從 `meta`/差異計數推斷的變更類型。
  - `fallback`：工具名稱。

## 除錯覆寫

- 設定 ▸ 除錯 ▸ 「圖示覆寫」選擇器：
  - `系統 (自動)` (預設)
  - `工作中：主要` (依工具類型)
  - `工作中：其他` (依工具類型)
  - `閒置`
- 透過 `@AppStorage("iconOverride")` 儲存；對應至 `IconState.overridden`。

## 測試檢查表

- 觸發主要工作階段任務：驗證圖示立即切換，且狀態列顯示主要標籤。
- 在主要工作階段閒置時觸發非主要工作階段任務：圖示/狀態顯示非主要；保持穩定直到完成。
- 當其他工作階段處於活動狀態時啟動主要工作階段：圖示立即翻轉為主要。
- 快速工具連發：確保徽章不會閃爍（工具結果的 TTL 寬限）。
- 所有工作階段閒置後，健康狀態列會重新出現。
