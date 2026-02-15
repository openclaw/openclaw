---
summary: "OpenClaw 何時顯示打字指示器以及如何調整"
read_when:
  - 更改打字指示器行為或預設值時
title: "打字指示器"
---

# 打字指示器

當執行中的程式作用中時，打字指示器會傳送到聊天頻道。使用 `agents.defaults.typingMode` 來控制打字**何時**開始，並使用 `typingIntervalSeconds` 來控制它**多久**更新一次。

## 預設值

當 `agents.defaults.typingMode` **未設定**時，OpenClaw 會保留舊版行為：

- **直接聊天**: 模型循環一開始，打字就會立即開始。
- **附帶提及的群組聊天**: 打字會立即開始。
- **不帶提及的群組聊天**: 只有在訊息文字開始串流傳輸時，打字才會開始。
- **心跳執行**: 打字功能已停用。

## 模式

將 `agents.defaults.typingMode` 設定為以下其中一項：

- `never` — 永不顯示打字指示器。
- `instant` — **模型循環一開始**就開始打字，即使後續執行只回傳靜默回覆權杖。
- `thinking` — 在**第一個推理差異**時開始打字 (執行需要 `reasoningLevel: "stream"`)。
- `message` — 在**第一個非靜默文字差異**時開始打字 (忽略 `NO_REPLY` 靜默權杖)。

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

您可以依據每個工作階段覆寫模式或頻率：

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## 注意事項

- `message` 模式不會顯示僅限靜默回覆的打字指示器 (例如用於抑制輸出的 `NO_REPLY` 權杖)。
- `thinking` 模式只有在執行串流傳輸推理時才會觸發 (`reasoningLevel: "stream"`)。如果模型沒有發出推理差異，打字就不會開始。
- 無論何種模式，心跳永不顯示打字指示器。
- `typingIntervalSeconds` 控制的是**更新頻率**，而非開始時間。預設值為 6 秒。
