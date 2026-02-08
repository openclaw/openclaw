---
summary: 「Feishu 機器人概覽、功能與設定」
read_when:
  - 「你想要連接 Feishu／Lark 機器人」
  - 「你正在設定 Feishu 頻道」
title: Feishu
x-i18n:
  source_path: channels/feishu.md
  source_hash: c9349983562d1a98
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:10Z
---

# Feishu 機器人

Feishu（Lark）是一個供企業用於訊息傳遞與協作的團隊聊天平台。此外掛會使用平台的 WebSocket 事件訂閱，將 OpenClaw 連接到 Feishu／Lark 機器人，讓系統在不暴露公用 webhook URL 的情況下接收訊息。

---

## 需要的外掛

安裝 Feishu 外掛：

```bash
openclaw plugins install @openclaw/feishu
```

本機檢出（從 git repo 執行時）：

```bash
openclaw plugins install ./extensions/feishu
```

---

## 快速開始

新增 Feishu 頻道有兩種方式：

### 方法 1：入門引導精靈（建議）

如果你剛安裝 OpenClaw，請執行精靈：

```bash
openclaw onboard
```

精靈會引導你完成：

1. 建立 Feishu 應用程式並收集憑證
2. 在 OpenClaw 中設定應用程式憑證
3. 啟動 Gateway 閘道器

✅ **完成設定後**，檢查 Gateway 閘道器狀態：

- `openclaw gateway status`
- `openclaw logs --follow`

### 方法 2：CLI 設定

如果你已完成初始安裝，請透過 CLI 新增頻道：

```bash
openclaw channels add
```

選擇 **Feishu**，然後輸入 App ID 與 App Secret。

✅ **完成設定後**，管理 Gateway 閘道器：

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## 步驟 1：建立 Feishu 應用程式

### 1. 開啟 Feishu 開放平台

