---
summary: "Twitch 聊天機器人設定與安裝"
read_when:
  - 為 OpenClaw 設定 Twitch 聊天整合
title: "Twitch"
---

# Twitch (外掛程式)

透過 IRC 連線支援 Twitch 聊天。OpenClaw 會以 Twitch 使用者（機器人帳號）身分連線，以在頻道中接收和傳送訊息。

## 需要外掛程式

Twitch 是作為外掛程式發布，並未與核心安裝程式捆綁。

透過 CLI 安裝 (npm registry)：

```bash
openclaw plugins install @openclaw/twitch
```

本地檢出（從 git 儲存庫執行時）：

```bash
openclaw plugins install ./extensions/twitch
```

詳細資訊：[外掛程式](/tools/plugin)

## 快速設定 (初學者)

1.  為機器人建立一個專屬的 Twitch 帳號（或使用現有的帳號）。
2.  產生憑證：[Twitch Token Generator](https://twitchtokengenerator.com/)
    -   選擇 **Bot Token**
    -   確認已選擇 `chat:read` 和 `chat:write` 範圍
    -   複製 **Client ID** 和 **Access Token**
3.  尋找您的 Twitch 使用者 ID：[https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4.  設定權杖：
    -   環境變數：`OPENCLAW_TWITCH_ACCESS_TOKEN=...` (僅限預設帳號)
    -   或設定檔：`channels.twitch.accessToken`
    -   如果兩者都已設定，則設定檔優先（環境變數僅作為預設帳號的備用選項）。
5.  啟動 Gateway。

**⚠️ 重要：** 新增存取控制（`allowFrom` 或 `allowedRoles`）以防止未經授權的使用者觸發機器人。`requireMention` 預設為 `true`。

最小設定：

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // 機器人的 Twitch 帳號
      accessToken: "oauth:abc123...", // OAuth 存取權杖（或使用 OPENCLAW_TWITCH_ACCESS_TOKEN 環境變數）
      clientId: "xyz789...", // 來自權杖產生器的用戶端 ID
      channel: "vevisk", // 要加入的 Twitch 頻道聊天室 (必填)
      allowFrom: ["123456789"], // (建議) 僅您的 Twitch 使用者 ID - 從 https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/ 取得
    },
  },
}
```

## 說明

-   由 Gateway 擁有的 Twitch 頻道。
-   確定性路由：回覆總是回到 Twitch。
-   每個帳號都映射到一個獨立的工作階段金鑰 `agent:<agentId>:twitch:<accountName>`。
-   `username` 是機器人的帳號（負責驗證），`channel` 是要加入的聊天室。

## 設定 (詳細)

### 產生憑證

使用 [Twitch Token Generator](https://twitchtokengenerator.com/)：

-   選擇 **Bot Token**
-   確認已選擇 `chat:read` 和 `chat:write` 範圍
-   複製 **Client ID** 和 **Access Token**

無需手動應用程式註冊。權杖會在數小時後過期。

### 設定機器人

**環境變數 (僅限預設帳號)：**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**或設定檔：**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

如果環境變數和設定檔都已設定，則設定檔優先。

### 存取控制 (建議)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (建議) 僅您的 Twitch 使用者 ID
    },
  },
}
```

優先使用 `allowFrom` 建立嚴格的允許清單。如果您需要基於角色的存取，請改用 `allowedRoles`。

