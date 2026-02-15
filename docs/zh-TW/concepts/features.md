---
summary: "OpenClaw 在頻道、路由、媒體和使用者體驗（UX）方面的功能。"
read_when:
  - 當您想了解 OpenClaw 支援的所有功能清單時
title: "功能"
---

## 亮點

<Columns>
  <Card title="頻道" icon="message-square">
    透過單一 Gateway 即可連接 WhatsApp、Telegram、Discord 和 iMessage。
  </Card>
  <Card title="外掛程式" icon="plug">
    透過擴充功能新增 Mattermost 等更多支援。
  </Card>
  <Card title="路由" icon="route">
    具備隔離工作階段的多智慧代理路由。
  </Card>
  <Card title="媒體" icon="image">
    支援圖片、音訊和檔案的傳入與傳出。
  </Card>
  <Card title="應用程式與介面" icon="monitor">
    網頁控制介面（Web Control UI）與 macOS 配套應用。
  </Card>
  <Card title="行動節點" icon="smartphone">
    支援 Canvas 的 iOS 和 Android 節點。
  </Card>
</Columns>

## 完整功能清單

- 透過 WhatsApp Web (Baileys) 整合 WhatsApp
- Telegram 機器人支援 (grammY)
- Discord 機器人支援 (channels.discord.js)
- Mattermost 機器人支援 (外掛程式)
- 透過本地 imsg CLI (macOS) 整合 iMessage
- 支援工具串流傳輸的 RPC 模式 Pi 智慧代理橋接
- 針對長回覆提供串流與分塊處理
- 為每個工作區或傳送者提供隔離工作階段的多智慧代理路由
- 透過 OAuth 進行 Anthropic 和 OpenAI 的訂閱認證
- 工作階段：私訊會合併至共享的 `main`；群組則保持隔離
- 支援群組聊天，並可透過提及 (@mention) 啟動
- 支援圖片、音訊和檔案等媒體
- 選用的語音訊息轉文字 Hook
- 網頁聊天（WebChat）與 macOS 選單列應用程式
- 具備配對功能與 Canvas 介面的 iOS 節點
- 具備配對、Canvas、聊天及相機功能的 Android 節點

<Note>
已移除舊版的 Claude、Codex、Gemini 和 Opencode 路徑。Pi 是目前唯一的程式碼智慧代理路徑。
</Note>
