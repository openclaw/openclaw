---
summary: "Slack 的 Socket 或 HTTP webhook 模式設定"
read_when: "設定 Slack 或除錯 Slack Socket／HTTP 模式"
title: "Slack"
---

# Slack

## Socket 模式（預設）

### 快速設定（新手）

1. 建立一個 Slack 應用程式並啟用 **Socket Mode**。
2. 建立 **App Token**（`xapp-...`）與 **Bot Token**（`xoxb-...`）。
3. 26. 設定 OpenClaw 的權杖並啟動閘道。

最小設定：

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### 設定

1. 在 [https://api.slack.com/apps](https://api.slack.com/apps) 建立 Slack 應用程式（From scratch）。
2. 27. **Socket Mode** → 開啟。 **Socket Mode** → 切換為開啟。接著前往 **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**，使用範圍 `connections:write`。複製 **App Token**（`xapp-...`）。 28. 複製 **App Token**（`xapp-...`）。
3. **OAuth & Permissions** → 新增機器人權杖範圍（使用下方的 manifest）。點擊 **Install to Workspace**。複製 **Bot User OAuth Token**（`xoxb-...`）。 29. 點擊 **Install to Workspace**。 30. 複製 **Bot User OAuth Token**（`xoxb-...`）。
4. 31. 選用：**OAuth & Permissions** → 新增 **User Token Scopes**（請見下方唯讀清單）。 選用：**OAuth & Permissions** → 新增 **User Token Scopes**（請參考下方的唯讀清單）。重新安裝應用程式並複製 **User OAuth Token**（`xoxp-...`）。
5. **Event Subscriptions** → 啟用事件並訂閱：
   - `message.*`（包含編輯／刪除／串回廣播）
   - `app_mention`
   - `reaction_added`、`reaction_removed`
   - `member_joined_channel`、`member_left_channel`
   - `channel_rename`
   - `pin_added`、`pin_removed`
6. 將機器人邀請到你希望它讀取的頻道。
7. Slash Commands → 若你使用 `channels.slack.slashCommand`，請建立 `/openclaw`。若啟用原生命令，請為每個內建命令新增一個斜線命令（名稱與 `/help` 相同）。Slack 預設關閉原生命令，除非你設定 `channels.slack.commands.native: true`（全域 `commands.native` 的預設是 `"auto"`，會讓 Slack 保持關閉）。 32. 若啟用原生命令，請為每個內建命令新增一個斜線指令（名稱與 `/help` 相同）。 原生命令註冊使用 `commands.native`（全域預設 `"auto"` → Slack 關閉），並可透過 `channels.slack.commands.native` 為每個工作區覆寫。文字命令需要獨立的 `/...` 訊息，且可用 `commands.text: false` 停用。Slack 斜線命令由 Slack 應用程式管理，不會自動移除。使用 `commands.useAccessGroups: false` 可略過命令的存取群組檢查。
8. App Home → 啟用 **Messages Tab**，讓使用者可以私訊機器人。

請使用下方的 manifest，以確保範圍與事件保持同步。

多帳號支援：使用 `channels.slack.accounts` 搭配每個帳號各自的權杖，以及選用的 `name`。共享模式請參考 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts)。 33. 共享模式請參閱 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts)。

### OpenClaw 設定（Socket 模式）

34. 透過環境變數設定權杖（建議）：

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

或透過設定檔：

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### 使用者權杖（選用）

OpenClaw 可以使用 Slack 使用者權杖（`xoxp-...`）進行讀取操作（歷史記錄、
釘選、反應、表情符號、成員資訊）。預設為唯讀：讀取在可用時優先使用使用者權杖，而寫入仍使用機器人權杖，除非你明確選擇加入。即使設定 `userTokenReadOnly: false`，當機器人權杖可用時，寫入仍會優先使用機器人權杖。 35. 預設情況下這會維持唯讀：讀取時
在存在使用者權杖時會優先使用，寫入仍會使用機器人權杖，除非
你明確選擇加入。 36. 即使設定 `userTokenReadOnly: false`，在可用時，
寫入仍會優先使用機器人權杖。

37. 使用者權杖是在設定檔中設定（不支援環境變數）。 使用者權杖需在設定檔中設定（不支援環境變數）。多帳號情境請設定 `channels.slack.accounts.<id>.userToken`。

同時使用 bot＋app＋user 權杖的範例：

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

