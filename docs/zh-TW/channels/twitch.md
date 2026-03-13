---
summary: Twitch chat bot configuration and setup
read_when:
  - Setting up Twitch chat integration for OpenClaw
title: Twitch
---

# Twitch (插件)

透過 IRC 連接支援 Twitch 聊天。OpenClaw 以 Twitch 使用者（機器人帳號）的身份連接，以接收和發送頻道中的訊息。

## 需要插件

Twitch 作為一個插件發佈，並不與核心安裝包捆綁在一起。

透過 CLI 安裝（npm 註冊表）：

```bash
openclaw plugins install @openclaw/twitch
```

[[BLOCK_1]]  
本地檢出（當從 git 倉庫執行時）：  
[[BLOCK_1]]

```bash
openclaw plugins install ./extensions/twitch
```

[[INLINE_1]]

## 快速設置（初學者）

1. 為機器人創建一個專用的 Twitch 帳戶（或使用現有帳戶）。
2. 生成憑證： [Twitch Token Generator](https://twitchtokengenerator.com/)
   - 選擇 **Bot Token**
   - 確認已選擇範圍 `chat:read` 和 `chat:write`
   - 複製 **Client ID** 和 **Access Token**
3. 找到你的 Twitch 用戶 ID: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. 設定 token：
   - 環境變數: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` （僅限預設帳戶）
   - 或設定: `channels.twitch.accessToken`
   - 如果兩者都設置，則設定優先（環境變數回退僅限預設帳戶）。
5. 啟動網關。

**⚠️ 重要：** 添加存取控制 (`allowFrom` 或 `allowedRoles`) 以防止未經授權的使用者觸發機器人。 `requireMention` 預設為 `true`。

[[BLOCK_1]]  
最小設定：  
[[BLOCK_1]]

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

## 這是什麼

- 一個由 Gateway 擁有的 Twitch 頻道。
- 確定性路由：回覆總是返回到 Twitch。
- 每個帳戶對應到一個獨立的會話金鑰 `agent:<agentId>:twitch:<accountName>`。
- `username` 是機器人的帳戶（進行身份驗證），`channel` 是要加入的聊天室。

## Setup (detailed)

### 產生憑證

使用 [Twitch Token Generator](https://twitchtokengenerator.com/):

- 選擇 **Bot Token**
- 確認已選擇範圍 `chat:read` 和 `chat:write`
- 複製 **Client ID** 和 **Access Token**

無需手動註冊應用程式。Token 在幾小時後過期。

### 設定機器人

**環境變數（僅限預設帳戶）：**

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

如果同時設置了 env 和 config，則 config 會優先。

### 存取控制（建議使用）

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

對於硬性允許清單，請使用 `allowFrom`。如果您想要基於角色的存取，請改用 `allowedRoles`。

**可用角色：** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`。

**為什麼使用者 ID？** 使用者名稱可以變更，這可能導致冒充。使用者 ID 是永久的。

找到你的 Twitch 使用者 ID: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (將你的 Twitch 使用者名稱轉換為 ID)

## Token 刷新（選用）

來自 [Twitch Token Generator](https://twitchtokengenerator.com/) 的 token 不能自動刷新 - 當過期時需重新生成。

要進行自動的 token 刷新，請在 [Twitch 開發者控制台](https://dev.twitch.tv/console) 創建您自己的 Twitch 應用程式，並將其添加到設定中：

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

機器人會在 token 到期前自動刷新，並記錄刷新事件。

## Multi-account support

使用 `channels.twitch.accounts` 來進行每個帳戶的 token。請參閱 [`gateway/configuration`](/gateway/configuration) 以獲取共享模式。

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

**注意：** 每個帳戶需要自己的 token（每個頻道一個 token）。

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

### 基於角色的存取（替代方案）

`allowFrom` 是一個硬性允許清單。當設定後，只有那些使用者 ID 被允許。
如果您想要基於角色的存取，請保持 `allowFrom` 未設定，並改為設定 `allowedRoles`：

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

### 停用 @提及要求

預設情況下，`requireMention` 為 `true`。要禁用並回應所有訊息：

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

## 故障排除

首先，執行診斷命令：

```bash
openclaw doctor
openclaw channels status --probe
```

### Bot 不回應訊息

**檢查存取控制：** 確保您的使用者 ID 在 `allowFrom` 中，或暫時移除 `allowFrom` 並將 `allowedRoles: ["all"]` 設定為測試。

**檢查機器人是否在頻道中：** 機器人必須加入指定的頻道 `channel`。

### Token 問題

**"無法連接"或身份驗證錯誤：**

- 驗證 `accessToken` 是 OAuth 存取權杖的值（通常以 `oauth:` 前綴開頭）
- 檢查權杖是否具有 `chat:read` 和 `chat:write` 範圍
- 如果使用權杖刷新，請驗證 `clientSecret` 和 `refreshToken` 是否已設定

### Token 刷新無法正常運作

**檢查刷新事件的日誌：**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

如果您看到「token refresh disabled (no refresh token)」：

- 確保 `clientSecret` 已提供
- 確保 `refreshToken` 已提供

## Config

**帳戶設定：**

- `username` - 機器人用戶名稱
- `accessToken` - OAuth 存取權杖，包含 `chat:read` 和 `chat:write`
- `clientId` - Twitch 用戶端 ID（來自 Token 生成器或您的應用程式）
- `channel` - 要加入的頻道（必填）
- `enabled` - 啟用此帳戶（預設值：`true`）
- `clientSecret` - 可選：用於自動更新存取權杖
- `refreshToken` - 可選：用於自動更新存取權杖
- `expiresIn` - 存取權杖過期時間（以秒為單位）
- `obtainmentTimestamp` - 獲取存取權杖的時間戳
- `allowFrom` - 用戶 ID 白名單
- `allowedRoles` - 基於角色的存取控制 (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - 需要 @提及（預設值：`true`）

**提供者選項：**

- `channels.twitch.enabled` - 啟用/禁用頻道啟動
- `channels.twitch.username` - 機器人用戶名（簡化的單帳號設定）
- `channels.twitch.accessToken` - OAuth 存取權杖（簡化的單帳號設定）
- `channels.twitch.clientId` - Twitch 用戶端 ID（簡化的單帳號設定）
- `channels.twitch.channel` - 要加入的頻道（簡化的單帳號設定）
- `channels.twitch.accounts.<accountName>` - 多帳號設定（以上所有帳號欄位）

[[BLOCK_1]]  
完整範例：  
[[BLOCK_1]]

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

## Tool actions

代理可以使用動作呼叫 `twitch`：

- `send` - 發送訊息到頻道

[[BLOCK_1]]  
範例：  
[[INLINE_1]]

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## Safety & ops

- **將 token 視為密碼** - 切勿將 token 提交至 git
- **對於長時間執行的機器人使用自動 token 刷新**
- **使用用戶 ID 白名單** 來進行存取控制，而非使用者名稱
- **監控日誌** 以查看 token 刷新事件和連接狀態
- **最小化 token 的範圍** - 只請求 `chat:read` 和 `chat:write`
- **如果卡住**：在確認沒有其他進程擁有該會話後重啟網關

## Limits

- 每則訊息最多 **500 個字元**（在單字邊界自動分段）
- 在分段之前會移除 Markdown 格式
- 無速率限制（使用 Twitch 內建的速率限制）
