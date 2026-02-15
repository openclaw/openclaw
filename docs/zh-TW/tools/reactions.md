---
summary: "跨頻道共享的回應語義"
read_when:
  - 處理任何頻道中的回應時
title: "回應"
---

# 回應工具

跨頻道共享的回應語義：

- 新增回應時，`emoji` 是必填的。
- 當支援時，`emoji=""` 會移除機器人的回應。
- 當支援時，`remove: true` 會移除指定的回應 (需要 `emoji`)。

頻道備註：

- **Discord/Slack**：空的 `emoji` 會移除機器人在該訊息上的所有回應；`remove: true` 只會移除該回應。
- **Google Chat**：空的 `emoji` 會移除應用程式在該訊息上的回應；`remove: true` 只會移除該回應。
- **Telegram**：空的 `emoji` 會移除機器人的回應；`remove: true` 也會移除回應，但仍需要非空值的 `emoji` 進行工具驗證。
- **WhatsApp**：空的 `emoji` 會移除機器人回應；`remove: true` 對應到空的 `emoji` (仍需要 `emoji`)。
- **Signal**：當 `channels.signal.reactionNotifications` 啟用時，傳入的回應通知會發出系統事件。
