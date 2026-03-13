---
summary: "Feishu bot overview, features, and configuration"
read_when:
  - You want to connect a Feishu/Lark bot
  - You are configuring the Feishu channel
title: Feishu
---

# Feishu 機器人

Feishu (Lark) 是一個供公司用於訊息傳遞和協作的團隊聊天平台。這個插件將 OpenClaw 連接到 Feishu/Lark 機器人，利用該平台的 WebSocket 事件訂閱功能，使得可以接收訊息而不需要公開 webhook URL。

---

## Bundled plugin

Feishu 與當前的 OpenClaw 版本一起打包發佈，因此不需要單獨安裝插件。

如果您使用的是舊版或不包含捆綁 Feishu 的自訂安裝，請手動安裝：

```bash
openclaw plugins install @openclaw/feishu
```

---

## 快速入門

有兩種方法可以新增 Feishu 通道：

### 方法 1：入門精靈（推薦）

如果您剛安裝 OpenClaw，請執行精靈：

```bash
openclaw onboard
```

巫師將引導您完成：

1. 創建 Feishu 應用並收集憑證
2. 在 OpenClaw 中設定應用憑證
3. 啟動網關

✅ **設定完成後**，檢查網關狀態：

- `openclaw gateway status`
- `openclaw logs --follow`

### 方法 2：CLI 設定

如果您已經完成初始安裝，請透過 CLI 添加頻道：

```bash
openclaw channels add
```

選擇 **Feishu**，然後輸入應用程式 ID 和應用程式密鑰。

✅ **設定完成後**，管理網關：

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## 步驟 1：建立一個 Feishu 應用程式

### 1. 開啟 Feishu 開放平台

請訪問 [Feishu Open Platform](https://open.feishu.cn/app) 並登入。

Lark（全球）租戶應使用 [https://open.larksuite.com/app](https://open.larksuite.com/app) 並在 Feishu 設定中設置 `domain: "lark"`。

### 2. 創建應用程式

1. 點擊 **建立企業應用程式**
2. 填寫應用程式名稱和描述
3. 選擇應用程式圖示

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. 複製憑證

[[BLOCK_1]]

- **應用程式 ID** (格式: `cli_xxx`)
- **應用程式密鑰**

❗ **重要：** 請保持應用程式密鑰的私密性。

![Get credentials](../images/feishu-step3-credentials.png)

### 4. 設定權限

在 **權限** 中，點擊 **批次匯入** 並貼上：

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "cardkit:card:read",
      "cardkit:card:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. 啟用機器人功能

在 **應用程式功能** > **機器人**:

1. 啟用機器人功能
2. 設定機器人名稱

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. 設定事件訂閱

⚠️ **重要：** 在設定事件訂閱之前，請確保：

1. 你已經為 Feishu 執行了 `openclaw channels add`。
2. 閘道正在執行 (`openclaw gateway status`)。

在 **事件訂閱**:

1. 選擇 **使用長連接接收事件** (WebSocket)
2. 添加事件: `im.message.receive_v1`

⚠️ 如果網關未執行，長連接設置可能無法保存。

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. 發佈應用程式

1. 在 **版本管理與發佈** 中建立一個版本
2. 提交審核並發佈
3. 等待管理員批准（企業應用通常會自動批准）

---

## 步驟 2：設定 OpenClaw

### 使用精靈進行設定（推薦）

```bash
openclaw channels add
```

選擇 **Feishu** 並貼上您的應用程式 ID 和應用程式密鑰。

### 透過設定檔進行設定

`~/.openclaw/openclaw.json`

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

如果您使用 `connectionMode: "webhook"`，請同時設置 `verificationToken` 和 `encryptKey`。Feishu webhook 伺服器預設綁定到 `127.0.0.1`；只有在您需要不同的綁定地址時，才設置 `webhookHost`。

#### 驗證token和加密金鑰 (Webhook 模式)

當使用 webhook 模式時，請在您的設定中設置 `channels.feishu.verificationToken` 和 `channels.feishu.encryptKey`。要獲取這些值：

1. 在 Feishu 開放平台中，打開您的應用程式
2. 前往 **開發** → **事件與回調** (Development → Events & Callbacks)
3. 打開 **加密策略** 標籤 (Encryption tab)
4. 複製 **驗證 Token** 和 **加密金鑰**

下方的螢幕截圖顯示了如何找到 **Verification Token**。**Encrypt Key** 列在同一個 **Encryption** 區域中。

![Verification Token location](../images/feishu-verification-token.png)

### 透過環境變數進行設定

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark (全球) 網域

如果您的租戶使用 Lark（國際版），請將網域設置為 `lark`（或完整的網域字串）。您可以在 `channels.feishu.domain` 或每個帳戶中設置 (`channels.feishu.accounts.<id>.domain`).

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

### 配額優化標誌

您可以透過兩個可選的標誌來減少 Feishu API 的使用：

- `typingIndicator` (預設 `true`): 當 `false` 時，跳過輸入反應調用。
- `resolveSenderNames` (預設 `true`): 當 `false` 時，跳過發送者資料查詢調用。

將它們設置為頂層或每個帳戶：

```json5
{
  channels: {
    feishu: {
      typingIndicator: false,
      resolveSenderNames: false,
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          typingIndicator: true,
          resolveSenderNames: false,
        },
      },
    },
  },
}
```

---

## Step 3: 開始 + 測試

### 1. 啟動網關

```bash
openclaw gateway
```

### 2. 發送測試訊息

在 Feishu 中，找到你的機器人並發送一條消息。

### 3. 批准配對

預設情況下，機器人會回覆一個配對程式碼。請批准它：

```bash
openclaw pairing approve feishu <CODE>
```

在獲得批准後，您可以正常聊天。

---

## 概述

- **Feishu 機器人頻道**: 由網關管理的 Feishu 機器人
- **確定性路由**: 回覆始終返回至 Feishu
- **會話隔離**: 直接訊息共享主會話；群組則是隔離的
- **WebSocket 連接**: 透過 Feishu SDK 的長連接，不需要公共 URL

---

## 存取控制

### 直接訊息

- **預設**: `dmPolicy: "pairing"` (未知用戶獲得配對碼)
- **批准配對**:

```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
```

- **允許清單模式**：設定 `channels.feishu.allowFrom` 以允許的 Open ID。

### 群組聊天

**1. 群組政策** (`channels.feishu.groupPolicy`):

- `"open"` = 允許所有群組中的成員（預設）
- `"allowlist"` = 只允許 `groupAllowFrom`
- `"disabled"` = 禁用群組消息

**2. 提及要求** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = 需要 @提及 (預設)
- `false` = 不使用提及回應

---

## Group configuration examples

### 允許所有群組，要求 @提及（預設）

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### 允許所有群組，不需要 @提及

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### 只允許特定群組

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      // Feishu group IDs (chat_id) look like: oc_xxx
      groupAllowFrom: ["oc_xxx", "oc_yyy"],
    },
  },
}
```

### 限制哪些發件人可以在群組中發送訊息（發件人允許清單）

除了允許該群組本身，**該群組中的所有訊息**都受到發送者 open_id 的限制：只有在 `groups.<chat_id>.allowFrom` 中列出的用戶的訊息會被處理；來自其他成員的訊息將被忽略（這是完整的發送者級別限制，而不僅僅是針對控制指令如 /reset 或 /new）。

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["oc_xxx"],
      groups: {
        oc_xxx: {
          // Feishu user IDs (open_id) look like: ou_xxx
          allowFrom: ["ou_user1", "ou_user2"],
        },
      },
    },
  },
}
```

