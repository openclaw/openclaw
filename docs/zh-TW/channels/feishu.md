---
summary: "飛書機器人總覽、功能與設定"
read_when:
  - 您想連接飛書/Lark 機器人
  - 您正在設定飛書頻道
title: 飛書
---

# 飛書機器人

飛書 (Lark) 是一個團隊聊天平台，公司使用它來進行訊息傳送和協作。這個外掛程式透過平台基於 WebSocket 的事件訂閱將 OpenClaw 連接到飛書/Lark 機器人，這樣無需暴露公開的 Webhook URL 即可接收訊息。

---

## 需要外掛程式

安裝飛書外掛程式：

```bash
openclaw plugins install @openclaw/feishu
```

本地結帳 (從 git repo 執行時)：

```bash
openclaw plugins install ./extensions/feishu
```

---

## 快速開始

有兩種方法可以新增飛書頻道：

### 方法 1：新手導覽精靈 (建議)

如果您剛安裝 OpenClaw，請執行精靈：

```bash
openclaw onboard
```

精靈將引導您完成：

1. 建立飛書應用程式並收集憑證
2. 在 OpenClaw 中設定應用程式憑證
3. 啟動 Gateway

✅ **設定完成後**，檢查 Gateway 狀態：

- `openclaw gateway status`
- `openclaw logs --follow`

### 方法 2：CLI 設定

如果您已完成初始安裝，請透過 CLI 新增頻道：

```bash
openclaw channels add
```

選擇 **Feishu**，然後輸入 App ID 和 App Secret。

✅ **設定完成後**，管理 Gateway：

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## 步驟 1：建立飛書應用程式

### 1. 開啟飛書開放平台

