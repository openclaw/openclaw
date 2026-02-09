---
summary: "OpenClaw 何時顯示輸入中指示，以及如何調整"
read_when:
  - 變更輸入中指示的行為或預設值
title: "Typing Indicators"
---

# Typing indicators

Typing indicators are sent to the chat channel while a run is active. 在執行期間，輸入中指示會傳送到聊天頻道。使用
`agents.defaults.typingMode` 來控制**何時**開始輸入，並使用 `typingIntervalSeconds`
來控制**更新頻率**。

## Defaults

當 `agents.defaults.typingMode` **未設定**時，OpenClaw 會維持舊有行為：

- **直接聊天**：一旦模型迴圈開始，立即開始顯示輸入中。
- **有提及的群組聊天**：立即開始顯示輸入中。
- **未提及的群組聊天**：僅在訊息文字開始串流時才顯示輸入中。
- **心跳執行**：停用輸入中指示。

## 模式

將 `agents.defaults.typingMode` 設為以下其中之一：

- `never` — 永不顯示輸入中指示。
- `instant` — **模型迴圈一開始就**顯示輸入中，即使該次執行
  之後只回傳靜默回覆權杖。
- `thinking` — 在**第一個推理增量**時開始顯示輸入中（該次執行需要
  `reasoningLevel: "stream"`）。
- `message` — 在**第一個非靜默文字增量**時開始顯示輸入中（會忽略
  `NO_REPLY` 靜默權杖）。

「觸發時機由早到晚」的順序：
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

You can override mode or cadence per session:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## 注意事項

- `message` 模式不會為僅有靜默的回覆顯示輸入中（例如用於抑制輸出的 `NO_REPLY`
  權杖）。
- `thinking` only fires if the run streams reasoning (`reasoningLevel: "stream"`).
  If the model doesn’t emit reasoning deltas, typing won’t start.
- 心跳執行無論模式為何，都不會顯示輸入中。
- `typingIntervalSeconds` 只控制**更新頻率**，而非開始時間。
  預設為 6 秒。
  The default is 6 seconds.