明確設定 userTokenReadOnly（允許使用者權杖寫入）的範例：

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### 38. 權杖使用方式

- 39. 讀取操作（歷史紀錄、反應清單、釘選清單、表情符號清單、成員資訊、
      搜尋）在已設定時會優先使用使用者權杖，否則使用機器人權杖。
- 40. 寫入操作（傳送/編輯/刪除訊息、加入/移除反應、釘選/取消釘選、
      檔案上傳）預設使用機器人權杖。 If `userTokenReadOnly: false` and
      no bot token is available, OpenClaw falls back to the user token.

### 歷史脈絡

- `channels.slack.historyLimit`（或 `channels.slack.accounts.*.historyLimit`）控制要將多少最近的頻道／群組訊息包入提示中。
- 會退回到 `messages.groupChat.historyLimit`。將 `0` 設為停用（預設 50）。 Set `0` to disable (default 50).

## HTTP 模式（Events API）

當你的 Gateway 閘道器可透過 HTTPS 被 Slack 存取時，請使用 HTTP webhook 模式（典型的伺服器部署）。
HTTP 模式使用 Events API＋Interactivity＋Slash Commands，並共用同一個請求 URL。
HTTP mode uses the Events API + Interactivity + Slash Commands with a shared request URL.

### 設定（HTTP 模式）

1. 建立 Slack 應用程式並 **停用 Socket Mode**（若只使用 HTTP，則為選用）。
2. **Basic Information** → 複製 **Signing Secret**。
3. **OAuth & Permissions** → 安裝應用程式並複製 **Bot User OAuth Token**（`xoxb-...`）。
4. **Event Subscriptions** → 啟用事件，並將 **Request URL** 設為你的 Gateway 閘道器 webhook 路徑（預設 `/slack/events`）。
5. **Interactivity & Shortcuts** → 啟用並設定相同的 **Request URL**。
6. **Slash Commands** → 為你的命令設定相同的 **Request URL**。

請求 URL 範例：
`https://gateway-host/slack/events`

### OpenClaw 設定（最小）

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

多帳號 HTTP 模式：設定 `channels.slack.accounts.<id>.mode = "http"`，並為每個帳號提供唯一的
`webhookPath`，讓每個 Slack 應用程式都指向自己的 URL。

### Manifest（選用）

使用此 Slack 應用程式 manifest 可快速建立應用程式（如有需要可調整名稱／命令）。若你打算設定使用者權杖，請包含使用者範圍。 Include the
user scopes if you plan to configure a user token.

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

If you enable native commands, add one `slash_commands` entry per command you want to expose (matching the `/help` list). 依預設，沙箱容器 **沒有網路**。
可使用 `channels.slack.commands.native` 覆寫。

## 範圍（目前 vs 選用）

Slack's Conversations API is type-scoped: you only need the scopes for the
conversation types you actually touch (channels, groups, im, mpim). Slack 的 Conversations API 為類型分域：你只需要實際使用到的對話類型（channels、groups、im、mpim）所需的範圍。概覽請參考
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/)。

### Bot token scopes (required)

- `chat:write`（透過 `chat.postMessage` 傳送／更新／刪除訊息）
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write`（透過 `conversations.open` 開啟私訊）
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`、`groups:history`、`im:history`、`mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`、`groups:read`、`im:read`、`mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read`（使用者查詢）
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`、`reactions:write`（`reactions.get`／`reactions.add`）
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`、`pins:write`（`pins.list`／`pins.add`／`pins.remove`）
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read`（`emoji.list`）
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write`（透過 `files.uploadV2` 上傳）
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### User token scopes (optional, read-only by default)

若你設定 `channels.slack.userToken`，請在 **User Token Scopes** 下新增以下項目。

