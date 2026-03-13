---
summary: "OpenClaw capabilities across channels, routing, media, and UX."
read_when:
  - You want a full list of what OpenClaw supports
title: Features
---

## 亮點

<Columns>
  <Card title="通訊管道" icon="message-square">
    透過單一 Gateway 支援 WhatsApp、Telegram、Discord 及 iMessage。
  </Card>
  <Card title="外掛" icon="plug">
    透過擴充功能新增 Mattermost 等更多服務。
  </Card>
  <Card title="路由" icon="route">
    多代理路由與獨立會話。
  </Card>
  <Card title="媒體" icon="image">
    支援圖片、音訊及文件的收發。
  </Card>
  <Card title="應用程式與介面" icon="monitor">
    網頁控制介面與 macOS 輔助應用程式。
  </Card>
  <Card title="行動節點" icon="smartphone">
    iOS 與 Android 節點，具配對、語音/聊天及豐富裝置指令功能。
  </Card>
</Columns>

## 完整清單

- 透過 WhatsApp Web (Baileys) 整合 WhatsApp
- 支援 Telegram 機器人 (grammY)
- 支援 Discord 機器人 (channels.discord.js)
- 支援 Mattermost 機器人 (外掛)
- 透過本地 imsg CLI (macOS) 整合 iMessage
- Pi 代理橋接，RPC 模式並支援工具串流
- 長回應的串流與分段處理
- 多代理路由，為每個工作區或發送者提供獨立會話
- 透過 OAuth 支援 Anthropic 與 OpenAI 的訂閱認證
- 會話管理：直接聊天會合併至共享 `main`；群組則獨立
- 支援群組聊天並以提及啟動
- 支援圖片、音訊及文件媒體
- 可選的語音訊息轉錄掛勾
- WebChat 與 macOS 功能列應用程式
- iOS 節點具配對、Canvas、相機、螢幕錄製、定位及語音功能
- Android 節點具配對、Connect 分頁、聊天會話、語音分頁、Canvas/相機，以及裝置、通知、聯絡人/行事曆、動作、相片與 SMS 指令

<Note>
已移除舊版 Claude、Codex、Gemini 及 Opencode 路徑。Pi 是唯一的程式碼代理路徑。
</Note>