---

## 獲取群組/使用者 ID

### 群組 ID (chat_id)

Group IDs 看起來像 `oc_xxx`。

**方法 1（推薦）**

1. 啟動網關並在群組中 @提及機器人
2. 執行 `openclaw logs --follow` 並尋找 `chat_id`

**方法 2**

使用 Feishu API 除錯工具列出群組聊天。

### 使用者 ID (open_id)

User IDs 看起來像 `ou_xxx`。

**方法 1（推薦）**

1. 啟動網關並私訊機器人
2. 執行 `openclaw logs --follow` 並尋找 `open_id`

**方法 2**

檢查用戶 Open ID 的配對請求：

```bash
openclaw pairing list feishu
```

---

## 常用指令

| 指令      | 描述           |
| --------- | -------------- |
| `/status` | 顯示機器人狀態 |
| `/reset`  | 重置會話       |
| `/model`  | 顯示/切換模型  |

> 注意：Feishu 尚未支援原生指令選單，因此指令必須以文字形式發送。

## Gateway 管理指令

| 指令                       | 描述              |
| -------------------------- | ----------------- |
| `openclaw gateway status`  | 顯示閘道狀態      |
| `openclaw gateway install` | 安裝/啟動閘道服務 |
| `openclaw gateway stop`    | 停止閘道服務      |
| `openclaw gateway restart` | 重新啟動閘道服務  |
| `openclaw logs --follow`   | 實時查看閘道日誌  |

---

## 故障排除

### 機器人在群組聊天中不回應

1. 確保機器人已被添加到群組中
2. 確保你有 @提及機器人（預設行為）
3. 檢查 `groupPolicy` 是否未設置為 `"disabled"`
4. 檢查日誌：`openclaw logs --follow`

### Bot 無法接收訊息

