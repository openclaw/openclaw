---
summary: "LINE Messaging API 外掛程式設定、組態與用法"
read_when:
  - 您想將 OpenClaw 連線至 LINE
  - 您需要設定 LINE Webhook 與憑證
  - 您想使用 LINE 特有的訊息選項
title: LINE
---

# LINE (外掛程式)

LINE 透過 LINE Messaging API 連線至 OpenClaw。此外掛程式在 Gateway 上作為 Webhook 接收器運作，並使用您的 Channel Access Token 與 Channel Secret 進行身分驗證。

狀態：透過外掛程式支援。支援私訊、群組對話、媒體、位置、Flex 訊息、樣板訊息與快速回覆。不支援表情貼反應與對話串。

## 需要外掛程式

安裝 LINE 外掛程式：

```bash
openclaw plugins install @openclaw/line
```

本地檢出（從 Git 儲存庫執行時）：

```bash
openclaw plugins install ./extensions/line
```

## 設定

1. 建立 LINE Developers 帳號並開啟主控台：
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. 建立（或選擇）一個供應商 (Provider) 並新增一個 **Messaging API** 頻道。
3. 從頻道設定中複製 **Channel access token** 與 **Channel secret**。
4. 在 Messaging API 設定中啟用 **Use webhook**。
5. 將 Webhook URL 設定為您的 Gateway 端點（需要 HTTPS）：

```
https://gateway-host/line/webhook
```

Gateway 會回應 LINE 的 Webhook 驗證 (GET) 與傳入事件 (POST)。如果您需要自訂路徑，請設定 `channels.line.webhookPath` 或 `channels.line.accounts.<id>.webhookPath` 並相應更新 URL。

## 組態設定

最簡設定：

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

環境變數（僅限預設帳號）：

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Token/Secret 檔案：

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

多個帳號：

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

私訊預設為配對模式。未知的傳送者會收到配對碼，其訊息將被忽略直到獲得核准。

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

允許清單與策略：

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: 私訊的允許清單 LINE 使用者 ID
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: 群組的允許清單 LINE 使用者 ID
- 個別群組覆寫：`channels.line.groups.<groupId>.allowFrom`

LINE ID 區分大小寫。有效的 ID 格式如下：

- 使用者：`U` + 32 位十六進位字元
- 群組：`C` + 32 位十六進位字元
- 聊天室：`R` + 32 位十六進位字元

## 訊息行為

- 文字會在 5000 個字元處分段。
- Markdown 格式會被移除；程式碼區塊與表格會盡可能轉換為 Flex 卡片。
- 串流回應會被緩衝；LINE 會在智慧代理運作時接收完整區塊，並顯示載入中動畫。
- 媒體下載限制由 `channels.line.mediaMaxMb` 設定（預設為 10）。

## 頻道資料（多樣化訊息）

使用 `channelData.line` 來傳送快速回覆、位置、Flex 卡片或樣板訊息。

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
          /* Flex 承載內容 */
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

LINE 外掛程式還提供了一個 `/card` 指令用於 Flex 訊息預設集：

```
/card info "Welcome" "Thanks for joining!"
```

## 疑難排解

- **Webhook 驗證失敗：** 請確保 Webhook URL 使用 HTTPS，且 `channelSecret` 與 LINE 主控台相符。
- **沒有傳入事件：** 請確認 Webhook 路徑與 `channels.line.webhookPath` 相符，且 LINE 可以連線至 Gateway。
- **媒體下載錯誤：** 如果媒體大小超過預設限制，請調高 `channels.line.mediaMaxMb`。
