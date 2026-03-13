---
title: IRC
description: Connect OpenClaw to IRC channels and direct messages.
summary: "IRC plugin setup, access controls, and troubleshooting"
read_when:
  - You want to connect OpenClaw to IRC channels or DMs
  - "You are configuring IRC allowlists, group policy, or mention gating"
---

當你想在經典頻道 (`#room`) 和直接訊息中使用 OpenClaw 時，請使用 IRC。IRC 作為擴充插件提供，但它在主設定中於 `channels.irc` 進行設定。

## 快速入門

1. 在 `~/.openclaw/openclaw.json` 中啟用 IRC 設定。
2. 至少設置：

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

3. 啟動/重啟閘道器:

```bash
openclaw gateway run
```

## Security defaults

- `channels.irc.dmPolicy` 預設為 `"pairing"`。
- `channels.irc.groupPolicy` 預設為 `"allowlist"`。
- 使用 `groupPolicy="allowlist"`，將 `channels.irc.groups` 設定為定義允許的通道。
- 使用 TLS (`channels.irc.tls=true`)，除非您故意接受明文傳輸。

## 存取控制

有兩個獨立的「閘門」用於 IRC 頻道：

1. **頻道存取** (`groupPolicy` + `groups`): 機器人是否完全接受來自頻道的訊息。
2. **發送者存取** (`groupAllowFrom` / 每個頻道 `groups["#channel"].allowFrom`): 誰被允許在該頻道內觸發機器人。

Config keys:

- DM 允許清單 (DM 發送者存取): `channels.irc.allowFrom`
- 群組發送者允許清單 (頻道發送者存取): `channels.irc.groupAllowFrom`
- 每個頻道控制 (頻道 + 發送者 + 提及規則): `channels.irc.groups["#channel"]`
- `channels.irc.groupPolicy="open"` 允許未設定的頻道 (**預設仍然受提及限制**)

允許清單條目應使用穩定的發件人身份 (`nick!user@host`)。裸暱稱匹配是可變的，僅在 `channels.irc.dangerouslyAllowNameMatching: true` 時啟用。

### 常見問題：`allowFrom` 是用於直接訊息，而不是頻道

如果你看到類似的日誌：

`irc: drop group sender alice!ident@host (policy=allowlist)`

…這意味著發送者不被允許發送 **群組/頻道** 訊息。請透過以下任一方式修正：

- 設定 `channels.irc.groupAllowFrom`（對所有頻道全域適用），或
- 設定每個頻道的發送者允許清單：`channels.irc.groups["#channel"].allowFrom`

範例（允許 `#tuirc-dev` 中的任何人與機器人對話）：

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

## Reply triggering (mentions)

即使一個頻道是被允許的（透過 `groupPolicy` + `groups`），且發送者也是被允許的，OpenClaw 在群組上下文中預設為 **提及限制**。

這意味著您可能會看到類似 `drop channel … (missing-mention)` 的日誌，除非該消息包含與機器人匹配的提及模式。

要讓機器人在 IRC 頻道中 **不需要提及** 就能回覆，請為該頻道禁用提及限制：

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

或是允許 **所有** IRC 頻道（不需要每個頻道的允許清單），並且仍然可以在沒有提及的情況下回覆：

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

## 安全注意事項（建議用於公共頻道）

如果您在公共頻道中允許 `allowFrom: ["*"]`，任何人都可以提示機器人。為了降低風險，請限制該頻道的工具。

### 同樣的工具適用於頻道中的每個人

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

### 每個發送者的不同工具（擁有者獲得更多權限）

使用 `toolsBySender` 對 `"*"` 應用更嚴格的政策，並對你的暱稱應用較寬鬆的政策：

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
            "id:eigen": {
              deny: ["gateway", "nodes", "cron"],
            },
          },
        },
      },
    },
  },
}
```

[[BLOCK_1]]

- `toolsBySender` 鍵應使用 `id:` 來表示 IRC 發送者身份值：
  `id:eigen` 或 `id:eigen!~eigen@174.127.248.171` 以獲得更強的匹配。
- 過時的無前綴鍵仍然被接受並僅作為 `id:` 進行匹配。
- 第一個匹配的發送者政策獲勝；`"*"` 是通配符後備選項。

有關群組存取與提及限制（以及它們之間的互動）的更多資訊，請參見：[/channels/groups](/channels/groups)。

## NickServ

要在連接後與 NickServ 進行身份驗證：

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

[[BLOCK_1]] 可選的一次性註冊於連接上：[[BLOCK_1]]

```json
{
  "channels": {
    "irc": {
      "nickserv": {
        "register": true,
        "registerEmail": "bot@example.com"
      }
    }
  }
}
```

在暱稱註冊後禁用 `register` 以避免重複的註冊嘗試。

## 環境變數

預設帳戶支援：

- `IRC_HOST`
- `IRC_PORT`
- `IRC_TLS`
- `IRC_NICK`
- `IRC_USERNAME`
- `IRC_REALNAME`
- `IRC_PASSWORD`
- `IRC_CHANNELS` (以逗號分隔)
- `IRC_NICKSERV_PASSWORD`
- `IRC_NICKSERV_REGISTER_EMAIL`

## 故障排除

- 如果機器人連接成功但在頻道中從未回覆，請確認 `channels.irc.groups` **以及** 是否因為提及限制而導致訊息被丟棄 (`missing-mention`). 如果您希望它在沒有提及的情況下回覆，請為頻道設定 `requireMention:false`。
- 如果登入失敗，請確認暱稱的可用性和伺服器密碼。
- 如果在自訂網路上 TLS 失敗，請確認主機/端口和憑證設置。