**可用角色：** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`。

**為什麼是使用者 ID？** 使用者名稱可能會更改，導致冒充。使用者 ID 是永久的。

尋找您的 Twitch 使用者 ID：[https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (將您的 Twitch 使用者名稱轉換為 ID)

## 權杖更新 (選用)

來自 [Twitch Token Generator](https://twitchtokengenerator.com/) 的權杖無法自動更新 – 請在過期時重新產生。

若要自動更新權杖，請在 [Twitch Developer Console](https://dev.twitch.tv/console) 建立您自己的 Twitch 應用程式，並新增至設定檔：

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

機器人會在權杖過期前自動更新權杖，並記錄更新事件。

## 多帳號支援

搭配每個帳號的權杖使用 `channels.twitch.accounts`。請參閱 [`gateway/configuration`](/gateway/configuration) 以了解共用模式。

範例（一個機器人帳號在兩個頻道中）：

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**注意：** 每個帳號都需要自己的權杖（每個頻道一個權杖）。

## 存取控制

### 基於角色的限制

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### 依使用者 ID 允許清單 (最安全)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### 基於角色的存取 (替代方案)

`allowFrom` 是一個嚴格的允許清單。設定後，僅允許這些使用者 ID。
如果您想要基於角色的存取，請將 `allowFrom` 留空，並改為設定 `allowedRoles`：

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### 停用 @提及 要求

預設情況下，`requireMention` 為 `true`。若要停用並回應所有訊息：

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## 疑難排解

首先，執行診斷命令：

```bash
openclaw doctor
openclaw channels status --probe
```

### 機器人沒有回應訊息

**檢查存取控制：** 確保您的使用者 ID 在 `allowFrom` 中，或暫時移除 `allowFrom` 並設定 `allowedRoles: ["all"]` 進行測試。

**檢查機器人是否在頻道中：** 機器人必須加入 `channel` 中指定的頻道。

### 權杖問題

**「連線失敗」或驗證錯誤：**

-   驗證 `accessToken` 是否為 OAuth 存取權杖值（通常以 `oauth:` 前綴開頭）
-   檢查權杖是否具有 `chat:read` 和 `chat:write` 範圍
-   如果使用權杖更新，請驗證 `clientSecret` 和 `refreshToken` 是否已設定

### 權杖更新無效

**檢查日誌是否有更新事件：**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

如果您看到「權杖更新已停用 (無更新權杖)」：

-   確保已提供 `clientSecret`
-   確保已提供 `refreshToken`

## 設定

**帳號設定：**

-   `username` - 機器人使用者名稱
-   `accessToken` - 具有 `chat:read` 和 `chat:write` 的 OAuth 存取權杖
-   `clientId` - Twitch 用戶端 ID（來自權杖產生器或您的應用程式）
-   `channel` - 要加入的頻道 (必填)
-   `enabled` - 啟用此帳號（預設值：`true`）
-   `clientSecret` - 選用：用於自動權杖更新
-   `refreshToken` - 選用：用於自動權杖更新
-   `expiresIn` - 權杖過期時間（秒）
-   `obtainmentTimestamp` - 權杖取得時間戳記
-   `allowFrom` - 使用者 ID 允許清單
-   `allowedRoles` - 基於角色的存取控制（`"moderator" | "owner" | "vip" | "subscriber" | "all"`）
-   `requireMention` - 要求 @提及（預設值：`true`）

**供應商選項：**

-   `channels.twitch.enabled` - 啟用/停用頻道啟動
-   `channels.twitch.username` - 機器人使用者名稱（簡化單帳號設定）
-   `channels.twitch.accessToken` - OAuth 存取權杖（簡化單帳號設定）
-   `channels.twitch.clientId` - Twitch 用戶端 ID（簡化單帳號設定）
-   `channels.twitch.channel` - 要加入的頻道（簡化單帳號設定）
-   `channels.twitch.accounts.<accountName>` - 多帳號設定（所有上述帳號欄位）

完整範例：

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## 工具動作

智慧代理可以使用動作呼叫 `twitch`：

-   `send` - 傳送訊息到頻道

範例：

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## 安全與操作

-   **將權杖視為密碼** - 永遠不要將權杖提交到 Git
-   對於長時間執行的機器人，**使用自動權杖更新**
-   對於存取控制，**使用使用者 ID 允許清單**而非使用者名稱
-   **監控日誌**以獲取權杖更新事件和連線狀態
-   **最小化權杖範圍** - 僅要求 `chat:read` 和 `chat:write`
-   **如果遇到問題**：確認沒有其他程序擁有工作階段後重新啟動 Gateway

## 限制

-   每則訊息 **500 個字元**（在單字邊界自動分塊）
-   在分塊前會移除 Markdown
-   無速率限制（使用 Twitch 的內建速率限制）
