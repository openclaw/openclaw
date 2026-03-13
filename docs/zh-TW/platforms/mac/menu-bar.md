---
summary: Menu bar status logic and what is surfaced to users
read_when:
  - Tweaking mac menu UI or status logic
title: Menu Bar
---

# 選單列狀態邏輯

## 顯示內容

- 我們會在選單列圖示及選單的第一個狀態列中顯示目前代理程式的工作狀態。
- 工作進行中時會隱藏健康狀態；當所有工作階段閒置時，健康狀態會重新顯示。
- 選單中的「節點」區塊只列出**裝置**（透過 `node.list` 配對的節點），不包含用戶端/在線狀態條目。
- 當有提供者使用快照時，會在「上下文」下方顯示「使用量」區塊。

## 狀態模型

- 工作階段：事件會攜帶 `runId`（每次執行）及 payload 中的 `sessionKey`。所謂「主要」工作階段是關鍵 `main`；若不存在，則退回到最近更新的工作階段。
- 優先順序：主要工作階段永遠優先。如果主要工作階段處於活動中，立即顯示其狀態；若主要工作階段閒置，則顯示最近活躍的非主要工作階段。我們不會在活動中途切換狀態，只有當目前工作階段閒置或主要工作階段變為活動時才切換。
- 活動類型：
  - `job`：高階指令執行 (`state: started|streaming|done|error`)。
  - `tool`：`phase: start|result`，搭配 `toolName` 和 `meta/args`。

## IconState 列舉型別（Swift）

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)`（除錯覆寫）

### ActivityKind → 圖示

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- 預設 → 🛠️

### 視覺對應

- `idle`：一般角色。
- `workingMain`：帶有圖示徽章，完整色調，腿部「工作中」動畫。
- `workingOther`：帶有圖示徽章，色調柔和，無奔跑動畫。
- `overridden`：無論活動狀態，皆使用選定的圖示與色調。

## 狀態列文字（選單）

- 工作進行中時：`<Session role> · <activity label>`
  - 範例：`Main · exec: pnpm test`、`Other · read: apps/macos/Sources/OpenClaw/AppState.swift`。
- 閒置時：退回顯示健康摘要。

## 事件接收

- 來源：控制通道 `agent` 事件（`ControlChannel.handleAgentEvent`）。
- 解析欄位：
  - `stream: "job"` 搭配 `data.state` 用於開始/停止。
  - `stream: "tool"` 搭配 `data.phase`、`name`，可選 `meta`/`args`。
- 標籤：
  - `exec`：`args.command` 的第一行。
  - `read`/`write`：縮短路徑。
  - `edit`：路徑加上從 `meta`/差異計數推斷的變更類型。
  - 備用：工具名稱。

## 除錯覆寫

- 設定 ▸ 除錯 ▸ 「圖示覆寫」選擇器：
  - `System (auto)`（預設）
  - `Working: main`（依工具類型）
  - `Working: other`（依工具類型）
  - `Idle`
- 透過 `@AppStorage("iconOverride")` 儲存；映射至 `IconState.overridden`。

## 測試清單

- 觸發主要工作階段工作：確認圖示立即切換，狀態列顯示主要標籤。
- 在主要閒置時觸發非主要工作階段工作：圖示/狀態顯示非主要；保持穩定直到完成。
- 其他工作進行中時啟動主要工作：圖示立即切換為主要。
- 快速工具連續觸發：確保徽章不閃爍（工具結果有 TTL 寬限期）。
- 所有工作階段閒置後，健康狀態列重新出現。
