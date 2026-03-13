---
summary: When OpenClaw shows typing indicators and how to tune them
read_when:
  - Changing typing indicator behavior or defaults
title: Typing Indicators
---

# 輸入指示燈

當執行中時，輸入指示燈會傳送到聊天頻道。使用 `agents.defaults.typingMode` 來控制**何時**開始顯示輸入指示燈，使用 `typingIntervalSeconds` 來控制**多久**更新一次。

## 預設值

當 `agents.defaults.typingMode` **未設定** 時，OpenClaw 保持舊有行為：

- **直接聊天**：模型迴圈一開始就立即顯示輸入指示燈。
- **群組聊天且有提及**：立即顯示輸入指示燈。
- **群組聊天但無提及**：只有在訊息文字開始串流時才顯示輸入指示燈。
- **心跳執行**：不顯示輸入指示燈。

## 模式

將 `agents.defaults.typingMode` 設定為以下之一：

- `never` — 永遠不顯示輸入指示燈。
- `instant` — **模型迴圈一開始**就開始顯示輸入指示燈，即使執行結果後續只回傳靜默回覆 token。
- `thinking` — 在**第一個推理增量**時開始顯示輸入指示燈（需要該執行有 `reasoningLevel: "stream"`）。
- `message` — 在**第一個非靜默文字增量**時開始顯示輸入指示燈（忽略 `NO_REPLY` 靜默 token）。

「觸發時間早晚」的順序為：
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

你可以針對每個會話覆寫模式或更新頻率：

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## 注意事項

- `message` 模式不會顯示僅靜默回覆的輸入指示燈（例如用來抑制輸出的 `NO_REPLY` token）。
- `thinking` 只有在執行串流推理 (`reasoningLevel: "stream"`) 時才會觸發。
  如果模型沒有輸出推理增量，輸入指示燈不會開始顯示。
- 心跳執行無論模式如何，都不會顯示輸入指示燈。
- `typingIntervalSeconds` 控制的是**更新頻率**，而非開始時間。
  預設為 6 秒。
