---
summary: "跨頻道共用的反應語意"
read_when:
  - 在任何頻道中處理反應功能時
title: "反應"
---

# 反應工具

跨頻道共用的反應語意：

- 新增反應時需要 `emoji`。
- `emoji=""` 會在支援的情況下移除機器人的反應。
- `remove: true` 會在支援的情況下移除指定的表情符號（需要 `emoji`）。

頻道注意事項：

- **Discord/Slack**：空的 `emoji` 會移除訊息上所有機器人的反應；`remove: true` 只會移除該表情符號。
- **Google Chat**：空的 `emoji` 會移除訊息上應用程式的反應；`remove: true` 只會移除該表情符號。
- **Telegram**：空的 `emoji` 會移除機器人的反應；`remove: true` 也會移除反應，但工具驗證仍需要非空的 `emoji`。
- **WhatsApp**：空的 `emoji` 會移除機器人的反應；`remove: true` 會對應為空的表情符號（仍需要 `emoji`）。
- **Signal**：當啟用 `channels.signal.reactionNotifications` 時，傳入的反應通知會發出系統事件。
