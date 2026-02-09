---
summary: "LINE Messaging API 外掛程式的設定、設定方式與使用說明"
read_when:
  - 你想要將 OpenClaw 連接至 LINE
  - 你需要設定 LINE webhook 與憑證
  - 你想要使用 LINE 專屬的訊息選項
title: LINE
---

# LINE（外掛程式）

LINE 透過 LINE Messaging API 連接至 OpenClaw。此外掛程式在 Gateway 閘道器 上以 webhook
接收器的形式執行，並使用你的 channel access token 與 channel secret 進行
身分驗證。 The plugin runs as a webhook
receiver on the gateway and uses your channel access token + channel secret for
authentication.

Status: supported via plugin. Direct messages, group chats, media, locations, Flex
messages, template messages, and quick replies are supported. Reactions and threads
are not supported.

## Plugin required

安裝 LINE 外掛程式：

```bash
openclaw plugins install @openclaw/line
```

本地檢出（從 git 儲存庫執行時）：

```bash
openclaw plugins install ./extensions/line
```

## 設定

1. 建立 LINE Developers 帳號並開啟 Console：
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. 建立（或選擇）一個 Provider，並新增 **Messaging API** channel。
3. 從 channel 設定中複製 **Channel access token** 與 **Channel secret**。
4. 在 Messaging API 設定中啟用 **Use webhook**。
5. 將 webhook URL 設為你的 Gateway 閘道器 端點（必須為 HTTPS）：

```
https://gateway-host/line/webhook
```

Gateway 閘道器 會回應 LINE 的 webhook 驗證（GET）與傳入事件（POST）。
如果你需要自訂路徑，請設定 `channels.line.webhookPath` 或
`channels.line.accounts.<id>
If you need a custom path, set `channels.line.webhookPath`or`channels.line.accounts.<id>.webhookPath\`，並相應更新 URL。

## 設定

最小設定：

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Env vars (default account only):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

權杖／密鑰檔案：

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

多帳號：

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## 存取控制

Direct messages default to pairing. 私訊預設需要配對。未知的寄件者會收到配對碼，其訊息在核准前將被忽略。

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

允許清單與政策：

- `channels.line.dmPolicy`：`pairing | allowlist | open | disabled`
- `channels.line.allowFrom`：用於私訊的允許清單 LINE 使用者 ID
- `channels.line.groupPolicy`：`allowlist | open | disabled`
- `channels.line.groupAllowFrom`：用於群組的允許清單 LINE 使用者 ID
- 每個群組的覆寫設定：`channels.line.groups.<groupId>.allowFrom`

LINE IDs are case-sensitive. Valid IDs look like:

- 使用者：`U` + 32 個十六進位字元
- 群組：`C` + 32 個十六進位字元
- Room：`R` + 32 個十六進位字元

## Message behavior

- 文字會在 5000 個字元處分段。
- Markdown 格式會被移除；程式碼區塊與表格在可能的情況下會轉換為 Flex
  卡片。
- 串流回應會先緩衝；在代理程式運作期間，LINE 會收到完整的區塊並顯示載入
  動畫。
- 媒體下載數量受 `channels.line.mediaMaxMb` 限制（預設為 10）。

## Channel 資料（豐富訊息）

使用 `channelData.line` 來傳送快速回覆、位置、Flex 卡片或範本
訊息。

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

LINE 外掛程式也提供一個用於 Flex 訊息預設的 `/card` 指令：

```
/card info "Welcome" "Thanks for joining!"
```

## Troubleshooting

- **Webhook 驗證失敗：** 確保 webhook URL 為 HTTPS，且
  `channelSecret` 與 LINE Console 中的設定一致。
- **沒有傳入事件：** 確認 webhook 路徑與 `channels.line.webhookPath`
  相符，且 Gateway 閘道器 可從 LINE 存取。
- **媒體下載錯誤：** 若媒體超過預設限制，請提高 `channels.line.mediaMaxMb`。
