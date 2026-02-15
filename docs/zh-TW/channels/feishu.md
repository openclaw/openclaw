---
summary: "Feishu 機器人概覽、功能與設定"
read_when:
  - 您想要連接 Feishu/Lark 機器人
  - 您正在設定 Feishu 頻道
title: Feishu
---

# Feishu 機器人

Feishu (Lark) 是一個團隊聊天平台，企業用於訊息傳遞與協作。此外掛程式使用平台的 WebSocket 事件訂閱將 OpenClaw 連接到 Feishu/Lark 機器人，因此可以在不公開 Webhook URL 的情況下接收訊息。

---

## 需要外掛程式

安裝 Feishu 外掛程式：

```bash
openclaw plugins install @openclaw/feishu
```

本地檢出（從 git 倉庫執行時）：

```bash
openclaw plugins install ./extensions/feishu
```

---

## 快速開始

有兩種方法可以新增 Feishu 頻道：

### 方法 1：新手導覽精靈（推薦）

如果您剛安裝 OpenClaw，請執行精靈：

```bash
openclaw onboard
```

精靈將引導您完成：

1. 建立 Feishu 應用程式並收集憑證
2. 在 OpenClaw 中設定應用程式憑證
3. 啟動 Gateway

✅ **設定完成後**，檢查 Gateway 狀態：

- `openclaw gateway status`
- `openclaw logs --follow`

### 方法 2：CLI 設定

如果您已經完成初始安裝，請透過 CLI 新增頻道：

```bash
openclaw channels add
```

選擇 **Feishu**，然後輸入 App ID 和 App Secret。

✅ **設定完成後**，管理 Gateway：

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## 步驟 1：建立 Feishu 應用程式

### 1. 開啟 Feishu 開放平台