1. 確保應用程式已發布並獲得批准
2. 確保事件訂閱包含 `im.message.receive_v1`
3. 確保 **長連接** 已啟用
4. 確保應用程式權限完整
5. 確保網關正在執行：`openclaw gateway status`
6. 檢查日誌：`openclaw logs --follow`

### App Secret 洩漏

1. 在飛書開放平台重置應用程式密鑰
2. 在您的設定中更新應用程式密鑰
3. 重新啟動網關

### 訊息發送失敗

1. 確保應用程式擁有 `im:message:send_as_bot` 權限
2. 確保應用程式已發佈
3. 檢查日誌以獲取詳細錯誤資訊

---

## 進階設定

### 多個帳戶

```json5
{
  channels: {
    feishu: {
      defaultAccount: "main",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

`defaultAccount` 控制當外部 API 沒有明確指定 `accountId` 時，使用哪個 Feishu 帳戶。

### 訊息限制

- `textChunkLimit`: 外發文字區塊大小（預設：2000 字元）
- `mediaMaxMb`: 媒體上傳/下載限制（預設：30MB）

### Streaming

Feishu 支援透過互動卡片進行串流回覆。當啟用時，機器人會在生成文本的過程中更新卡片。

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

將 `streaming: false` 設定為在發送之前等待完整的回覆。

### Multi-agent routing

使用 `bindings` 將 Feishu 的私訊或群組路由到不同的代理。

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "direct", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "direct", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

Routing fields:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"direct"` 或 `"group"`
- `match.peer.id`: 使用者 Open ID (`ou_xxx`) 或群組 ID (`oc_xxx`)

請參考 [Get group/user IDs](#get-groupuser-ids) 以獲取查詢提示。

---

## 設定參考

完整設定：[閘道器設定](/gateway/configuration)

關鍵選項：

| 設定                                              | 描述                          | 預設值           |
| ------------------------------------------------- | ----------------------------- | ---------------- |
| `channels.feishu.enabled`                         | 啟用/禁用頻道                 | `true`           |
| `channels.feishu.domain`                          | API 網域 (`feishu` 或 `lark`) | `feishu`         |
| `channels.feishu.connectionMode`                  | 事件傳輸模式                  | `websocket`      |
| `channels.feishu.defaultAccount`                  | 外發路由的預設帳戶 ID         | `default`        |
| `channels.feishu.verificationToken`               | 網頁鉤子模式所需              | -                |
| `channels.feishu.encryptKey`                      | 網頁鉤子模式所需              | -                |
| `channels.feishu.webhookPath`                     | 網頁鉤子路由路徑              | `/feishu/events` |
| `channels.feishu.webhookHost`                     | 網頁鉤子綁定主機              | `127.0.0.1`      |
| `channels.feishu.webhookPort`                     | 網頁鉤子綁定埠口              | `3000`           |
| `channels.feishu.accounts.<id>.appId`             | 應用程式 ID                   | -                |
| `channels.feishu.accounts.<id>.appSecret`         | 應用程式密鑰                  | -                |
| `channels.feishu.accounts.<id>.domain`            | 每個帳戶的 API 網域覆蓋       | `feishu`         |
| `channels.feishu.dmPolicy`                        | DM 政策                       | `pairing`        |
| `channels.feishu.allowFrom`                       | DM 允許清單 (open_id 清單)    | -                |
| `channels.feishu.groupPolicy`                     | 群組政策                      | `open`           |
| `channels.feishu.groupAllowFrom`                  | 群組允許清單                  | -                |
| `channels.feishu.groups.<chat_id>.requireMention` | 需要 @提及                    | `true`           |
| `channels.feishu.groups.<chat_id>.enabled`        | 啟用群組                      | `true`           |
| `channels.feishu.textChunkLimit`                  | 訊息區塊大小                  | `2000`           |
| `channels.feishu.mediaMaxMb`                      | 媒體大小限制                  | `30`             |
| `channels.feishu.streaming`                       | 啟用串流卡片輸出              | `true`           |
| `channels.feishu.blockStreaming`                  | 啟用區塊串流                  | `true`           |

---

## dmPolicy 參考資料

| 值            | 行為                                          |
| ------------- | --------------------------------------------- |
| `"pairing"`   | **預設。** 未知用戶會獲得配對碼；必須經過批准 |
| `"allowlist"` | 只有 `allowFrom` 中的用戶可以聊天             |
| `"open"`      | 允許所有用戶（需要 `"*"` 在 allowFrom 中）    |
| `"disabled"`  | 禁用私訊                                      |

---

## 支援的訊息類型

### Receive

- ✅ 文字
- ✅ 富文本 (貼文)
- ✅ 圖片
- ✅ 檔案
- ✅ 音訊
- ✅ 影片
- ✅ 貼圖

### Send

- ✅ 文字
- ✅ 圖片
- ✅ 檔案
- ✅ 音訊
- ⚠️ 富文本（部分支援）
