---
summary: Synology Chat webhook setup and OpenClaw config
read_when:
  - Setting up Synology Chat with OpenClaw
  - Debugging Synology Chat webhook routing
title: Synology Chat
---

# Synology Chat (plugin)

狀態：透過插件作為直接消息通道支援，使用 Synology Chat 的網路鉤子。該插件接受來自 Synology Chat 外發網路鉤子的傳入消息，並通過 Synology Chat 的內部網路鉤子發送回覆。

## 需要插件

Synology Chat 是基於插件的，並不是預設核心通道安裝的一部分。

從本地檢出安裝：

```bash
openclaw plugins install ./extensions/synology-chat
```

[[INLINE_1]]: [外掛](/tools/plugin)

## 快速設定

1. 安裝並啟用 Synology Chat 外掛程式。
2. 在 Synology Chat 整合中：
   - 創建一個進來的 webhook 並複製其 URL。
   - 創建一個出去的 webhook 並使用你的秘密 token。
3. 將出去的 webhook URL 指向你的 OpenClaw 閘道：
   - `https://gateway-host/webhook/synology` 預設情況下。
   - 或你的自訂 `channels.synology-chat.webhookPath`。
4. 在 OpenClaw 中設定 `channels.synology-chat`。
5. 重新啟動閘道並向 Synology Chat 機器人發送私訊。

[[BLOCK_1]]  
最小設定：  
[[BLOCK_1]]

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      token: "synology-outgoing-token",
      incomingUrl: "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=...",
      webhookPath: "/webhook/synology",
      dmPolicy: "allowlist",
      allowedUserIds: ["123456"],
      rateLimitPerMinute: 30,
      allowInsecureSsl: false,
    },
  },
}
```

## 環境變數

對於預設帳戶，您可以使用環境變數：

- `SYNOLOGY_CHAT_TOKEN`
- `SYNOLOGY_CHAT_INCOMING_URL`
- `SYNOLOGY_NAS_HOST`
- `SYNOLOGY_ALLOWED_USER_IDS` (以逗號分隔)
- `SYNOLOGY_RATE_LIMIT`
- `OPENCLAW_BOT_NAME`

設定值會覆蓋環境變數。

## DM 政策與存取控制

- `dmPolicy: "allowlist"` 是建議的預設值。
- `allowedUserIds` 接受一個 Synology 使用者 ID 的列表（或以逗號分隔的字串）。
- 在 `allowlist` 模式下，空的 `allowedUserIds` 列表會被視為設定錯誤，並且 webhook 路由將不會啟動（使用 `dmPolicy: "open"` 以允許所有）。
- `dmPolicy: "open"` 允許任何發送者。
- `dmPolicy: "disabled"` 阻擋私訊。
- 配對批准適用於：
  - `openclaw pairing list synology-chat`
  - `openclaw pairing approve synology-chat <CODE>`

## Outbound delivery

使用數字型的 Synology Chat 使用者 ID 作為目標。

範例：

```bash
openclaw message send --channel synology-chat --target 123456 --text "Hello from OpenClaw"
openclaw message send --channel synology-chat --target synology-chat:123456 --text "Hello again"
```

媒體傳送支援基於 URL 的檔案傳遞。

## Multi-account

支援多個 Synology Chat 帳戶在 `channels.synology-chat.accounts` 下。每個帳戶可以覆蓋 token、進入 URL、網頁鉤子路徑、直接訊息政策和限制。

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      accounts: {
        default: {
          token: "token-a",
          incomingUrl: "https://nas-a.example.com/...token=...",
        },
        alerts: {
          token: "token-b",
          incomingUrl: "https://nas-b.example.com/...token=...",
          webhookPath: "/webhook/synology-alerts",
          dmPolicy: "allowlist",
          allowedUserIds: ["987654"],
        },
      },
    },
  },
}
```

## 安全注意事項

- 保持 `token` 的秘密，並在洩漏時進行輪換。
- 除非您明確信任自簽的本地 NAS 憑證，否則請保持 `allowInsecureSsl: false`。
- 進入的 webhook 請求會進行 token 驗證，並根據發送者進行速率限制。
- 在生產環境中，建議使用 `dmPolicy: "allowlist"`。
