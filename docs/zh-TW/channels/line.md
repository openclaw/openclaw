---
summary: "LINE Messaging API 外掛程式設定、組態與使用"
read_when:
  - 您想將 OpenClaw 連接到 LINE
  - 您需要設定 LINE webhook + 憑證
  - 您想要 LINE 專屬的訊息選項
title: LINE
---

# LINE (外掛程式)

LINE 透過 LINE Messaging API 連接到 OpenClaw。此外掛程式作為 webhook 接收器在 Gateway 上執行，並使用您的頻道存取權杖 + 頻道密鑰進行驗證。

狀態：透過外掛程式支援。支援私訊、群組聊天、媒體、位置、Flex 訊息、範本訊息和快速回覆。不支援反應和執行緒。

## 需要外掛程式

安裝 LINE 外掛程式：

```bash
openclaw plugins install @openclaw/line
```

本地結帳 (從 git 儲存庫執行時)：

```bash
openclaw plugins install ./extensions/line
```

## 設定

1. 建立 LINE Developers 帳戶並開啟控制台：
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. 建立（或選擇）供應商並新增 **Messaging API** 頻道。
3. 從頻道設定中複製 **Channel access token** 和 **Channel secret**。
4. 在 Messaging API 設定中啟用 **Use webhook**。
5. 將 webhook URL 設定為您的 Gateway 端點 (需要 HTTPS)：

```
https://gateway-host/line/webhook
```

Gateway 會回應 LINE 的 webhook 驗證 (GET) 和入站事件 (POST)。如果您需要自訂路徑，請設定 `channels.line.webhookPath` 或 `channels.line.accounts.<id>.webhookPath` 並相應更新 URL。

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

環境變數（僅限預設帳戶）：

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

權杖/密鑰檔案：

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

多個帳戶：

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

私訊預設為配對。未知寄件者會收到配對碼，在獲得批准之前其訊息將被忽略。

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

允許清單與策略：

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: 允許清單中的 LINE 使用者 ID (用於私訊)
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: 允許清單中的 LINE 使用者 ID (用於群組)
- 每個群組的覆寫：`channels.line.groups.<groupId>.allowFrom`

LINE ID 區分大小寫。有效的 ID 如下所示：

- 使用者：`U` + 32 個十六進位字元
- 群組：`C` + 32 個十六進位字元
- 聊天室：`R` + 32 個十六進位字元

## 訊息行為

- 文本以 5000 個字元為單位分塊。
- Markdown 格式會被移除；程式碼區塊和表格會盡可能轉換為 Flex 卡片。
- 串流回應會被緩衝；當智慧代理工作時，LINE 會收到完整的區塊並顯示載入動畫。
- 媒體下載受 `channels.line.mediaMaxMb` 限制（預設為 10）。

## 頻道資料 (豐富訊息)

使用 `channelData.line` 傳送快速回覆、位置、Flex 卡片或範本訊息。

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

LINE 外掛程式還提供 `/card` 指令，用於 Flex 訊息預設值：

```
/card info "Welcome" "Thanks for joining!"
```

## 疑難排解

- **Webhook 驗證失敗：** 請確保 webhook URL 為 HTTPS 且 `channelSecret` 與 LINE 控制台中的資訊相符。
- **沒有入站事件：** 確認 webhook 路徑與 `channels.line.webhookPath` 相符，且 Gateway 可從 LINE 存取。
- **媒體下載錯誤：** 如果媒體超過預設限制，請提高 `channels.line.mediaMaxMb`。
```
