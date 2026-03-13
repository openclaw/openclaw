---
summary: Reaction semantics shared across channels
read_when:
  - Working on reactions in any channel
title: Reactions
---

# 反應工具

跨頻道共用的反應語意：

- 新增反應時必須包含 `emoji`。
- 支援時，`emoji=""` 可移除機器人的反應。
- 支援時，`remove: true` 可移除指定的表情符號（需搭配 `emoji`）。

頻道說明：

- **Discord/Slack**：空的 `emoji` 會移除該訊息上機器人的所有反應；`remove: true` 則只移除該表情符號。
- **Google Chat**：空的 `emoji` 會移除該訊息上應用程式的反應；`remove: true` 則只移除該表情符號。
- **Telegram**：空的 `emoji` 會移除機器人的反應；`remove: true` 也會移除反應，但工具驗證仍需非空的 `emoji`。
- **WhatsApp**：空的 `emoji` 會移除機器人的反應；`remove: true` 對應空的表情符號（仍需 `emoji`）。
- **Zalo 個人帳號 (`zalouser`)**：需非空的 `emoji`；`remove: true` 會移除該特定表情符號反應。
- **Signal**：啟用 `channels.signal.reactionNotifications` 時，入站反應通知會發出系統事件。
