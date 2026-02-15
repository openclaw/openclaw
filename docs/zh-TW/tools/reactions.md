---
summary: "跨頻道共享的反應語義"
read_when:
  - 在任何頻道中處理反應時
title: "反應"
---

# 反應工具

跨頻道共享的反應語義：

- 新增反應時必須提供 `emoji`。
- 在支援的情況下，`emoji=""` 會移除智慧代理的反應。
- 在支援的情況下，`remove: true` 會移除指定的 emoji（需要提供 `emoji`）。

頻道注意事項：

- **Discord/Slack**：空的 `emoji` 會移除該訊息上智慧代理的所有反應；`remove: true` 則僅移除該特定的 emoji。
- **Google Chat**：空的 `emoji` 會移除該訊息上應用程式的反應；`remove: true` 則僅移除該特定的 emoji。
- **Telegram**：空的 `emoji` 會移除智慧代理的反應；`remove: true` 同樣會移除反應，但工具驗證仍需要非空的 `emoji`。
- **WhatsApp**：空的 `emoji` 會移除智慧代理的反應；`remove: true` 會對應到空字串 emoji（仍需要提供 `emoji`）。
- **Signal**：當 `channels.signal.reactionNotifications` 啟用時，接收到的反應通知會發送系統事件。
