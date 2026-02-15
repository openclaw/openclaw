---
summary: "OpenClaw 何時顯示輸入中狀態以及如何進行調整"
read_when:
  - 更改輸入中狀態的行為或預設值
title: "輸入中狀態"
---

# 輸入中狀態

當執行中的任務處於啟動狀態時，系統會向聊天頻道發送輸入中狀態（typing indicators）。使用 `agents.defaults.typingMode` 控制**何時**開始顯示輸入中，並使用 `typingIntervalSeconds` 控制重新整理的**頻率**。

## 預設值

當 `agents.defaults.typingMode` **未設定**時，OpenClaw 會保留舊有行為：

- **私訊聊天**：一旦模型迴圈（loop）開始，立即顯示輸入中。
- **提及（mention）的群組聊天**：立即顯示輸入中。
- **未提及的群組聊天**：僅在訊息文字開始串流傳輸時才顯示輸入中。
- **Heartbeat 執行任務**：停用輸入中狀態。

## 模式

將 `agents.defaults.typingMode` 設定為以下其中之一：

- `never` — 永遠不顯示輸入中狀態。
- `instant` — **一旦模型迴圈開始**即顯示輸入中，即使該執行任務稍後僅傳回靜默回覆權杖（silent reply token）。
- `thinking` — 在**第一個推理增量（reasoning delta）**時開始顯示輸入中（執行任務需具備 `reasoningLevel: "stream"` 設定）。
- `message` — 在**第一個非靜默文字增量**時開始顯示輸入中（會忽略 `NO_REPLY` 靜默權杖）。

「觸發時間早晚」的順序：
`never` → `message` → `thinking` → `instant`

## 設定

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```

您可以針對每個工作階段（session）覆寫模式或頻率：

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## 注意事項

- `message` 模式不會針對僅包含靜默回覆的訊息顯示輸入中（例如用於隱藏輸出的 `NO_REPLY` 權杖）。
- `thinking` 僅在執行任務串流傳輸推理內容（`reasoningLevel: "stream"`）時觸發。如果模型未發送推理增量，則不會開始顯示輸入中。
- Heartbeat 永遠不會顯示輸入中狀態，無論處於何種模式。
- `typingIntervalSeconds` 控制的是**重新整理頻率**，而非開始時間。預設值為 6 秒。
