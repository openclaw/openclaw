---
title: IRC
description: 將 OpenClaw 連接至 IRC 頻道與私訊。
---

當您希望在傳統頻道（`#room`）和私訊中使用 OpenClaw 時，請使用 IRC。
IRC 以擴充外掛程式的形式提供，但需要在主設定檔中的 `channels.irc` 下進行設定。

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

3. 啟動/重啟 Gateway：

```bash
openclaw gateway run
```

## 安全性預設值

- `channels.irc.dmPolicy` 預設為 `"pairing"`。
- `channels.irc.groupPolicy` 預設為 `"allowlist"`。
- 當 `groupPolicy="allowlist"` 時，請設定 `channels.irc.groups` 來定義允許的頻道。
- 除非您刻意接受明文傳輸，否則請使用 TLS（`channels.irc.tls=true`）。

## 存取控制

IRC 頻道有兩個獨立的「關卡」：

1. **頻道存取**（`groupPolicy` + `groups`）：機器人是否接收來自該頻道的訊息。
2. **傳送者存取**（`groupAllowFrom` / 個別頻道 `groups["#channel"].allowFrom`）：誰被允許在該頻道內觸發機器人。

設定鍵名：

- 私訊白名單（私訊傳送者存取）：`channels.irc.allowFrom`
- 群組傳送者白名單（頻道傳送者存取）：`channels.irc.groupAllowFrom`
- 個別頻道控制（頻道 + 傳送者 + 標註規則）：`channels.irc.groups["#channel"]`
- `channels.irc.groupPolicy="open"` 允許未設定的頻道（**預設仍受標註限制**）

白名單條目可以使用 nick 或 `nick!user@host` 格式。

### 常見陷阱：`allowFrom` 是用於私訊，而非頻道

如果您看到類似以下的日誌：

- `irc: drop group sender alice!ident@host (policy=allowlist)`

…這表示該傳送者不被允許傳送**群組/頻道**訊息。可以透過以下任一方式修正：

- 設定 `channels.irc.groupAllowFrom`（全域適用於所有頻道），或
- 設定個別頻道的傳送者白名單：`channels.irc.groups["#channel"].allowFrom`

範例（允許 `#tuirc-dev` 中的任何人與機器人交談）：

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

## 回覆觸發（標註）

即使頻道（透過 `groupPolicy` + `groups`）和傳送者都被允許，OpenClaw 在群組環境中預設仍會進行**標註過濾**（mention-gating）。

這意味著除非訊息中包含匹配機器人的標註模式，否則您可能會看到類似 `drop channel … (missing-mention)` 的日誌。

若要讓機器人在 IRC 頻道中**無需標註**即可回覆，請停用該頻道的標註過濾：

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

或者允許**所有** IRC 頻道（不設個別頻道白名單）且無需標註即可回覆：

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

## 安全性注意事項（建議用於公開頻道）

如果您在公開頻道中允許 `allowFrom: ["*"]`，任何人都可以對機器人下指令。
為了降低風險，請限制該頻道可使用的工具。

### 頻道內所有人使用相同的工具

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

### 不同傳送者使用不同工具（擁有者獲得更多權限）

使用 `toolsBySender` 對 `"*"` 套用較嚴格的政策，並對您的 nick 套用較寬鬆的政策：

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

- `toolsBySender` 的鍵名可以是 nick（例如 `"eigen"`）或完整的 hostmask（`"eigen!~eigen@174.127.248.171"`）以進行更強的身份比對。
- 以第一個匹配的傳送者政策為準；`"*"` 是萬用字元的備案。

關於群組存取與標註過濾的更多資訊（以及它們如何互動），請參閱：[/channels/groups](/channels/groups)。

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

選用的連線時一次性註冊：

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

在 nick 註冊成功後停用 `register`，以避免重複的註冊嘗試。

## 環境變數

預設帳號支援：

- `IRC_HOST`
- `IRC_PORT`
- `IRC_TLS`
- `IRC_NICK`
- `IRC_USERNAME`
- `IRC_REALNAME`
- `IRC_PASSWORD`
- `IRC_CHANNELS`（以逗號分隔）
- `IRC_NICKSERV_PASSWORD`
- `IRC_NICKSERV_REGISTER_EMAIL`

## 疑難排解

- 如果機器人已連線但從未在頻道中回覆，請確認 `channels.irc.groups` **以及**標註過濾是否正在丟棄訊息（`missing-mention`）。如果您希望它在沒有被標註的情況下也回覆，請為該頻道設定 `requireMention:false`。
- 如果登入失敗，請檢查 nick 是否可用以及伺服器密碼是否正確。
- 如果在自訂網路上 TLS 失敗，請檢查主機/連接埠以及憑證設定。
