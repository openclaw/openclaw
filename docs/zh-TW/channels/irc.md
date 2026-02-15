---
title: IRC
description: 將 OpenClaw 連接到 IRC 頻道和私訊。
---

當您希望 OpenClaw 存在於經典頻道 (`#room`) 和私訊中時，請使用 IRC。
IRC 作為擴充功能插件發布，但在主設定中的 `channels.irc` 下進行設定。

## 快速開始

1. 在 `~/.openclaw/openclaw.json` 中啟用 IRC 設定。
2. 至少設定以下項目：

```json
{
  "channels": {
    "irc": {
      "enabled": true,
      "host": "irc.libera.chat",
      "port": 6697,
      "tls": true,
      "nick": "openclaw-bot",
      "channels": ["#openclaw"]
    }
  }
}
```

3. 啟動/重新啟動 Gateway：

```bash
openclaw gateway run
```

## 安全預設值

- `channels.irc.dmPolicy` 預設為 `"pairing"`。
- `channels.irc.groupPolicy` 預設為 `"allowlist"`。
- 當 `groupPolicy="allowlist"` 時，設定 `channels.irc.groups` 以定義允許的頻道。
- 使用 TLS (`channels.irc.tls=true`)，除非您有意接受純文字傳輸。

## 存取控制

IRC 頻道有兩個獨立的「閘門」：

1. **頻道存取** (`groupPolicy` + `groups`)：機器人是否完全接受來自頻道的訊息。
2. **發送者存取** (`groupAllowFrom` / 每個頻道的 `groups["#channel"].allowFrom`)：誰被允許在該頻道內觸發機器人。

設定鍵名：

- 私訊允許清單 (私訊發送者存取)：`channels.irc.allowFrom`
- 群組發送者允許清單 (頻道發送者存取)：`channels.irc.groupAllowFrom`
- 每個頻道的控制 (頻道 + 發送者 + 提及規則)：`channels.irc.groups["#channel"]`
- `channels.irc.groupPolicy="open"` 允許未設定的頻道 (預設仍受**提及限制**)

允許清單條目可以使用暱稱或 `nick!user @host` 形式。

### 常見陷阱：`allowFrom` 用於私訊，而非頻道

如果您看到以下日誌：

- `irc: drop group sender alice!ident @host (policy=allowlist)`

…這表示發送者不允許傳送**群組/頻道**訊息。請透過以下任一方式解決：

- 設定 `channels.irc.groupAllowFrom` (適用於所有頻道的全域設定)，或
- 設定每個頻道的發送者允許清單：`channels.irc.groups["#channel"].allowFrom`

範例 (允許 `#tuirc-dev` 中的任何人與機器人對話)：

```json5
{
  channels: {
    irc: {
      groupPolicy: "allowlist",
      groups: {
        "#tuirc-dev": { allowFrom: ["*"] },
      },
    },
  },
}
```

## 回覆觸發 (提及)

即使頻道被允許 (透過 `groupPolicy` + `groups`) 且發送者被允許，OpenClaw 仍預設在群組情境中進行**提及限制**。

這表示您可能會看到類似 `drop channel … (missing-mention)` 的日誌，除非訊息包含與機器人匹配的提及模式。

若要讓機器人在 IRC 頻道中**無需提及即可回覆**，請為該頻道停用提及限制：

```json5
{
  channels: {
    irc: {
      groupPolicy: "allowlist",
      groups: {
        "#tuirc-dev": {
          requireMention: false,
          allowFrom: ["*"],
        },
      },
    },
  },
}
```

或者允許**所有** IRC 頻道 (沒有每個頻道的允許清單) 並仍然無需提及即可回覆：

```json5
{
  channels: {
    irc: {
      groupPolicy: "open",
      groups: {
        "*": { requireMention: false, allowFrom: ["*"] },
      },
    },
  },
}
```

## 安全注意事項 (推薦用於公開頻道)

如果您在公開頻道中允許 `allowFrom: ["*"]`，任何人都可以提示機器人。
為了降低風險，請限制該頻道的工具。

### 頻道中所有人的相同工具

```json5
{
  channels: {
    irc: {
      groups: {
        "#tuirc-dev": {
          allowFrom: ["*"],
          tools: {
            deny: ["group:runtime", "group:fs", "gateway", "nodes", "cron", "browser"],
          },
        },
      },
    },
  },
}
```

### 每個發送者的不同工具 (所有者擁有更多權限)

使用 `toolsBySender` 為 `"*"` 應用更嚴格的策略，並為您的暱稱應用更寬鬆的策略：

```json5
{
  channels: {
    irc: {
      groups: {
        "#tuirc-dev": {
          allowFrom: ["*"],
          toolsBySender: {
            "*": {
              deny: ["group:runtime", "group:fs", "gateway", "nodes", "cron", "browser"],
            },
            eigen: {
              deny: ["gateway", "nodes", "cron"],
            },
          },
        },
      },
    },
  },
}
```

備註：

- `toolsBySender` 鍵可以是暱稱 (例如 `"eigen"`) 或完整的 hostmask (`"eigen!~eigen @174.127.248.171"`) 以進行更強大的身份匹配。
- 第一個匹配的發送者策略獲勝；`"*"` 是萬用字元備用方案。

有關群組存取與提及限制 (以及它們如何互動) 的更多資訊，請參閱：[/channels/groups](/channels/groups)。

## NickServ

連線後使用 NickServ 進行身份驗證：

```json
{
  "channels": {
    "irc": {
      "nickserv": {
        "enabled": true,
        "service": "NickServ",
        "password": "your-nickserv-password"
      }
    }
  }
}
```

連線時可選的一次性註冊：

```json
{
  "channels": {
    "irc": {
      "nickserv": {
        "register": true,
        "registerEmail": "bot @example.com"
      }
    }
  }
}
```

暱稱註冊後請停用 `register`，以避免重複的 REGISTER 嘗試。

## 環境變數

預設帳戶支援：

- `IRC_HOST`
- `IRC_PORT`
- `IRC_TLS`
- `IRC_NICK`
- `IRC_USERNAME`
- `IRC_REALNAME`
- `IRC_PASSWORD`
- `IRC_CHANNELS` (逗號分隔)
- `IRC_NICKSERV_PASSWORD`
- `IRC_NICKSERV_REGISTER_EMAIL`

## 疑難排解

- 如果機器人已連線但從未在頻道中回覆，請驗證 `channels.irc.groups` **以及**提及限制是否正在丟棄訊息 (`missing-mention`)。如果您希望它在沒有提及的情況下回覆，請為該頻道設定 `requireMention:false`。
- 如果登入失敗，請驗證暱稱是否可用和伺服器密碼。
- 如果 TLS 在自訂網路中失敗，請驗證主機/埠和憑證設定。
