---
summary: "Twitch 聊天機器人設定與安裝"
read_when:
  - 為 OpenClaw 設定 Twitch 聊天整合時
title: "Twitch"
---

# Twitch (plugin)

透過 IRC 連線支援 Twitch 聊天。OpenClaw 以 Twitch 使用者（機器人帳號）身分連線，在頻道中接收與傳送訊息。

## 需要外掛程式

Twitch 以外掛程式形式提供，不包含在核心安裝包中。

透過 CLI 安裝 (npm 登錄檔)：

```bash
openclaw plugins install @openclaw/twitch
```

本地檢出 (從 git 儲存庫執行時)：

```bash
openclaw plugins install ./extensions/twitch
```

詳情：[Plugins](/tools/plugin)

## 快速設定 (初學者)

1. 為機器人建立一個專用的 Twitch 帳號（或使用現有帳號）。
2. 產生憑證：[Twitch Token Generator](https://twitchtokengenerator.com/)
   - 選擇 **Bot Token**
   - 確認已勾選 `chat:read` 與 `chat:write` 範圍 (scopes)
   - 複製 **Client ID** 與 **Access Token**
3. 尋找您的 Twitch 使用者 ID：[https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. 設定權杖 (token)：
   - 環境變數：`OPENCLAW_TWITCH_ACCESS_TOKEN=...`（僅限預設帳號）
   - 或設定：`channels.twitch.accessToken`
   - 如果兩者皆已設定，則以設定檔案優先（環境變數僅作為預設帳號的備援）。
5. 啟動 Gateway。

**⚠️ 重要：** 請加入存取控制（`allowFrom` 或 `allowedRoles`）以防止未經授權的使用者觸發機器人。`requireMention` 預設為 `true`。

最簡設定：

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // 機器人的 Twitch 帳號
      accessToken: "oauth:abc123...", // OAuth Access Token (或使用 OPENCLAW_TWITCH_ACCESS_TOKEN 環境變數)
      clientId: "xyz789...", // 來自 Token Generator 的 Client ID
      channel: "vevisk", // 要加入哪個 Twitch 頻道的聊天室（必填）
      allowFrom: ["123456789"], // （建議）僅限您的 Twitch 使用者 ID - 從 https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/ 取得
    },
  },
}
```

## 這是什麼

- 由 Gateway 擁有的 Twitch 頻道。
- 確定性路由：回覆一律傳回 Twitch。
- 每個帳號對應到一個獨立的工作階段金鑰 `agent:<agentId>:twitch:<accountName>`。
- `username` 是機器人的帳號（身分驗證對象），`channel` 是要加入的聊天室。

## 設定 (詳細說明)

### 產生憑證

使用 [Twitch Token Generator](https://twitchtokengenerator.com/)：

- 選擇 **Bot Token**
- 確認已勾選 `chat:read` 與 `chat:write` 範圍 (scopes)
- 複製 **Client ID** 與 **Access Token**

無需手動註冊應用程式。權杖 (tokens) 會在數小時後過期。

### 設定機器人

**環境變數（僅限預設帳號）：**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**或設定：**

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

如果同時設定了環境變數與設定檔案，則以設定檔案優先。

### 存取控制 (建議)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // （建議）僅限您的 Twitch 使用者 ID
    },
  },
}
```

若要使用嚴格的允許清單，建議優先使用 `allowFrom`。如果您想要基於角色的存取，請改用 `allowedRoles`。

**可用角色：** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`。

**為什麼使用使用者 ID？** 使用者名稱可以更改，這可能會導致冒充行為。使用者 ID 是永久不變的。

尋找您的 Twitch 使用者 ID：[https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/)（將您的 Twitch 使用者名稱轉換為 ID）

## 權杖更新 (選填)

來自 [Twitch Token Generator](https://twitchtokengenerator.com/) 的權杖無法自動更新 - 過期時請重新產生。

若要自動更新權杖，請在 [Twitch Developer Console](https://dev.twitch.tv/console) 建立您自己的 Twitch 應用程式，並將其加入設定：

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

機器人會在過期前自動更新權杖，並記錄更新事件。

## 多帳號支援

使用 `channels.twitch.accounts` 並為每個帳號設定權杖。請參閱 [`gateway/configuration`](/gateway/configuration) 了解共用模式。

範例（一個機器人帳號加入兩個頻道）：

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

### 依使用者 ID 設定允許清單（最安全）

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

### 基於角色的存取（備選方案）

`allowFrom` 是嚴格的允許清單。設定後，僅允許這些使用者 ID。
如果您想要基於角色的存取，請保持 `allowFrom` 為未設定，並改為設定 `allowedRoles`：

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

預設情況下，`requireMention` 為 `true`。若要停用此功能並回應所有訊息：

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

**檢查存取控制：** 確保您的使用者 ID 位於 `allowFrom` 中，或者暫時移除
`allowFrom` 並設定 `allowedRoles: ["all"]` 進行測試。

**檢查機器人是否在頻道中：** 機器人必須加入 `channel` 中指定的頻道。

### 權杖問題

**「連線失敗」或身分驗證錯誤：**

- 確認 `accessToken` 是 OAuth 存取權杖的值（通常以 `oauth:` 前綴開頭）
- 檢查權杖是否具有 `chat:read` 與 `chat:write` 範圍
- 如果使用權杖更新，請確認已設定 `clientSecret` 與 `refreshToken`

### 權杖更新無效

**檢查記錄中的更新事件：**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

如果您看到「權杖更新已停用（無更新權杖）」：

- 確保已提供 `clientSecret`
- 確保已提供 `refreshToken`

## 設定

**帳號設定：**

- `username` - 機器人使用者名稱
- `accessToken` - 具備 `chat:read` 與 `chat:write` 權限的 OAuth 存取權杖
- `clientId` - Twitch Client ID（來自 Token Generator 或您的應用程式）
- `channel` - 要加入的頻道（必填）
- `enabled` - 啟用此帳號（預設：`true`）
- `clientSecret` - 選填：用於自動權杖更新
- `refreshToken` - 選填：用於自動權杖更新
- `expiresIn` - 權杖過期時間（秒）
- `obtainmentTimestamp` - 權杖取得時間戳記
- `allowFrom` - 使用者 ID 允許清單
- `allowedRoles` - 基於角色的存取控制 (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - 需要 @提及（預設：`true`）

**供應商選項：**

- `channels.twitch.enabled` - 啟用/停用頻道啟動
- `channels.twitch.username` - 機器人使用者名稱（簡化的單帳號設定）
- `channels.twitch.accessToken` - OAuth 存取權杖（簡化的單帳號設定）
- `channels.twitch.clientId` - Twitch Client ID（簡化的單帳號設定）
- `channels.twitch.channel` - 要加入的頻道（簡化的單帳號設定）
- `channels.twitch.accounts.<accountName>` - 多帳號設定（上方所有帳號欄位）

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

智慧代理可以呼叫 `twitch` 並執行以下動作：

- `send` - 傳送訊息至頻道

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

## 安全與維運

- **將權杖視為密碼** - 切勿將權杖提交至 git
- **為長期執行的機器人使用自動權杖更新**
- **使用使用者 ID 允許清單** 而非使用者名稱進行存取控制
- **監控記錄** 中的權杖更新事件與連線狀態
- **最小化權杖範圍** - 僅請求 `chat:read` 與 `chat:write`
- **如果卡住**：在確認沒有其他程序佔用工作階段後，重啟 Gateway

## 限制

- **500 個字元** 每則訊息（在單字邊界自動分塊）
- 在分塊前會先移除 Markdown 格式
- 無速率限制（使用 Twitch 內建的速率限制）
