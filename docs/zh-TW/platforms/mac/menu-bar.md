---
summary: "選單列狀態邏輯以及對使用者呈現的內容"
read_when:
  - 調整 mac 選單列 UI 或狀態邏輯時
title: "選單列"
---

# 選單列狀態邏輯

## 顯示內容

- 我們在選單列圖示以及選單第一列狀態中呈現目前代理的工作狀態。
- 工作進行中會隱藏健康狀態；當所有工作階段皆為閒置時才會再次顯示。
- 選單中的「Nodes」區塊僅列出**裝置**（透過 `node.list` 配對的節點），不包含 client／presence 項目。
- 當可取得提供者使用量快照時，「Usage」區段會顯示在 Context 之下。

## 狀態模型

- 工作階段：事件會隨附 `runId`（每次執行）以及 payload 中的 `sessionKey` 抵達。「主要」工作階段的鍵值為 `main`；若不存在，則回退為最近更新的工作階段。 「主要」工作階段的鍵值為 `main`；若不存在，則回退至最近一次更新的工作階段。
- 優先順序：main 永遠優先。 If main is active, its state is shown immediately. If main is idle, the most recently active non‑main session is shown. We do not flip‑flop mid‑activity; we only switch when the current session goes idle or main becomes active.
- 活動類型：
  - `job`：高階命令執行（`state: started|streaming|done|error`）。
  - `tool`：`phase: start|result`，搭配 `toolName` 與 `meta/args`。

## IconState enum（Swift）

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
- default → 🛠️

### Visual mapping

- `idle`：一般小動物。
- `workingMain`：帶有圖示的徽章、完整色調、腿部「工作中」動畫。
- `workingOther`: badge with glyph, muted tint, no scurry.
- `overridden`：無論活動狀態，皆使用所選圖示／色調。

## Status row text (menu)

- 工作進行中：`<Session role> · <activity label>`
  - 範例：`Main · exec: pnpm test`、`Other · read: apps/macos/Sources/OpenClaw/AppState.swift`。
- 閒置時：回退為健康狀態摘要。

## 事件接收

- 來源：control‑channel `agent` 事件（`ControlChannel.handleAgentEvent`）。
- Parsed fields:
  - `stream: "job"`，搭配 `data.state` 判斷開始／結束。
  - `stream: "tool"`，包含 `data.phase`、`name`，以及選用的 `meta`/`args`。
- 標籤：
  - `exec`：`args.command` 的第一行。
  - `read`/`write`：縮短後的路徑。
  - `edit`：路徑加上由 `meta`/diff 計數推斷的變更類型。
  - 回退：工具名稱。

## Debug override

- 設定 ▸ Debug ▸ 「Icon override」選擇器：
  - `System (auto)`（預設）
  - `Working: main`（依工具類型）
  - `Working: other`（依工具類型）
  - `Idle`
- 透過 `@AppStorage("iconOverride")` 儲存；對應至 `IconState.overridden`。

## 測試檢查清單

- Trigger main session job: verify icon switches immediately and status row shows main label.
- 在主要閒置時觸發非主要工作階段任務：圖示／狀態顯示非主要，並在完成前保持穩定。
- Start main while other active: icon flips to main instantly.
- 快速工具連續觸發：確保徽章不會閃爍（工具結果有 TTL 寬限）。
- 當所有工作階段皆為閒置後，健康狀態列會再次出現。
