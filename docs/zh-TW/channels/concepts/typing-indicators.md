---
summary: When OpenClaw shows typing indicators and how to tune them
read_when:
  - Changing typing indicator behavior or defaults
title: Typing Indicators
---

# Typing indicators

在執行期間，輸入指示會發送到聊天頻道。使用 `agents.defaults.typingMode` 來控制 **何時** 開始輸入，並使用 `typingIntervalSeconds` 來控制 **更新的頻率**。

## Defaults

當 `agents.defaults.typingMode` 為 **未設定** 時，OpenClaw 保持舊有的行為：

- **直接聊天**：一旦模型循環開始，輸入將立即開始。
- **提及的群組聊天**：輸入將立即開始。
- **未提及的群組聊天**：輸入僅在消息文本開始串流時才會開始。
- **心跳執行**：輸入被禁用。

## Modes

將 `agents.defaults.typingMode` 設定為以下之一：

- `never` — 永遠不顯示輸入指示器。
- `instant` — **模型迴圈開始後立即開始輸入**，即使執行後僅返回靜默回覆 token。
- `thinking` — 在 **第一次推理變化** 時開始輸入（執行需要 `reasoningLevel: "stream"`）。
- `message` — 在 **第一次非靜默文本變化** 時開始輸入（忽略 `NO_REPLY` 靜默 token）。

觸發的早期順序：
`never` → `message` → `thinking` → `instant`

## Configuration

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```

您可以在每個會話中覆蓋模式或節奏：

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Notes

- `message` 模式不會顯示靜默回覆的輸入（例如，用於抑制輸出的 `NO_REPLY` token）。
- `thinking` 只有在執行流推理 (`reasoningLevel: "stream"`) 時才會觸發。如果模型不發出推理增量，則不會開始輸入。
- 心跳永遠不會顯示輸入，無論模式如何。
- `typingIntervalSeconds` 控制 **刷新頻率**，而不是開始時間。預設為 6 秒。
