---
summary: "Twitch 聊天機器人設定與安裝"
read_when:
  - 為 OpenClaw 設定 Twitch 聊天整合
title: "Twitch"
---

# Twitch（外掛）

透過 IRC 連線提供 Twitch 聊天支援。OpenClaw 會以 Twitch 使用者（機器人帳號）身分連線，以在頻道中接收與傳送訊息。 33. OpenClaw 會以 Twitch 使用者（機器人帳號）的身分連線，以在頻道中接收與傳送訊息。

## 34. 需要外掛

Twitch 以外掛形式提供，未隨核心安裝一起提供。

透過 CLI 安裝（npm 登錄）：

```bash
openclaw plugins install @openclaw/twitch
```

本地檢出（從 git 儲存庫執行時）：

```bash
openclaw plugins install ./extensions/twitch
```

詳細資訊：[Plugins](/tools/plugin)

## 快速設定（初學者）

1. 35. 為機器人建立一個專用的 Twitch 帳號（或使用既有帳號）。
2. 產生認證：[Twitch Token Generator](https://twitchtokengenerator.com/)
   - 選擇 **Bot Token**
   - 確認已勾選權限範圍 `chat:read` 與 `chat:write`
   - 複製 **Client ID** 與 **Access Token**
3. 尋找你的 Twitch 使用者 ID：[https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. 設定權杖：
   - 環境變數：`OPENCLAW_TWITCH_ACCESS_TOKEN=...`（僅預設帳號）
   - 或設定檔：`channels.twitch.accessToken`
   - 36. 若兩者皆設定，則以設定檔為優先（環境變數僅作為預設帳號的後備）。
5. 啟動 Gateway 閘道器.

**⚠️ 重要：** 請加入存取控制（`allowFrom` 或 `allowedRoles`）以防止未授權使用者觸發機器人。`requireMention` 預設為 `true`。 37. `requireMention` 預設為 `true`。

最小設定：

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## 它是什麼

- 一個由 Gateway 閘道器擁有的 Twitch 頻道。
- 確定性路由：回覆一律回到 Twitch。
- 每個帳號都對應到一個隔離的工作階段金鑰 `agent:<agentId>:twitch:<accountName>`。
- `username` 是機器人的帳號（用於身分驗證），`channel` 是要加入的聊天室。

## 設定（詳細）

### 產生認證

使用 [Twitch Token Generator](https://twitchtokengenerator.com/)：

- 選擇 **Bot Token**
- 確認已勾選權限範圍 `chat:read` 與 `chat:write`
- 複製 **Client ID** 與 **Access Token**

38. 無需手動註冊應用程式。 39. 權杖會在數小時後過期。

### 40. 設定機器人

**環境變數（僅預設帳號）：**

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

If both env and config are set, config takes precedence.

### 存取控制（建議）

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Prefer `allowFrom` for a hard allowlist. Use `allowedRoles` instead if you want role-based access.

**可用角色：** `"moderator"`、`"owner"`、`"vip"`、`"subscriber"`、`"all"`。

**為何使用使用者 ID？** 使用者名稱可能變更，導致冒充風險。使用者 ID 是永久的。 User IDs are permanent.

查找你的 Twitch 使用者 ID：[https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/)（將你的 Twitch 使用者名稱轉換為 ID）

## Token refresh (optional)

來自 [Twitch Token Generator](https://twitchtokengenerator.com/) 的權杖無法自動重新整理——到期時需重新產生。

若要自動重新整理權杖，請在 [Twitch Developer Console](https://dev.twitch.tv/console) 建立你自己的 Twitch 應用程式，並加入設定：

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

The bot automatically refreshes tokens before expiration and logs refresh events.

## 多帳號支援

使用 `channels.twitch.accounts` 搭配各帳號的權杖。共用模式請參閱 [`gateway/configuration`](/gateway/configuration)。 See [`gateway/configuration`](/gateway/configuration) for the shared pattern.

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

**Note:** Each account needs its own token (one token per channel).

## 存取控制

### 以角色為基礎的限制

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

### 依使用者 ID 的允許清單（最安全）

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

### 以角色為基礎的存取（替代方案）

`allowFrom` is a hard allowlist. When set, only those user IDs are allowed.
If you want role-based access, leave `allowFrom` unset and configure `allowedRoles` instead:

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

### 停用 @mention 要求

By default, `requireMention` is `true`. To disable and respond to all messages:

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

## Troubleshooting

首先，執行診斷指令：

```bash
openclaw doctor
openclaw channels status --probe
```

### Bot doesn't respond to messages

**檢查存取控制：** 確認你的使用者 ID 在 `allowFrom` 中，或暫時移除
`allowFrom` 並設定 `allowedRoles: ["all"]` 以進行測試。

**確認機器人在頻道中：** 機器人必須加入 `channel` 指定的頻道。

### Token issues

**「Failed to connect」或身分驗證錯誤：**

- 確認 `accessToken` 為 OAuth 存取權杖值（通常以 `oauth:` 前綴開頭）
- 檢查權杖是否具備 `chat:read` 與 `chat:write` 權限範圍
- 若使用權杖重新整理，確認已設定 `clientSecret` 與 `refreshToken`

### Token refresh not working

**檢查日誌中的重新整理事件：**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

若看到「token refresh disabled（no refresh token）」：

- 確認已提供 `clientSecret`
- 確認已提供 `refreshToken`

## 設定

**帳號設定：**

- `username` - 機器人使用者名稱
- `accessToken` - 具備 `chat:read` 與 `chat:write` 的 OAuth 存取權杖
- `clientId` - Twitch Client ID（來自 Token Generator 或你的應用程式）
- `channel` - 要加入的頻道（必填）
- `enabled` - 啟用此帳號（預設：`true`）
- `clientSecret` - 選用：用於自動權杖重新整理
- `refreshToken` - 選用：用於自動權杖重新整理
- `expiresIn` - 權杖到期秒數
- `obtainmentTimestamp` - 取得權杖的時間戳記
- `allowFrom` - 使用者 ID 允許清單
- `allowedRoles` - 以角色為基礎的存取控制（`"moderator" | "owner" | "vip" | "subscriber" | "all"`）
- `requireMention` - 需要 @mention（預設：`true`）

**提供者選項：**

- `channels.twitch.enabled` - 啟用／停用頻道啟動
- `channels.twitch.username` - 機器人使用者名稱（簡化的單帳號設定）
- `channels.twitch.accessToken` - OAuth 存取權杖（簡化的單帳號設定）
- `channels.twitch.clientId` - Twitch Client ID（簡化的單帳號設定）
- `channels.twitch.channel` - 要加入的頻道（簡化的單帳號設定）
- `channels.twitch.accounts.<accountName>` - 多帳號設定（上述所有帳號欄位）

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

代理程式可以呼叫 `twitch` 並指定動作：

- `send` - 傳送訊息到頻道

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

## 安全性與營運

- **將權杖視同密碼** - 切勿將權杖提交至 git
- **長時間運作的機器人請使用自動權杖重新整理**
- **存取控制請使用使用者 ID 允許清單**，避免使用使用者名稱
- **Monitor logs** for token refresh events and connection status
- **最小化權杖權限範圍** - 僅請求 `chat:read` 與 `chat:write`
- **若卡住**：確認沒有其他程序佔用工作階段後，重新啟動 Gateway 閘道器

## 限制

- 每則訊息 **500 個字元**（在字詞邊界自動分段）
- 分段前會移除 Markdown
- 無額外速率限制（使用 Twitch 內建的速率限制）