前往 [Feishu Open Platform](https://open.feishu.cn/app) 並登入。

Lark（全球）租戶請使用 [https://open.larksuite.com/app](https://open.larksuite.com/app)，並在 Feishu 設定中設定 `domain: "lark"`。

### 2. 建立應用程式

1. 點擊 **Create enterprise app**
2. 填寫應用程式名稱與描述
3. 選擇應用程式圖示

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. 複製憑證

在 **Credentials & Basic Info** 中複製：

- **App ID**（格式：`cli_xxx`）
- **App Secret**

❗ **重要：** 請妥善保管 App Secret，勿外洩。

![Get credentials](../images/feishu-step3-credentials.png)

### 4. 設定權限

在 **Permissions** 中，點擊 **Batch import** 並貼上：

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

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. 啟用機器人能力

在 **App Capability** > **Bot**：

1. 啟用機器人能力
2. 設定機器人名稱

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. 設定事件訂閱

⚠️ **重要：** 在設定事件訂閱前，請確認：

1. 你已為 Feishu 執行 `openclaw channels add`
2. Gateway 閘道器正在執行（`openclaw gateway status`）

在 **Event Subscription** 中：

1. 選擇 **Use long connection to receive events**（WebSocket）
2. 新增事件：`im.message.receive_v1`

⚠️ 如果 Gateway 閘道器未執行，長連線設定可能無法儲存。

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. 發佈應用程式

1. 在 **Version Management & Release** 中建立版本
2. 提交審核並發佈
3. 等待管理員核准（企業應用程式通常會自動核准）

---

## 步驟 2：設定 OpenClaw

### 使用精靈設定（建議）

```bash
openclaw channels add
```

選擇 **Feishu**，並貼上你的 App ID 與 App Secret。

### 透過設定檔設定

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

### Lark（全球）網域

如果你的租戶位於 Lark（國際版），請將網域設定為 `lark`（或完整的網域字串）。你可以在 `channels.feishu.domain` 或每個帳號（`channels.feishu.accounts.<id>.domain`）中設定。

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

## 步驟 3：啟動與測試

### 1. 啟動 Gateway 閘道器

```bash
openclaw gateway
```

### 2. 傳送測試訊息

在 Feishu 中找到你的機器人並傳送訊息。

### 3. 核准配對

預設情況下，機器人會回覆一組配對碼。請核准：

```bash
openclaw pairing approve feishu <CODE>
```

核准後即可正常聊天。

---

## 概覽

- **Feishu 機器人頻道**：由 Gateway 閘道器管理的 Feishu 機器人
- **確定性路由**：回覆一律返回 Feishu
- **工作階段隔離**：私訊共用主要工作階段；群組彼此隔離
- **WebSocket 連線**：透過 Feishu SDK 的長連線，無需公用 URL

---

## 存取控制

### 私訊

- **預設**：`dmPolicy: "pairing"`（未知使用者會收到配對碼）
- **核准配對**：

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **允許清單模式**：設定 `channels.feishu.allowFrom` 並指定允許的 Open ID

### 群組聊天

**1. 群組政策**（`channels.feishu.groupPolicy`）：

- `"open"` = 允許群組中的所有人（預設）
- `"allowlist"` = 僅允許 `groupAllowFrom`
- `"disabled"` = 停用群組訊息

**2. 提及需求**（`channels.feishu.groups.<chat_id>.requireMention`）：

- `true` = 需要 @提及（預設）
- `false` = 無需提及即可回覆

---

## 群組設定範例

### 允許所有群組，需 @提及（預設）

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

### 允許所有群組，不需 @提及

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

### 僅允許特定使用者於群組中

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

## 取得群組／使用者 ID

### 群組 ID（chat_id）

群組 ID 看起來像 `oc_xxx`。

**方法 1（建議）**

1. 啟動 Gateway 閘道器，並在群組中 @提及機器人
2. 執行 `openclaw logs --follow`，並尋找 `chat_id`

**方法 2**

使用 Feishu API 偵錯工具列出群組聊天。

### 使用者 ID（open_id）

使用者 ID 看起來像 `ou_xxx`。

**方法 1（建議）**

1. 啟動 Gateway 閘道器並私訊機器人
2. 執行 `openclaw logs --follow`，並尋找 `open_id`

**方法 2**

檢查配對請求以取得使用者 Open ID：

```bash
openclaw pairing list feishu
```

---

## 常用指令

| 指令      | 說明           |
| --------- | -------------- |
| `/status` | 顯示機器人狀態 |
| `/reset`  | 重置工作階段   |
| `/model`  | 顯示／切換模型 |

> 注意：Feishu 目前尚未支援原生命令選單，因此必須以文字方式傳送指令。

## Gateway 閘道器管理指令

| 指令                       | 說明                          |
| -------------------------- | ----------------------------- |
| `openclaw gateway status`  | 顯示 Gateway 閘道器狀態       |
| `openclaw gateway install` | 安裝／啟動 Gateway 閘道器服務 |
| `openclaw gateway stop`    | 停止 Gateway 閘道器服務       |
| `openclaw gateway restart` | 重新啟動 Gateway 閘道器服務   |
| `openclaw logs --follow`   | 追蹤 Gateway 閘道器日誌       |

---

## 疑難排解

### 機器人在群組聊天中沒有回應

1. 確認機器人已加入群組
2. 確認你有 @提及機器人（預設行為）
3. 檢查 `groupPolicy` 是否未設定為 `"disabled"`
4. 檢查日誌：`openclaw logs --follow`

### 機器人未接收訊息

1. 確認應用程式已發佈並核准
2. 確認事件訂閱包含 `im.message.receive_v1`
3. 確認已啟用 **長連線**
4. 確認應用程式權限完整
5. 確認 Gateway 閘道器正在執行：`openclaw gateway status`
6. 檢查日誌：`openclaw logs --follow`

### App Secret 外洩

1. 在 Feishu 開放平台中重設 App Secret
2. 更新設定中的 App Secret
3. 重新啟動 Gateway 閘道器

### 訊息傳送失敗

1. 確認應用程式具有 `im:message:send_as_bot` 權限
2. 確認應用程式已發佈
3. 檢查日誌以取得詳細錯誤

---

## 進階設定

### 多帳號

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

- `textChunkLimit`：外送文字分塊大小（預設：2000 字元）
- `mediaMaxMb`：媒體上傳／下載限制（預設：30MB）

### 串流

Feishu 透過互動式卡片支援串流回覆。啟用後，機器人會在產生文字時持續更新卡片。

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

設定 `streaming: false` 以在傳送前等待完整回覆。

### 多代理程式路由

使用 `bindings` 將 Feishu 私訊或群組路由至不同的代理程式。

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
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
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
- `match.peer.kind`：`"dm"` 或 `"group"`
- `match.peer.id`：使用者 Open ID（`ou_xxx`）或群組 ID（`oc_xxx`）

查詢技巧請參考 [取得群組／使用者 ID](#get-groupuser-ids)。

---

## 設定參考

完整設定：[Gateway configuration](/gateway/configuration)

主要選項：

| 設定                                              | 說明                           | 預設值    |
| ------------------------------------------------- | ------------------------------ | --------- |
| `channels.feishu.enabled`                         | 啟用／停用頻道                 | `true`    |
| `channels.feishu.domain`                          | API 網域（`feishu` 或 `lark`） | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | App ID                         | -         |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                     | -         |
| `channels.feishu.accounts.<id>.domain`            | 每帳號 API 網域覆寫            | `feishu`  |
| `channels.feishu.dmPolicy`                        | 私訊政策                       | `pairing` |
| `channels.feishu.allowFrom`                       | 私訊允許清單（open_id 清單）   | -         |
| `channels.feishu.groupPolicy`                     | 群組政策                       | `open`    |
| `channels.feishu.groupAllowFrom`                  | 群組允許清單                   | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | 需要 @提及                     | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | 啟用群組                       | `true`    |
| `channels.feishu.textChunkLimit`                  | 訊息分塊大小                   | `2000`    |
| `channels.feishu.mediaMaxMb`                      | 媒體大小限制                   | `30`      |
| `channels.feishu.streaming`                       | 啟用串流卡片輸出               | `true`    |
| `channels.feishu.blockStreaming`                  | 啟用區塊串流                   | `true`    |

---

## dmPolicy 參考

| 值            | 行為                                            |
| ------------- | ----------------------------------------------- |
| `"pairing"`   | **預設。** 未知使用者會收到配對碼，必須核准     |
| `"allowlist"` | 僅允許 `allowFrom` 中的使用者聊天               |
| `"open"`      | 允許所有使用者（需要在 allowFrom 中設定 `"*"`） |
| `"disabled"`  | 停用私訊                                        |

---

## 支援的訊息類型

### 接收

- ✅ 文字
- ✅ 富文字（post）
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
- ⚠️ 富文字（部分支援）