訪問 [Feishu 開放平台](https://open.feishu.cn/app) 並登入。

Lark（全球）租戶應使用 [https://open.larksuite.com/app](https://open.larksuite.com/app) 並在 Feishu 設定中將 `domain` 設為 `"lark"`。

### 2. 建立應用程式

1. 點擊 **建立企業自建應用**
2. 填寫應用程式名稱 + 描述
3. 選擇應用程式圖示

![建立企業自建應用](../../images/feishu-step2-create-app.png)

### 3. 複製憑證

從 **憑證與基礎資訊**，複製：

- **App ID**（格式：`cli_xxx`）
- **App Secret**

❗ **重要：** 請私密保存 App Secret。

![獲取憑證](../../images/feishu-step3-credentials.png)

### 4. 設定權限

在 **權限管理**，點擊 **批量匯入** 並貼上：

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

![設定權限](../../images/feishu-step4-permissions.png)

### 5. 啟用機器人功能

在 **應用功能** > **機器人**：

1. 啟用機器人功能
2. 設定機器人名稱

![啟用機器人功能](../../images/feishu-step5-bot-capability.png)

### 6. 設定事件訂閱

⚠️ **重要：** 在設定事件訂閱之前，請確保：

1. 您已經為 Feishu 執行了 `openclaw channels add`
2. Gateway 正在執行 (`openclaw gateway status`)

在 **事件訂閱**：

1. 選擇 **使用長連接接收事件** (WebSocket)
2. 新增事件：`im.message.receive_v1`

⚠️ 如果 Gateway 未執行，長連接設定可能無法成功儲存。

![設定事件訂閱](../../images/feishu-step6-event-subscription.png)

### 7. 發佈應用程式

1. 在 **版本管理與發佈** 中建立版本
2. 提交審核並發佈
3. 等待管理員審核（企業應用程式通常會自動核准）

---

## 步驟 2：設定 OpenClaw

### 使用精靈設定（推薦）

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
          botName: "我的 AI 助理",
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

如果您的租戶在 Lark（國際版），請將 domain 設定為 `lark`（或完整的網域名稱字串）。您可以在 `channels.feishu.domain` 或按帳戶 (`channels.feishu.accounts.<id>.domain`) 進行設定。

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

### 2. 發送測試訊息

在 Feishu 中，找到您的機器人並發送訊息。

### 3. 核准配對

預設情況下，機器人會回覆配對碼。核准它：

```bash
openclaw pairing approve feishu <CODE>
```

核准後，您就可以正常聊天了。

---

## 概覽

- **Feishu 機器人頻道**：由 Gateway 管理的 Feishu 機器人
- **確定性路由**：回覆始終返回到 Feishu
- **工作階段隔離**：私訊共享主工作階段；群組是隔離的
- **WebSocket 連接**：透過 Feishu SDK 進行長連接，不需要公開 URL

---

## 存取控制

### 私訊

- **預設**：`dmPolicy: "pairing"`（未知使用者會收到配對碼）
- **核准配對**：

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **允許清單模式**：設定 `channels.feishu.allowFrom` 並填入允許的 Open ID

### 群組聊天

**1. 群組策略** (`channels.feishu.groupPolicy`)：

- `"open"` = 允許群組中的所有人（預設）
- `"allowlist"` = 僅允許 `groupAllowFrom`
- `"disabled"` = 停用群組訊息

**2. 提及要求** (`channels.feishu.groups.<chat_id>.requireMention`)：

- `true` = 需要 @提及（預設）
- `false` = 無需提及即可回應

---

## 群組設定範例

### 允許所有群組，需要 @提及（預設）

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // 預設 requireMention: true
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

### 僅允許群組中的特定使用者

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

## 獲取群組/使用者 ID

### 群組 ID (chat_id)

群組 ID 看起來像 `oc_xxx`。

**方法 1（推薦）**

1. 啟動 Gateway 並在群組中 @提及機器人
2. 執行 `openclaw logs --follow` 並尋找 `chat_id`

**方法 2**

使用 Feishu API 調試器列出群組聊天。

### 使用者 ID (open_id)

使用者 ID 看起來像 `ou_xxx`。

**方法 1（推薦）**

1. 啟動 Gateway 並私訊機器人
2. 執行 `openclaw logs --follow` 並尋找 `open_id`

**方法 2**

檢查使用者 Open ID 的配對請求：

```bash
openclaw pairing list feishu
```

---

## 常見命令

| 命令      | 描述           |
| --------- | -------------- |
| `/status` | 顯示機器人狀態 |
| `/reset`  | 重設工作階段   |
| `/model`  | 顯示/切換模型  |

> 注意：Feishu 尚不支援原生命令選單，因此必須以文字形式發送命令。

## Gateway 管理命令

| 命令                       | 描述                   |
| -------------------------- | ---------------------- |
| `openclaw gateway status`  | 顯示 Gateway 狀態      |
| `openclaw gateway install` | 安裝/啟動 Gateway 服務 |
| `openclaw gateway stop`    | 停止 Gateway 服務      |
| `openclaw gateway restart` | 重啟 Gateway 服務      |
| `openclaw logs --follow`   | 追蹤 Gateway 記錄      |

---

## 疑難排解

### 機器人在群組聊天中沒有回應

1. 確保機器人已新增到群組中
2. 確保您 @提及機器人（預設行為）
3. 檢查 `groupPolicy` 未設定為 `"disabled"`
4. 檢查記錄：`openclaw logs --follow`

### 機器人沒有接收到訊息

1. 確保應用程式已發佈並核准
2. 確保事件訂閱包含 `im.message.receive_v1`
3. 確保已啟用 **長連接**
4. 確保應用程式權限完整
5. 確保 Gateway 正在執行：`openclaw gateway status`
6. 檢查記錄：`openclaw logs --follow`

### App Secret 洩露

1. 在 Feishu 開放平台中重設 App Secret
2. 在您的設定中更新 App Secret
3. 重啟 Gateway

### 訊息發送失敗

1. 確保應用程式具有 `im:message:send_as_bot` 權限
2. 確保應用程式已發佈
3. 檢查記錄以獲取詳細錯誤

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
          botName: "主要機器人",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "備用機器人",
          enabled: false,
        },
      },
    },
  },
}
```

### 訊息限制

- `textChunkLimit`：外發文字分塊大小（預設：2000 個字元）
- `mediaMaxMb`：媒體上傳/下載限制（預設：30MB）

### 串流傳輸

Feishu 支援透過互動式卡片進行串流回覆。啟用後，機器人在生成文字時會更新卡片。

```json5
{
  channels: {
    feishu: {
      streaming: true, // 啟用串流卡片輸出（預設為 true）
      blockStreaming: true, // 啟用區塊級串流（預設為 true）
    },
  },
}
```

將 `streaming` 設為 `false` 以在發送前等待完整回覆。

### 多智慧代理路由

使用 `bindings` 將 Feishu 私訊或群組路由到不同的智慧代理。

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

請參閱 [獲取群組/使用者 ID](#獲取群組使用者-id) 獲取查詢提示。

---

## 設定參考

完整設定：[Gateway 設定](/gateway/configuration)

關鍵選項：

| 設定                                              | 描述                          | 預設值    |
| ------------------------------------------------- | ----------------------------- | --------- |
| `channels.feishu.enabled`                         | 啟用/停用頻道                 | `true`    |
| `channels.feishu.domain`                          | API 網域 (`feishu` 或 `lark`) | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | App ID                        | -         |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                    | -         |
| `channels.feishu.accounts.<id>.domain`            | 覆蓋每個帳戶的 API 網域       | `feishu`  |
| `channels.feishu.dmPolicy`                        | 私訊策略                      | `pairing` |
| `channels.feishu.allowFrom`                       | 私訊允許清單 (open_id 清單)   | -         |
| `channels.feishu.groupPolicy`                     | 群組策略                      | `open`    |
| `channels.feishu.groupAllowFrom`                  | 群組允許清單                  | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | 需要 @提及                    | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | 啟用群組                      | `true`    |
| `channels.feishu.textChunkLimit`                  | 訊息分塊大小                  | `2000`    |
| `channels.feishu.mediaMaxMb`                      | 媒體大小限制                  | `30`      |
| `channels.feishu.streaming`                       | 啟用串流卡片輸出              | `true`    |
| `channels.feishu.blockStreaming`                  | 啟用區塊串流傳輸              | `true`    |

---

## dmPolicy 參考

| 值            | 行為                                            |
| ------------- | ----------------------------------------------- |
| `"pairing"`   | **預設。** 未知使用者會收到配對碼；必須被核准   |
| `"allowlist"` | 僅 `allowFrom` 中的使用者可以聊天               |
| `"open"`      | 允許所有使用者（需要在 allowFrom 中加入 `"*"`） |
| `"disabled"`  | 停用私訊                                        |

---

## 支援的訊息類型

### 接收

- ✅ 文字
- ✅ 富文本 (post)
- ✅ 圖片
- ✅ 檔案
- ✅ 音訊
- ✅ 影片
- ✅ 貼圖

### 發送

- ✅ 文字
- ✅ 圖片
- ✅ 檔案
- ✅ 音訊
- ⚠️ 富文本（部分支援）
