---
summary: "OpenClaw capabilities across channels, routing, media, and UX."
read_when:
  - You want a full list of what OpenClaw supports
title: Features
---

## Highlights

<Columns>
  <Card title="頻道" icon="message-square">
    WhatsApp、Telegram、Discord 和 iMessage 透過單一 Gateway 進行整合。
  </Card>
  <Card title="插件" icon="plug">
    透過擴充新增 Mattermost 等功能。
  </Card>
  <Card title="路由" icon="route">
    多代理路由，具備獨立會話。
  </Card>
  <Card title="媒體" icon="image">
    圖片、音訊和文件的進出。
  </Card>
  <Card title="應用程式與介面" icon="monitor">
    網頁控制介面和 macOS 伴隨應用程式。
  </Card>
  <Card title="行動節點" icon="smartphone">
    支援配對的 iOS 和 Android 節點，具備語音/聊天及豐富的設備指令。
  </Card>
</Columns>

## Full list

- 透過 WhatsApp Web 進行 WhatsApp 整合 (Baileys)
- 支援 Telegram 機器人 (grammY)
- 支援 Discord 機器人 (channels.discord.js)
- 支援 Mattermost 機器人 (plugin)
- 透過本地 imsg CLI 進行 iMessage 整合 (macOS)
- 在 RPC 模式下為 Pi 提供代理橋接，並支援工具串流
- 長回應的串流和分塊處理
- 針對每個工作區或發送者的隔離會話進行多代理路由
- 透過 OAuth 進行 Anthropic 和 OpenAI 的訂閱認證
- 會話：直接聊天合併為共享 `main`；群組則為隔離狀態
- 支援群組聊天，並基於提及進行啟動
- 支援圖片、音頻和文件的媒體
- 可選的語音備忘錄轉錄鉤子
- WebChat 和 macOS 選單欄應用程式
- iOS 節點具備配對、畫布、相機、螢幕錄製、位置和語音功能
- Android 節點具備配對、連接標籤、聊天會話、語音標籤、畫布/相機，以及設備、通知、聯絡人/日曆、運動、照片和 SMS 指令

<Note>
舊版的 Claude、Codex、Gemini 和 Opencode 路徑已被移除。Pi 是唯一的編碼代理路徑。
</Note>