造訪 [飛書開放平台](https://open.feishu.cn/app) 並登入。

Lark (全球) 租戶應使用 [https://open.larksuite.com/app](https://open.larksuite.com/app) 並在飛書設定中設定 `domain: "lark"`。

### 2. 建立應用程式

1. 點擊 **Create enterprise app**
2. 填寫應用程式名稱 + 描述
3. 選擇應用程式圖示

![建立企業應用程式](../images/feishu-step2-create-app.png)

### 3. 複製憑證

從 **Credentials & Basic Info** 中，複製：

- **App ID** (格式：`cli_xxx`)
- **App Secret**

❗ **重要**：請將 App Secret 保密。

![取得憑證](../images/feishu-step3-credentials.png)

### 4. 設定權限

在 **Permissions** 上，點擊 **Batch import** 並貼上：

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
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

![設定權限](../images/feishu-step4-permissions.png)

### 5. 啟用機器人功能

在 **App Capability** > **Bot** 中：

1. 啟用機器人功能
2. 設定機器人名稱

![啟用機器人功能](../images/feishu-step5-bot-capability.png)

### 6. 設定事件訂閱

⚠️ **重要**：在設定事件訂閱之前，請確保：

1. 您已執行 `openclaw channels add` 以新增飛書頻道
2. Gateway 正在運行 (`openclaw gateway status`)

在 **Event Subscription** 中：

1. 選擇 **Use long connection to receive events** (WebSocket)
2. 新增事件：`im.message.receive_v1`

⚠️ 如果 Gateway 未運行，長連接設定可能無法儲存。

![設定事件訂閱](../images/feishu-step6-event-subscription.png)

### 7. 發佈應用程式

1. 在 **Version Management & Release** 中建立版本
2. 提交審核並發佈
3. 等待管理員批准 (企業應用程式通常會自動批准)

---

## 步驟 2：設定 OpenClaw

### 使用精靈設定 (建議)

```bash
openclaw channels add
```

選擇 **Feishu** 並貼上您的 App ID + App Secret。

### 透過設定檔案設定

編輯 `~/.openclaw/openclaw.json`：

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

### 透過環境變數設定

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark (全球) 網域

如果您的租戶位於 Lark (國際)，請將網域設定為 `lark` (或完整的網域字串)。您可以將其設定在 `channels.feishu.domain` 或每個帳戶 (`channels.feishu.accounts.<id>.domain`)。

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

---

## 步驟 3：啟動 + 測試

### 1. 啟動 Gateway

```bash
openclaw gateway
```

### 2. 傳送測試訊息

在飛書中，找到您的機器人並傳送一則訊息。

### 3. 批准配對

預設情況下，機器人會回覆一個配對碼。批准它：

```bash
openclaw pairing approve feishu <CODE>
```

批准後，您可以正常聊天。

---

## 總覽

- **飛書機器人頻道**：由 Gateway 管理的飛書機器人
- **確定性路由**：回覆訊息始終會返回到飛書
- **工作階段隔離**：私訊共用主要工作階段；群組則相互隔離
- **WebSocket 連線**：透過飛書 SDK 進行長連線，無需公開 URL

---

## 存取控制

### 私訊

- **預設**：`dmPolicy: "pairing"` (未知的使用者會收到配對碼；必須批准)
- **批准配對**：

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **白名單模式**：使用 `channels.feishu.allowFrom` 設定允許的 Open IDs

### 群組聊天

**1. 群組策略** (`channels.feishu.groupPolicy`)：

- `"open"` = 允許所有人在群組中 (預設)
- `"allowlist"` = 只允許 `groupAllowFrom` 中的成員
- `"disabled"` = 禁用群組訊息

**2. 提及要求** (`channels.feishu.groups.<chat_id>.requireMention`)：

- `true` = 需要 @提及 (預設)
- `false` = 無需提及即可回應

---

## 群組設定範例

### 允許所有群組，需要 @提及 (預設)

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

### 允許所有群組，無需 @提及

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

### 只允許群組中的特定使用者

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## 取得群組/使用者 ID

### 群組 ID (chat_id)

群組 ID 看起來像 `oc_xxx`。

**方法 1 (建議)**

1. 啟動 Gateway 並在群組中 @提及機器人
2. 執行 `openclaw logs --follow` 並尋找 `chat_id`

**方法 2**

使用飛書 API 偵錯工具列出群組聊天。

### 使用者 ID (open_id)

使用者 ID 看起來像 `ou_xxx`。

**方法 1 (建議)**

1. 啟動 Gateway 並私訊機器人
2. 執行 `openclaw logs --follow` 並尋找 `open_id`

**方法 2**

檢查配對請求以獲取使用者 Open ID：

```bash
openclaw pairing list feishu
```

---

## 常用命令

| 命令        | 描述         |
| ----------- | ------------ |
| `/status`   | 顯示機器人狀態 |
| `/reset`    | 重置工作階段 |
| `/model`    | 顯示/切換模型 |

> 注意：飛書尚不支援原生命令選單，因此命令必須以文字形式傳送。

## Gateway 管理命令

| 命令                       | 描述               |
| -------------------------- | ------------------ |
| `openclaw gateway status`  | 顯示 Gateway 狀態  |
| `openclaw gateway install` | 安裝/啟動 Gateway 服務 |
| `openclaw gateway stop`    | 停止 Gateway 服務  |
| `openclaw gateway restart` | 重新啟動 Gateway 服務 |
| `openclaw logs --follow`   | 追蹤 Gateway 日誌  |

---

## 疑難排解

### 機器人沒有在群組聊天中回應

1. 確保機器人已新增到群組中
2. 確保您已 @提及機器人 (預設行為)
3. 檢查 `groupPolicy` 是否未設定為 `"disabled"`
4. 檢查日誌：`openclaw logs --follow`

### 機器人沒有收到訊息

1. 確保應用程式已發佈並批准
2. 確保事件訂閱包含 `im.message.receive_v1`
3. 確保已啟用**長連線**
4. 確保應用程式權限完整
5. 確保 Gateway 正在運行：`openclaw gateway status`
6. 檢查日誌：`openclaw logs --follow`

### App Secret 洩漏

1. 在飛書開放平台重置 App Secret
2. 在您的設定中更新 App Secret
3. 重新啟動 Gateway

### 訊息傳送失敗

1. 確保應用程式擁有 `im:message:send_as_bot` 權限
2. 確保應用程式已發佈
3. 檢查日誌以獲取詳細錯誤

---

## 進階設定

### 多個帳戶

```json5
{
  channels: {
    feishu: {
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

### 訊息限制

- `textChunkLimit`： outbound 文字區塊大小 (預設：2000 個字元)
- `mediaMaxMb`：媒體上傳/下載限制 (預設：30MB)

### 串流

飛書透過互動式卡片支援串流回覆。啟用後，機器人會在產生文字時更新卡片。

```json5
{
  channels: {
    feishu: {
      streaming: true, // 啟用串流卡片輸出 (預設為 true)
      blockStreaming: true, // 啟用區塊串流傳輸 (預設為 true)
    },
  },
}
```

設定 `streaming: false` 可在傳送完整回覆之前等待。

### 多智慧代理路由

使用 `bindings` 將飛書私訊或群組路由到不同的智慧代理。

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

路由欄位：

- `match.channel`：`"feishu"`
- `match.peer.kind`：`"direct"` 或 `"group"`
- `match.peer.id`：使用者 Open ID (`ou_xxx`) 或群組 ID (`oc_xxx`)

請參閱 [取得群組/使用者 ID](#get-groupuser-ids) 以獲取查詢提示。

---

## 設定參考

完整設定：[Gateway 設定](/gateway/configuration)

主要選項：

| 設定                                           | 描述                     | 預設值   |
| ------------------------------------------------- | ------------------------------- | --------- |
| `channels.feishu.enabled`                         | 啟用/停用頻道              | `true`    |
| `channels.feishu.domain`                          | API 網域 (`feishu` 或 `lark`) | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | 應用程式 ID                      | -         |
| `channels.feishu.accounts.<id>.appSecret`         | 應用程式密鑰                  | -         |
| `channels.feishu.accounts.<id>.domain`            | 每個帳戶的 API 網域覆寫 | `feishu`  |
| `channels.feishu.dmPolicy`                        | 私訊策略                     | `pairing` |
| `channels.feishu.allowFrom`                       | 私訊白名單 (open_id 列表) | -         |
| `channels.feishu.groupPolicy`                     | 群組策略                     | `open`    |
| `channels.feishu.groupAllowFrom`                  | 群組白名單                  | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | 需要 @提及                  | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | 啟用群組                     | `true`    |
| `channels.feishu.textChunkLimit`                  | 訊息區塊大小                  | `2000`    |
| `channels.feishu.mediaMaxMb`                      | 媒體大小限制                  | `30`      |
| `channels.feishu.streaming`                       | 啟用串流卡片輸出            | `true`    |
| `channels.feishu.blockStreaming`                  | 啟用區塊串流傳輸            | `true`    |

---

## dmPolicy 參考

| 值          | 行為                                                              |
| ----------- | --------------------------------------------------------------- |
| `"pairing"`   | **預設。** 未知的使用者會收到配對碼；必須批准                           |
| `"allowlist"` | 只有 `allowFrom` 中的使用者可以聊天                             |
| `"open"`      | 允許所有使用者 (需要在 allowFrom 中有 `"*"` )                   |
| `"disabled"`  | 禁用私訊                                                          |

---

## 支援的訊息類型

### 接收

- ✅ 文字
- ✅ 富文本 (貼文)
- ✅ 圖片
- ✅ 檔案
- ✅ 音訊
- ✅ 影片
- ✅ 貼圖

### 傳送

- ✅ 文字
- ✅ 圖片
- ✅ 檔案
- ✅ 音訊
- ⚠️ 富文本 (部分支援)