- `channels:history`、`groups:history`、`im:history`、`mpim:history`
- `channels:read`、`groups:read`、`im:read`、`mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### 目前不需要（但可能未來需要）

- `mpim:write`（僅當我們新增透過 `conversations.open` 開啟群組私訊／開始私訊）
- `groups:write`（僅當我們新增私有頻道管理：建立／重新命名／邀請／封存）
- `chat:write.public`（僅當我們需要發佈到機器人未加入的頻道）
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email`（僅當我們需要來自 `users.info` 的電子郵件欄位）
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read`（僅當我們開始列出／讀取檔案中繼資料）

## 設定

Slack 僅使用 Socket 模式（不提供 HTTP webhook 伺服器）。請提供兩個權杖： Provide both tokens:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

Tokens can also be supplied via env vars:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Ack 反應由全域的 `messages.ackReaction` +
`messages.ackReactionScope` 控制。使用 `messages.removeAckAfterReply` 在機器人回覆後清除
ack 反應。 Use `messages.removeAckAfterReply` to clear the
ack reaction after the bot replies.

## 限制

- 外送文字會被分段為 `channels.slack.textChunkLimit`（預設 4000）。
- 選用的換行分段：設定 `channels.slack.chunkMode="newline"`，在長度分段前先依空白行（段落邊界）分割。
- 媒體上傳上限由 `channels.slack.mediaMaxMb` 控制（預設 20）。

## 回覆串（Threading）

By default, OpenClaw replies in the main channel. 預設情況下，OpenClaw 會在主頻道回覆。使用 `channels.slack.replyToMode` 來控制自動串回：

| 模式      | 行為                                                                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | **Default.** Reply in main channel. Only thread if the triggering message was already in a thread.                                                                     |
| `first` | First reply goes to thread (under the triggering message), subsequent replies go to main channel. Useful for keeping context visible while avoiding thread clutter. |
| `all`   | All replies go to thread. Keeps conversations contained but may reduce visibility.                                                                                                     |

此模式同時適用於自動回覆與代理程式工具呼叫（`slack sendMessage`）。

### 依聊天類型的串回

你可以透過設定 `channels.slack.replyToModeByChatType`，為不同聊天類型配置不同的串回行為：

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

支援的聊天類型：

- `direct`：1:1 私訊（Slack `im`）
- `group`：群組私訊／MPIM（Slack `mpim`）
- `channel`：一般頻道（公開／私有）

優先順序：

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. 提供者預設（`off`）

舊版的 `channels.slack.dm.replyToMode` 仍可作為 `direct` 的備援，當未設定聊天類型覆寫時使用。

範例：

Thread DMs only:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

將群組私訊串回，但讓頻道維持在根層：

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

Make channels thread, keep DMs in the root:

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### Manual threading tags

為了更細緻的控制，請在代理程式回應中使用以下標籤：

- `[[reply_to_current]]` — 回覆到觸發訊息（開始／延續串）。
- `[[reply_to:<id>]]` — 回覆到指定的訊息 ID。

## Sessions + routing

- DMs share the `main` session (like WhatsApp/Telegram).
- 頻道對應到 `agent:<agentId>:slack:channel:<channelId>` 工作階段。
- Slash 命令使用 `agent:<agentId>:slack:slash:<userId>` 工作階段（前綴可透過 `channels.slack.slashCommand.sessionPrefix` 設定）。
- 若 Slack 未提供 `channel_type`，OpenClaw 會依頻道 ID 前綴（`D`、`C`、`G`）推斷，並預設為 `channel` 以保持工作階段鍵穩定。
- Native command registration uses `commands.native` (global default `"auto"` → Slack off) and can be overridden per-workspace with `channels.slack.commands.native`. Text commands require standalone `/...` messages and can be disabled with `commands.text: false`. Slack slash commands are managed in the Slack app and are not removed automatically. Use `commands.useAccessGroups: false` to bypass access-group checks for commands.
- 完整命令清單與設定：[Slash commands](/tools/slash-commands)

## DM security (pairing)

- 預設：`channels.slack.dm.policy="pairing"` — 未知的私訊寄件者會收到配對碼（1 小時後過期）。
- 核准方式：`openclaw pairing approve slack <code>`。
- 允許任何人：設定 `channels.slack.dm.policy="open"` 與 `channels.slack.dm.allowFrom=["*"]`。
- `channels.slack.dm.allowFrom` 接受使用者 ID、@handle 或電子郵件（在權杖允許時於啟動時解析）。精靈在設定期間接受使用者名稱，並在權杖允許時解析為 ID。 The wizard accepts usernames and resolves them to ids during setup when tokens allow.

## 群組政策

- `channels.slack.groupPolicy` 控制頻道處理（`open|disabled|allowlist`）。
- `allowlist` 要求頻道必須列在 `channels.slack.channels` 中。
- 若你只設定 `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`，且從未建立 `channels.slack` 區段，
  執行時會將 `groupPolicy` 預設為 `open`。請新增 `channels.slack.groupPolicy`、
  `channels.defaults.groupPolicy`，或頻道允許清單以鎖定行為。 Add `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy`, or a channel allowlist to lock it down.
- The configure wizard accepts `#channel` names and resolves them to IDs when possible
  (public + private); if multiple matches exist, it prefers the active channel.
