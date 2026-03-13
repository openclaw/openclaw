---
summary: "LINE Messaging API plugin setup, config, and usage"
read_when:
  - You want to connect OpenClaw to LINE
  - You need LINE webhook + credential setup
  - You want LINE-specific message options
title: LINE
---

# LINE (插件)

LINE 通過 LINE Messaging API 連接到 OpenClaw。該插件作為網關上的 webhook 接收器執行，並使用您的頻道存取token + 頻道密鑰進行身份驗證。

狀態：透過插件支援。支援直接訊息、群組聊天、媒體、位置、Flex 訊息、範本訊息和快速回覆。不支援反應和主題。

## 需要插件

安裝 LINE 插件：

```bash
openclaw plugins install @openclaw/line
```

[[BLOCK_1]] 本地檢出（當從 git 倉庫執行時）：[[BLOCK_1]]

```bash
openclaw plugins install ./extensions/line
```

## Setup

1. 創建一個 LINE Developers 帳戶並打開控制台：
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. 創建（或選擇）一個提供者並添加一個 **Messaging API** 通道。
3. 從通道設定中複製 **Channel access token** 和 **Channel secret**。
4. 在 Messaging API 設定中啟用 **Use webhook**。
5. 將 webhook URL 設定為您的網關端點（需要 HTTPS）：

```
https://gateway-host/line/webhook
```

網關會回應 LINE 的 webhook 驗證 (GET) 及進入事件 (POST)。如果您需要自訂路徑，請設定 `channels.line.webhookPath` 或 `channels.line.accounts.<id>.webhookPath` 並相應地更新 URL。

安全注意事項：

- LINE 簽名驗證是依賴於主體的（對原始主體進行 HMAC），因此 OpenClaw 在驗證之前會應用嚴格的預先驗證主體限制和超時。

## Configure

[[BLOCK_1]]  
最小設定：  
[[BLOCK_1]]

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

Token/secret files:

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

`tokenFile` 和 `secretFile` 必須指向常規檔案。符號連結將被拒絕。

[[BLOCK_1]]

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

直接訊息預設為配對模式。未知發件者會獲得一個配對程式碼，並且他們的訊息在獲得批准之前會被忽略。

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

[[BLOCK_1]]  
所有允許清單和政策：  
[[BLOCK_1]]

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: 允許的 LINE 使用者 ID 用於私訊
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: 允許的 LINE 使用者 ID 用於群組
- 每個群組的覆蓋設定: `channels.line.groups.<groupId>.allowFrom`
- 執行時注意事項: 如果 `channels.line` 完全缺失，執行時將回退到 `groupPolicy="allowlist"` 進行群組檢查（即使 `channels.defaults.groupPolicy` 已設定）。

LINE ID 是區分大小寫的。有效的 ID 看起來像是：

- User: `U` + 32 個十六進位字元
- Group: `C` + 32 個十六進位字元
- Room: `R` + 32 個十六進位字元

## Message behavior

- 文字以 5000 字元為單位進行分段。
- Markdown 格式被移除；程式碼區塊和表格在可能的情況下轉換為 Flex 卡片。
- 串流回應會被緩衝；LINE 接收完整的分段，並在代理處理時顯示加載動畫。
- 媒體下載的上限為 `channels.line.mediaMaxMb`（預設為 10）。

## Channel data (rich messages)

使用 `channelData.line` 來發送快速回覆、位置、Flex 卡片或範本訊息。

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

LINE 插件還提供了一個 `/card` 指令，用於 Flex 訊息預設：

```
/card info "Welcome" "Thanks for joining!"
```

## 故障排除

- **Webhook 驗證失敗：** 確保 webhook URL 為 HTTPS 並且 `channelSecret` 與 LINE 控制台相符。
- **沒有進來的事件：** 確認 webhook 路徑與 `channels.line.webhookPath` 相符，並且網關可以從 LINE 訪問。
- **媒體下載錯誤：** 如果媒體超過預設限制，請提出 `channels.line.mediaMaxMb`。