- 啟動時，OpenClaw 會在權杖允許下將允許清單中的頻道／使用者名稱解析為 ID，
  並記錄對應；無法解析的項目會保留原樣。
- 若要 **不允許任何頻道**，請設定 `channels.slack.groupPolicy: "disabled"`（或保留空的允許清單）。

頻道選項（`channels.slack.channels.<id>` 或 `channels.slack.channels.<name>`）：

- `allow`：在 `groupPolicy="allowlist"` 時允許／拒絕該頻道。
- `requireMention`：該頻道的提及門檻。
- `tools`：選用的每頻道工具政策覆寫（`allow`/`deny`/`alsoAllow`）。
- `toolsBySender`：頻道內的每寄件者工具政策覆寫（鍵為寄件者 ID／@handle／電子郵件；支援 `"*"` 萬用字元）。
- `allowBots`：允許機器人作者的訊息於此頻道（預設：false）。
- `users`：選用的每頻道使用者允許清單。
- `skills`：Skill 篩選（省略＝所有 Skills，空白＝無）。
- `systemPrompt`：頻道的額外系統提示（與主題／目的合併）。
- `enabled`：設定 `false` 以停用該頻道。

## 投遞目標

搭配 cron／CLI 傳送時使用：

- 私訊使用 `user:<id>`
- 頻道使用 `channel:<id>`

## 工具動作

Slack 工具動作可透過 `channels.slack.actions.*` 設限：

| 動作群組       | Default | 注意事項        |
| ---------- | ------- | ----------- |
| reactions  | enabled | 新增反應＋列出反應   |
| messages   | enabled | 讀取／傳送／編輯／刪除 |
| pins       | enabled | 釘選／取消釘選／列出  |
| memberInfo | enabled | 成員資訊        |
| emojiList  | enabled | 自訂表情符號清單    |

## 安全性注意事項

- Writes default to the bot token so state-changing actions stay scoped to the
  app's bot permissions and identity.
- Setting `userTokenReadOnly: false` allows the user token to be used for write
  operations when a bot token is unavailable, which means actions run with the
  installing user's access. Treat the user token as highly privileged and keep
  action gates and allowlists tight.
- 若你啟用使用者權杖寫入，請確認使用者權杖包含你預期的寫入
  範圍（`chat:write`、`reactions:write`、`pins:write`、
  `files:write`），否則相關操作將失敗。

## Troubleshooting

請先依此階梯進行：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Then confirm DM pairing state if needed:

```bash
openclaw pairing list slack
```

常見失敗：

- 已連線但頻道沒有回覆：頻道被 `groupPolicy` 阻擋，或不在 `channels.slack.channels` 允許清單中。
- 私訊被忽略：在 `channels.slack.dm.policy="pairing"` 時寄件者未被核准。
- API 錯誤（`missing_scope`、`not_in_channel`、身分驗證失敗）：機器人／應用程式權杖或 Slack 範圍不完整。

分流流程請見：[/channels/troubleshooting](/channels/troubleshooting)。

## 注意事項

- 提及門檻由 `channels.slack.channels` 控制（將 `requireMention` 設為 `true`）；`agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）也會被視為提及。
- 多代理程式覆寫：在 `agents.list[].groupChat.mentionPatterns` 上為每個代理程式設定樣式。
- 反應通知遵循 `channels.slack.reactionNotifications`（使用 `reactionAllowlist` 搭配模式 `allowlist`）。
- 預設會忽略機器人作者的訊息；可透過 `channels.slack.allowBots` 或 `channels.slack.channels.<id>.allowBots` 啟用。
- 警告：若你允許回覆其他機器人（`channels.slack.allowBots=true` 或 `channels.slack.channels.<id>.allowBots=true`），請使用 `requireMention`、`channels.slack.channels.<id>.users` 允許清單，及／或在 `AGENTS.md` 與 `SOUL.md` 中設定明確的護欄，以避免機器人互相回覆形成迴圈。
- Slack 工具的反應移除語意請見 [/tools/reactions](/tools/reactions)。
- 在允許且未超過大小限制時，附件會下載至媒體儲存區。
