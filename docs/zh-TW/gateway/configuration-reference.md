---
title: Configuration Reference
description: Complete field-by-field reference for ~/.openclaw/openclaw.json
summary: >-
  Complete reference for every OpenClaw config key, defaults, and channel
  settings
read_when:
  - You need exact field-level config semantics or defaults
  - "You are validating channel, model, gateway, or tool config blocks"
---

# 設定參考

每個在 `~/.openclaw/openclaw.json` 中可用的欄位。欲了解任務導向的概覽，請參見 [Configuration](/gateway/configuration)。

設定格式為 **JSON5**（允許註解和尾隨逗號）。所有欄位都是可選的 — OpenClaw 在省略時會使用安全的預設值。

---

## Channels

每個通道在其設定區段存在時會自動啟動（除非 `enabled: false`）。

### DM 和群組存取

所有頻道都支援 DM 政策和群組政策：

| DM 政策          | 行為                                          |
| ---------------- | --------------------------------------------- |
| `pairing` (預設) | 不明發件者會獲得一次性配對碼；擁有者必須批准  |
| `allowlist`      | 只有 `allowFrom` 中的發件者（或配對允許存儲） |
| `open`           | 允許所有進入的 DM（需要 `allowFrom: ["*"]`）  |
| `disabled`       | 忽略所有進入的 DM                             |

| 群組政策           | 行為                                 |
| ------------------ | ------------------------------------ |
| `allowlist` (預設) | 只有符合設定的允許清單的群組         |
| `open`             | 繞過群組允許清單（提及限制仍然適用） |
| `disabled`         | 阻止所有群組/房間消息                |

<Note>
`channels.defaults.groupPolicy` 設定當提供者的 `groupPolicy` 未設定時的預設值。配對程式碼在 1 小時後過期。待處理的 DM 配對請求每個頻道限制為 **3 個**。如果提供者區塊完全缺失 (`channels.<provider>` 缺失)，執行時群組政策將回退至 `allowlist`（失敗關閉），並顯示啟動警告。
</Note>

### Channel model overrides

使用 `channels.modelByChannel` 將特定的頻道 ID 固定到模型上。值可以接受 `provider/model` 或已設定的模型別名。當會話尚未有模型覆蓋（例如，透過 `/model` 設定）時，頻道映射將適用。

```json5
{
  channels: {
    modelByChannel: {
      discord: {
        "123456789012345678": "anthropic/claude-opus-4-6",
      },
      slack: {
        C1234567890: "openai/gpt-4.1",
      },
      telegram: {
        "-1001234567890": "openai/gpt-4.1-mini",
        "-1001234567890:topic:99": "anthropic/claude-sonnet-4-6",
      },
    },
  },
}
```

### Channel defaults and heartbeat

使用 `channels.defaults` 來實現跨供應商的共享群組政策和心跳行為：

```json5
{
  channels: {
    defaults: {
      groupPolicy: "allowlist", // open | allowlist | disabled
      heartbeat: {
        showOk: false,
        showAlerts: true,
        useIndicator: true,
      },
    },
  },
}
```

- `channels.defaults.groupPolicy`: 當提供者層級 `groupPolicy` 未設定時的備援群組政策。
- `channels.defaults.heartbeat.showOk`: 在心跳輸出中包含健康的通道狀態。
- `channels.defaults.heartbeat.showAlerts`: 在心跳輸出中包含降級/錯誤狀態。
- `channels.defaults.heartbeat.useIndicator`: 渲染緊湊的指示器風格心跳輸出。

### WhatsApp

WhatsApp 透過網關的網頁通道（Baileys Web）執行。當存在已連結的會話時，它會自動啟動。

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "+447700900123"],
      textChunkLimit: 4000,
      chunkMode: "length", // length | newline
      mediaMaxMb: 50,
      sendReadReceipts: true, // blue ticks (false in self-chat mode)
      groups: {
        "*": { requireMention: true },
      },
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
  web: {
    enabled: true,
    heartbeatSeconds: 60,
    reconnect: {
      initialMs: 2000,
      maxMs: 120000,
      factor: 1.4,
      jitter: 0.2,
      maxAttempts: 0,
    },
  },
}
```

<Accordion title="多帳號 WhatsApp">

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        default: {},
        personal: {},
        biz: {
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

- 出站命令預設使用帳戶 `default`（如果存在）；否則使用第一個已設定的帳戶 ID（按排序）。
- 可選的 `channels.whatsapp.defaultAccount` 會在其匹配已設定的帳戶 ID 時覆蓋該回退的預設帳戶選擇。
- 過去的單一帳戶 Baileys 認證目錄由 `openclaw doctor` 轉移至 `whatsapp/default`。
- 每個帳戶的覆蓋設定：`channels.whatsapp.accounts.<id>.sendReadReceipts`、`channels.whatsapp.accounts.<id>.dmPolicy`、`channels.whatsapp.accounts.<id>.allowFrom`。

</Accordion>

### Telegram

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "your-bot-token",
      dmPolicy: "pairing",
      allowFrom: ["tg:123456789"],
      groups: {
        "*": { requireMention: true },
        "-1001234567890": {
          allowFrom: ["@admin"],
          systemPrompt: "Keep answers brief.",
          topics: {
            "99": {
              requireMention: false,
              skills: ["search"],
              systemPrompt: "Stay on topic.",
            },
          },
        },
      },
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
      historyLimit: 50,
      replyToMode: "first", // off | first | all
      linkPreview: true,
      streaming: "partial", // off | partial | block | progress (default: off)
      actions: { reactions: true, sendMessage: true },
      reactionNotifications: "own", // off | own | all
      mediaMaxMb: 100,
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
      proxy: "socks5://localhost:9050",
      webhookUrl: "https://example.com/telegram-webhook",
      webhookSecret: "secret",
      webhookPath: "/telegram-webhook",
    },
  },
}
```

- Bot token: `channels.telegram.botToken` 或 `channels.telegram.tokenFile`（僅限常規檔案；不接受符號連結），以 `TELEGRAM_BOT_TOKEN` 作為預設帳戶的備援。
- 可選的 `channels.telegram.defaultAccount` 在匹配已設定的帳戶 ID 時，會覆蓋預設帳戶選擇。
- 在多帳戶設置（2 個以上的帳戶 ID）中，設置明確的預設 (`channels.telegram.defaultAccount` 或 `channels.telegram.accounts.default`) 以避免備援路由；`openclaw doctor` 會在缺少或無效時發出警告。
- `configWrites: false` 阻止 Telegram 發起的設定寫入（超級群組 ID 遷移，`/config set|unset`）。
- 頂層 `bindings[]` 條目與 `type: "acp"` 設定論壇主題的持久 ACP 綁定（在 `match.peer.id` 中使用標準 `chatId:topic:topicId`）。欄位語義在 [ACP Agents](/tools/acp-agents#channel-specific-settings) 中共享。
- Telegram 流預覽使用 `sendMessage` + `editMessageText`（在直接和群組聊天中均可使用）。
- 重試政策：請參見 [重試政策](/concepts/retry)。

### Discord

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "your-bot-token",
      mediaMaxMb: 8,
      allowBots: false,
      actions: {
        reactions: true,
        stickers: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        voiceStatus: true,
        events: true,
        moderation: false,
      },
      replyToMode: "off", // off | first | all
      dmPolicy: "pairing",
      allowFrom: ["1234567890", "123456789012345678"],
      dm: { enabled: true, groupEnabled: false, groupChannels: ["openclaw-dm"] },
      guilds: {
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          ignoreOtherMentions: true,
          reactionNotifications: "own",
          users: ["987654321098765432"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["docs"],
              systemPrompt: "Short answers only.",
            },
          },
        },
      },
      historyLimit: 20,
      textChunkLimit: 2000,
      chunkMode: "length", // length | newline
      streaming: "off", // off | partial | block | progress (progress maps to partial on Discord)
      maxLinesPerMessage: 17,
      ui: {
        components: {
          accentColor: "#5865F2",
        },
      },
      threadBindings: {
        enabled: true,
        idleHours: 24,
        maxAgeHours: 0,
        spawnSubagentSessions: false, // opt-in for sessions_spawn({ thread: true })
      },
      voice: {
        enabled: true,
        autoJoin: [
          {
            guildId: "123456789012345678",
            channelId: "234567890123456789",
          },
        ],
        daveEncryption: true,
        decryptionFailureTolerance: 24,
        tts: {
          provider: "openai",
          openai: { voice: "alloy" },
        },
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

- Token: `channels.discord.token`，預設帳戶的備援為 `DISCORD_BOT_TOKEN`。
- 直接的外撥電話如果提供明確的 Discord `token`，則使用該 token 進行通話；帳戶重試/政策設定仍然來自於活躍執行快照中選擇的帳戶。
- 可選的 `channels.discord.defaultAccount` 在匹配已設定的帳戶 ID 時會覆蓋預設帳戶選擇。
- 使用 `user:<id>` (DM) 或 `channel:<id>` (公會頻道) 作為傳遞目標；裸數字 ID 會被拒絕。
- 公會 slug 為小寫，空格被替換為 `-`；頻道鍵使用 slugged 名稱（不含 `#`）。優先使用公會 ID。
- 預設情況下，機器人創建的消息會被忽略。`allowBots: true` 使其啟用；使用 `allowBots: "mentions"` 只接受提及機器人的機器人消息（自己的消息仍然被過濾）。
- `channels.discord.guilds.<id>.ignoreOtherMentions`（及頻道覆蓋）會丟棄提及其他用戶或角色但不提及機器人的消息（不包括 @everyone/@here）。
- `maxLinesPerMessage`（預設為 17）即使在 2000 字元以下也會拆分高消息。
- `channels.discord.threadBindings` 控制 Discord 線程綁定路由：
  - `enabled`：Discord 對於線程綁定會話功能的覆蓋 (`/focus`、`/unfocus`、`/agents`、`/session idle`、`/session max-age` 和綁定的傳遞/路由)
  - `idleHours`：Discord 對於非活動自動失焦的覆蓋（`0` 禁用）
  - `maxAgeHours`：Discord 對於硬性最大年齡的覆蓋（`0` 禁用）
  - `spawnSubagentSessions`：選擇加入 `sessions_spawn({ thread: true })` 自動線程創建/綁定的開關
- 頂層 `bindings[]` 條目與 `type: "acp"` 設定頻道和線程的持久 ACP 綁定（在 `match.peer.id` 中使用頻道/線程 ID）。字段語義在 [ACP Agents](/tools/acp-agents#channel-specific-settings) 中共享。
- `channels.discord.ui.components.accentColor` 設定 Discord 元件 v2 容器的重點顏色。
- `channels.discord.voice` 啟用 Discord 語音頻道對話及可選的自動加入 + TTS 覆蓋。
- `channels.discord.voice.daveEncryption` 和 `channels.discord.voice.decryptionFailureTolerance` 透過 `@discordjs/voice` 傳遞 DAVE 選項 (`true` 和 `24` 為預設)。
- OpenClaw 另外嘗試透過在重複解密失敗後離開/重新加入語音會話來恢復語音接收。
- `channels.discord.streaming` 是標準流模式鍵。舊版 `streamMode` 和布林值 `streaming` 會自動遷移。
- `channels.discord.autoPresence` 將執行時可用性映射到機器人存在狀態（健康 => 在線，降級 => 閒置，耗盡 => 不打擾）並允許可選的狀態文本覆蓋。
- `channels.discord.dangerouslyAllowNameMatching` 重新啟用可變名稱/標籤匹配（緊急兼容模式）。

**反應通知模式：** `off` (無)，`own` (機器人的訊息，預設)，`all` (所有訊息)，`allowlist` (來自 `guilds.<id>.users` 的所有訊息)。

### Google Chat

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url", // app-url | project-number
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890",
      dm: {
        enabled: true,
        policy: "pairing",
        allowFrom: ["users/1234567890"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": { allow: true, requireMention: true },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

- 服務帳戶 JSON：內嵌 (`serviceAccount`) 或基於檔案 (`serviceAccountFile`)。
- 服務帳戶 SecretRef 也受到支援 (`serviceAccountRef`)。
- 環境變數回退：`GOOGLE_CHAT_SERVICE_ACCOUNT` 或 `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`。
- 使用 `spaces/<spaceId>` 或 `users/<userId>` 作為交付目標。
- `channels.googlechat.dangerouslyAllowNameMatching` 重新啟用可變電子郵件主體匹配（緊急情況相容模式）。

### Slack

```json5
{
  channels: {
    slack: {
      enabled: true,
      botToken: "xoxb-...",
      appToken: "xapp-...",
      dmPolicy: "pairing",
      allowFrom: ["U123", "U456", "*"],
      dm: { enabled: true, groupEnabled: false, groupChannels: ["G123"] },
      channels: {
        C123: { allow: true, requireMention: true, allowBots: false },
        "#general": {
          allow: true,
          requireMention: true,
          allowBots: false,
          users: ["U123"],
          skills: ["docs"],
          systemPrompt: "Short answers only.",
        },
      },
      historyLimit: 50,
      allowBots: false,
      reactionNotifications: "own",
      reactionAllowlist: ["U123"],
      replyToMode: "off", // off | first | all
      thread: {
        historyScope: "thread", // thread | channel
        inheritParent: false,
      },
      actions: {
        reactions: true,
        messages: true,
        pins: true,
        memberInfo: true,
        emojiList: true,
      },
      slashCommand: {
        enabled: true,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      typingReaction: "hourglass_flowing_sand",
      textChunkLimit: 4000,
      chunkMode: "length",
      streaming: "partial", // off | partial | block | progress (preview mode)
      nativeStreaming: true, // use Slack native streaming API when streaming=partial
      mediaMaxMb: 20,
    },
  },
}
```

- **Socket 模式** 需要同時使用 `botToken` 和 `appToken` (`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` 用於預設帳戶環境回退)。
- **HTTP 模式** 需要 `botToken` 加上 `signingSecret`（在根目錄或每個帳戶中）。
- `configWrites: false` 阻止 Slack 發起的設定寫入。
- 可選的 `channels.slack.defaultAccount` 在匹配已設定的帳戶 ID 時，會覆蓋預設帳戶選擇。
- `channels.slack.streaming` 是標準的串流模式鍵。舊版 `streamMode` 和布林值 `streaming` 會自動遷移。
- 使用 `user:<id>` (DM) 或 `channel:<id>` 作為交付目標。

**反應通知模式：** `off`、`own`（預設）、`all`、`allowlist`（來自 `reactionAllowlist`）。

**執行緒會話隔離：** `thread.historyScope` 是每個執行緒（預設）或在通道之間共享。`thread.inheritParent` 將父通道的記錄複製到新執行緒。

- `typingReaction` 在回覆執行時，會對進來的 Slack 訊息添加一個臨時反應，然後在完成後移除。使用 Slack 表情符號短碼，例如 `"hourglass_flowing_sand"`。

| 行動群組     | 預設 | 備註                |
| ------------ | ---- | ------------------- |
| 反應         | 啟用 | 反應 + 列出反應     |
| 訊息         | 啟用 | 讀取/發送/編輯/刪除 |
| 釘選         | 啟用 | 釘選/取消釘選/列出  |
| 成員資訊     | 啟用 | 成員資訊            |
| 表情符號列表 | 啟用 | 自訂表情符號列表    |

### Mattermost

Mattermost 以插件的形式發佈：`openclaw plugins install @openclaw/mattermost`。

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
      chatmode: "oncall", // oncall | onmessage | onchar
      oncharPrefixes: [">", "!"],
      commands: {
        native: true, // opt-in
        nativeSkills: true,
        callbackPath: "/api/channels/mattermost/command",
        // Optional explicit URL for reverse-proxy/public deployments
        callbackUrl: "https://gateway.example.com/api/channels/mattermost/command",
      },
      textChunkLimit: 4000,
      chunkMode: "length",
    },
  },
}
```

聊天模式：`oncall`（在 @-提及時回應，預設），`onmessage`（每則訊息），`onchar`（以觸發前綴開頭的訊息）。

當 Mattermost 原生指令啟用時：

- `commands.callbackPath` 必須是一個路徑（例如 `/api/channels/mattermost/command`），而不是完整的 URL。
- `commands.callbackUrl` 必須解析到 OpenClaw 閘道端點，並且能從 Mattermost 伺服器訪問。
- 對於私有/tailnet/內部回調主機，Mattermost 可能需要 `ServiceSettings.AllowedUntrustedInternalConnections` 包含回調主機/域名。
  使用主機/域名值，而不是完整的 URL。
- `channels.mattermost.configWrites`：允許或拒絕 Mattermost 發起的設定寫入。
- `channels.mattermost.requireMention`：在回覆頻道之前需要 `@mention`。
- 可選的 `channels.mattermost.defaultAccount` 在匹配已設定的帳戶 ID 時會覆蓋預設的帳戶選擇。

### Signal

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15555550123", // optional account binding
      dmPolicy: "pairing",
      allowFrom: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      configWrites: true,
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      historyLimit: 50,
    },
  },
}
```

**反應通知模式：** `off`，`own`（預設），`all`，`allowlist`（來自 `reactionAllowlist`）。

- `channels.signal.account`: 將通道啟動固定到特定的 Signal 帳戶身份。
- `channels.signal.configWrites`: 允許或拒絕 Signal 發起的設定寫入。
- 可選的 `channels.signal.defaultAccount` 在匹配已設定的帳戶 ID 時，覆蓋預設的帳戶選擇。

### BlueBubbles

BlueBubbles 是推薦的 iMessage 路徑（由插件支援，設定於 `channels.bluebubbles`）。

```json5
{
  channels: {
    bluebubbles: {
      enabled: true,
      dmPolicy: "pairing",
      // serverUrl, password, webhookPath, group controls, and advanced actions:
      // see /channels/bluebubbles
    },
  },
}
```

- 此處涵蓋的核心關鍵路徑：`channels.bluebubbles`、`channels.bluebubbles.dmPolicy`。
- 當可選的 `channels.bluebubbles.defaultAccount` 與已設定的帳戶 ID 匹配時，將覆蓋預設的帳戶選擇。
- 完整的 BlueBubbles 通道設定檔已在 [BlueBubbles](/channels/bluebubbles) 中記錄。

### iMessage

OpenClaw 生成 `imsg rpc`（透過標準輸入輸出進行 JSON-RPC）。不需要守護進程或端口。

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "imsg",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "user@gateway-host",
      dmPolicy: "pairing",
      allowFrom: ["+15555550123", "user@example.com", "chat_id:123"],
      historyLimit: 50,
      includeAttachments: false,
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      mediaMaxMb: 16,
      service: "auto",
      region: "US",
    },
  },
}
```

- 可選的 `channels.imessage.defaultAccount` 當與已設定的帳戶 ID 匹配時，會覆蓋預設的帳戶選擇。

- 需要對 Messages DB 進行完整磁碟存取。
- 優先使用 `chat_id:<id>` 目標。使用 `imsg chats --limit 20` 列出聊天紀錄。
- `cliPath` 可以指向 SSH 包裝器；設定 `remoteHost` (`host` 或 `user@host`) 以獲取 SCP 附件。
- `attachmentRoots` 和 `remoteAttachmentRoots` 限制進入的附件路徑（預設值：`/Users/*/Library/Messages/Attachments`）。
- SCP 使用嚴格的主機金鑰檢查，因此請確保中繼主機金鑰已存在於 `~/.ssh/known_hosts` 中。
- `channels.imessage.configWrites`：允許或拒絕 iMessage 發起的設定寫入。

<Accordion title="iMessage SSH 包裝範例">

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

</Accordion>

### Microsoft Teams

Microsoft Teams 是擴充支援的，並在 `channels.msteams` 下進行設定。

```json5
{
  channels: {
    msteams: {
      enabled: true,
      configWrites: true,
      // appId, appPassword, tenantId, webhook, team/channel policies:
      // see /channels/msteams
    },
  },
}
```

- 這裡涵蓋的核心關鍵路徑：`channels.msteams`，`channels.msteams.configWrites`。
- 完整的 Teams 設定（憑證、網路鉤子、私訊/群組政策、每個團隊/每個頻道的覆蓋設定）已在 [Microsoft Teams](/channels/msteams) 中記錄。

### IRC

IRC 是擴充支援的，並在 `channels.irc` 下進行設定。

```json5
{
  channels: {
    irc: {
      enabled: true,
      dmPolicy: "pairing",
      configWrites: true,
      nickserv: {
        enabled: true,
        service: "NickServ",
        password: "${IRC_NICKSERV_PASSWORD}",
        register: false,
        registerEmail: "bot@example.com",
      },
    },
  },
}
```

- 此處涵蓋的核心關鍵路徑：`channels.irc`、`channels.irc.dmPolicy`、`channels.irc.configWrites`、`channels.irc.nickserv.*`。
- 當選擇的帳戶 ID 與已設定的帳戶 ID 匹配時，選用的 `channels.irc.defaultAccount` 會覆蓋預設的帳戶選擇。
- 完整的 IRC 頻道設定（主機/埠/TLS/頻道/允許清單/提及限制）已在 [IRC](/channels/irc) 中記錄。

### 多帳號（所有頻道）

在每個頻道執行多個帳戶（每個帳戶都有自己的 `accountId`）：

```json5
{
  channels: {
    telegram: {
      accounts: {
        default: {
          name: "Primary bot",
          botToken: "123456:ABC...",
        },
        alerts: {
          name: "Alerts bot",
          botToken: "987654:XYZ...",
        },
      },
    },
  },
}
```

- `default` 用於省略 `accountId` 時（CLI + 路由）。
- 環境 token 僅適用於 **預設** 帳戶。
- 基本通道設定適用於所有帳戶，除非每個帳戶另行覆蓋。
- 使用 `bindings[].match.accountId` 將每個帳戶路由到不同的代理。
- 如果您透過 `openclaw channels add`（或通道啟用）在仍然使用單一帳戶的頂層通道設定時新增非預設帳戶，OpenClaw 會先將帳戶範圍的頂層單一帳戶值移入 `channels.<channel>.accounts.default`，以便原始帳戶繼續運作。
- 現有的僅通道綁定（無 `accountId`）仍然匹配預設帳戶；帳戶範圍的綁定仍然是可選的。
- `openclaw doctor --fix` 也會修復混合形狀，通過在命名帳戶存在但 `default` 缺失時，將帳戶範圍的頂層單一帳戶值移入 `accounts.default`。

### 其他擴充通道

許多擴充通道被設定為 `channels.<id>`，並在其專屬通道頁面中進行記錄（例如 Feishu、Matrix、LINE、Nostr、Zalo、Nextcloud Talk、Synology Chat 和 Twitch）。  
查看完整的通道索引：[Channels](/channels)。

### 群組聊天提及限制

群組訊息預設為 **需要提及**（元資料提及或正則表達式模式）。適用於 WhatsApp、Telegram、Discord、Google Chat 和 iMessage 群組聊天。

**提及類型：**

- **元資料提及**：本地平台 @-提及。在 WhatsApp 自我聊天模式下被忽略。
- **文本模式**：`agents.list[].groupChat.mentionPatterns` 中的正則表達式模式。始終進行檢查。
- 只有在能夠檢測到時（本地提及或至少一個模式）才會強制執行提及閘道。

```json5
{
  messages: {
    groupChat: { historyLimit: 50 },
  },
  agents: {
    list: [{ id: "main", groupChat: { mentionPatterns: ["@openclaw", "openclaw"] } }],
  },
}
```

`messages.groupChat.historyLimit` 設定全域預設值。頻道可以使用 `channels.<channel>.historyLimit`（或每個帳戶）來覆蓋。設定 `0` 以禁用。

#### DM 歷史限制

```json5
{
  channels: {
    telegram: {
      dmHistoryLimit: 30,
      dms: {
        "123456789": { historyLimit: 50 },
      },
    },
  },
}
```

解析：每個 DM 覆蓋 → 提供者預設 → 無限制（全部保留）。

支援: `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `imessage`, `msteams`。

#### Self-chat mode

將您的號碼包含在 `allowFrom` 中以啟用自我聊天模式（忽略原生 @-提及，僅對文本模式做出回應）：

```json5
{
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: { mentionPatterns: ["reisponde", "@openclaw"] },
      },
    ],
  },
}
```

### 指令 (聊天指令處理)

```json5
{
  commands: {
    native: "auto", // register native commands when supported
    text: true, // parse /commands in chat messages
    bash: false, // allow ! (alias: /bash)
    bashForegroundMs: 2000,
    config: false, // allow /config
    debug: false, // allow /debug
    restart: false, // allow /restart + gateway restart tool
    allowFrom: {
      "*": ["user1"],
      discord: ["user:123"],
    },
    useAccessGroups: true,
  },
}
```

<Accordion title="指令詳細資訊">

- 文本命令必須是 **獨立** 的訊息，前面加上 `/`。
- `native: "auto"` 會啟用 Discord/Telegram 的原生命令，Slack 則不啟用。
- 每個頻道的覆蓋設定：`channels.discord.commands.native` (布林值或 `"auto"`)。`false` 會清除先前註冊的命令。
- `channels.telegram.customCommands` 會新增額外的 Telegram 機器人選單專案。
- `bash: true` 會啟用 `! <cmd>` 用於主機 shell。需要 `tools.elevated.enabled` 並且發送者在 `tools.elevated.allowFrom.<channel>` 中。
- `config: true` 會啟用 `/config` (讀取/寫入 `openclaw.json`)。對於網關 `chat.send` 用戶端，持久的 `/config set|unset` 寫入也需要 `operator.admin`；只讀的 `/config show` 對於正常的寫入範圍操作員用戶端仍然可用。
- `channels.<provider>.configWrites` 會限制每個頻道的設定變更 (預設：true)。
- 對於多帳號頻道，`channels.<provider>.accounts.<id>.configWrites` 也會限制針對該帳號的寫入 (例如 `/allowlist --config --account <id>` 或 `/config set channels.<provider>.accounts.<id>...`)。
- `allowFrom` 是每個提供者的設定。當設置時，它是 **唯一** 的授權來源 (頻道白名單/配對和 `useAccessGroups` 會被忽略)。
- `useAccessGroups: false` 允許命令在 `allowFrom` 未設置時繞過訪問群組政策。

</Accordion>

---

## Agent defaults

### `agents.defaults.workspace`

Default: `~/.openclaw/workspace`.

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

### `agents.defaults.repoRoot`

系統提示的執行時行中顯示可選的儲存庫根目錄。如果未設置，OpenClaw 將通過從工作區向上遍歷來自動檢測。

```json5
{
  agents: { defaults: { repoRoot: "~/Projects/openclaw" } },
}
```

### `agents.defaults.skipBootstrap`

禁用自動創建工作區引導檔案 (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`).

```json5
{
  agents: { defaults: { skipBootstrap: true } },
}
```

### `agents.defaults.bootstrapMaxChars`

每個工作區啟動檔案在截斷前的最大字元數。預設值：`20000`。

```json5
{
  agents: { defaults: { bootstrapMaxChars: 20000 } },
}
```

### `agents.defaults.bootstrapTotalMaxChars`

所有工作區啟動檔案中注入的最大總字元數。預設值：`150000`。

```json5
{
  agents: { defaults: { bootstrapTotalMaxChars: 150000 } },
}
```

### `agents.defaults.bootstrapPromptTruncationWarning`

控制代理可見的警告文字，當引導上下文被截斷時。
預設值：`"once"`。

- `"off"`: 永遠不要將警告文字注入系統提示中。
- `"once"`: 每個唯一的截斷簽名注入一次警告（建議）。
- `"always"`: 當存在截斷時，在每次執行時注入警告。

```json5
{
  agents: { defaults: { bootstrapPromptTruncationWarning: "once" } }, // off | once | always
}
```

### `agents.defaults.imageMaxDimensionPx`

在提供者呼叫之前，轉錄/工具圖像區塊中最長圖像邊的最大像素大小。  
預設值：`1200`。

較低的數值通常會減少視覺 token 的使用量和請求有效載荷的大小，特別是在截圖較多的執行中。較高的數值則能保留更多的視覺細節。

```json5
{
  agents: { defaults: { imageMaxDimensionPx: 1200 } },
}
```

### `agents.defaults.userTimezone`

系統提示上下文的時區（不是訊息時間戳記）。如果沒有設定，則回退至主機時區。

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

### `agents.defaults.timeFormat`

系統提示中的時間格式。預設：`auto`（作業系統偏好設定）。

```json5
{
  agents: { defaults: { timeFormat: "auto" } }, // auto | 12 | 24
}
```

### `agents.defaults.model`

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.5": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.5"],
      },
      imageModel: {
        primary: "openrouter/qwen/qwen-2.5-vl-72b-instruct:free",
        fallbacks: ["openrouter/google/gemini-2.0-flash-vision:free"],
      },
      pdfModel: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-5-mini"],
      },
      pdfMaxBytesMb: 10,
      pdfMaxPages: 20,
      thinkingDefault: "low",
      verboseDefault: "off",
      elevatedDefault: "on",
      timeoutSeconds: 600,
      mediaMaxMb: 5,
      contextTokens: 200000,
      maxConcurrent: 3,
    },
  },
}
```

- `model`：接受字串 (`"provider/model"`) 或物件 (`{ primary, fallbacks }`)。
  - 字串形式僅設定主要模型。
  - 物件形式設定主要模型及有序的備援模型。
- `imageModel`：接受字串 (`"provider/model"`) 或物件 (`{ primary, fallbacks }`)。
  - 由 `image` 工具路徑作為其視覺模型設定使用。
  - 當選定的/預設模型無法接受影像輸入時，也用作備援路由。
- `pdfModel`：接受字串 (`"provider/model"`) 或物件 (`{ primary, fallbacks }`)。
  - 由 `pdf` 工具用於模型路由。
  - 如果省略，PDF 工具將回退到 `imageModel`，然後是最佳努力提供者的預設值。
- `pdfMaxBytesMb`：當呼叫時未傳遞 `maxBytesMb`，`pdf` 工具的預設 PDF 大小限制。
- `pdfMaxPages`：在 `pdf` 工具中，提取備援模式考慮的預設最大頁數。
- `model.primary`：格式 `provider/model`（例如 `anthropic/claude-opus-4-6`）。如果省略提供者，OpenClaw 假設 `anthropic`（已棄用）。
- `models`：為 `/model` 設定的模型目錄和允許清單。每個條目可以包括 `alias`（快捷方式）和 `params`（特定於提供者，例如 `temperature`、`maxTokens`、`cacheRetention`、`context1m`）。
- `params` 合併優先順序（設定）：`agents.defaults.models["provider/model"].params` 是基礎，然後 `agents.list[].params`（匹配代理 ID）根據鍵覆蓋。
- 變更這些欄位的設定寫入器（例如 `/models set`、`/models set-image` 和備援添加/移除命令）保存標準物件形式，並在可能的情況下保留現有的備援清單。
- `maxConcurrent`：跨會話的最大平行代理執行數（每個會話仍然是序列化的）。預設：1。

**內建別名簡寫**（僅在模型處於 `agents.defaults.models` 時適用）：

| 別名                | 模型                                   |
| ------------------- | -------------------------------------- |
| `opus`              | `anthropic/claude-opus-4-6`            |
| `sonnet`            | `anthropic/claude-sonnet-4-6`          |
| `gpt`               | `openai/gpt-5.4`                       |
| `gpt-mini`          | `openai/gpt-5-mini`                    |
| `gemini`            | `google/gemini-3.1-pro-preview`        |
| `gemini-flash`      | `google/gemini-3-flash-preview`        |
| `gemini-flash-lite` | `google/gemini-3.1-flash-lite-preview` |

您設定的別名總是優先於預設值。

Z.AI GLM-4.x 模型會自動啟用思考模式，除非你設定 `--thinking off` 或自行定義 `agents.defaults.models["zai/<model>"].params.thinking`。  
Z.AI 模型預設啟用 `tool_stream` 以進行工具呼叫串流。將 `agents.defaults.models["zai/<model>"].params.tool_stream` 設定為 `false` 以禁用它。  
Anthropic Claude 4.6 模型在未設定明確思考級別時，預設為 `adaptive` 思考。

### `agents.defaults.cliBackends`

可選的 CLI 後端用於僅文字的備援執行（不進行工具調用）。當 API 提供者失敗時，這對作為備份非常有用。

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          modelArg: "--model",
          sessionArg: "--session",
          sessionMode: "existing",
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
        },
      },
    },
  },
}
```

- CLI 後端以文字為主；工具始終處於禁用狀態。
- 當 `sessionArg` 被設置時，支援會話。
- 當 `imageArg` 接受檔案路徑時，支援影像通過。

### `agents.defaults.heartbeat`

[[BLOCK_1]] 定期的心跳執行。 [[BLOCK_1]]

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // 0m disables
        model: "openai/gpt-5.2-mini",
        includeReasoning: false,
        lightContext: false, // default: false; true keeps only HEARTBEAT.md from workspace bootstrap files
        session: "main",
        to: "+15555550123",
        directPolicy: "allow", // allow (default) | block
        target: "none", // default: none | options: last | whatsapp | telegram | discord | ...
        prompt: "Read HEARTBEAT.md if it exists...",
        ackMaxChars: 300,
        suppressToolErrorWarnings: false,
      },
    },
  },
}
```

- `every`: 持續時間字串 (毫秒/秒/分鐘/小時)。預設值: `30m`。
- `suppressToolErrorWarnings`: 當為真時，在心跳執行期間抑制工具錯誤警告有效負載。
- `directPolicy`: 直接/DM 傳遞政策。`allow` (預設) 允許直接目標傳遞。`block` 抑制直接目標傳遞並發出 `reason=dm-blocked`。
- `lightContext`: 當為真時，心跳執行使用輕量級啟動上下文，並僅保留 `HEARTBEAT.md` 來自工作區啟動檔案。
- 每個代理: 設定 `agents.list[].heartbeat`。當任何代理定義 `heartbeat` 時，**只有那些代理** 會執行心跳。
- 心跳執行完整的代理回合 — 短的間隔會消耗更多的 token。

### `agents.defaults.compaction`

```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard", // default | safeguard
        reserveTokensFloor: 24000,
        identifierPolicy: "strict", // strict | off | custom
        identifierInstructions: "Preserve deployment IDs, ticket IDs, and host:port pairs exactly.", // used when identifierPolicy=custom
        postCompactionSections: ["Session Startup", "Red Lines"], // [] disables reinjection
        model: "openrouter/anthropic/claude-sonnet-4-5", // optional compaction-only model override
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 6000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

- `mode`: `default` 或 `safeguard`（針對長歷史的分塊摘要）。請參見 [Compaction](/concepts/compaction)。
- `identifierPolicy`: `strict`（預設）、`off` 或 `custom`。`strict` 在壓縮摘要期間前置內建的不透明識別符保留指導。
- `identifierInstructions`: 當 `identifierPolicy=custom` 時使用的可選自訂識別符保留文本。
- `postCompactionSections`: 可選的 AGENTS.md H2/H3 區段名稱，在壓縮後重新注入。預設為 `["Session Startup", "Red Lines"]`；設置 `[]` 以禁用重新注入。當未設置或明確設置為該預設對時，舊的 `Every Session`/`Safety` 標題也會被接受作為遺留回退。
- `model`: 僅用於壓縮摘要的可選 `provider/model-id` 覆蓋。當主要會話應保持一個模型但壓縮摘要應在另一個模型上執行時使用；當未設置時，壓縮使用會話的主要模型。
- `memoryFlush`: 在自動壓縮之前的靜默代理轉換，以存儲持久記憶。當工作區為唯讀時將被跳過。

### `agents.defaults.contextPruning`

在將資料發送到 LLM 之前，會從記憶體上下文中修剪 **舊工具結果**。這不會修改磁碟上的會話歷史記錄。

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "cache-ttl", // off | cache-ttl
        ttl: "1h", // duration (ms/s/m/h), default unit: minutes
        keepLastAssistants: 3,
        softTrimRatio: 0.3,
        hardClearRatio: 0.5,
        minPrunableToolChars: 50000,
        softTrim: { maxChars: 4000, headChars: 1500, tailChars: 1500 },
        hardClear: { enabled: true, placeholder: "[Old tool result content cleared]" },
        tools: { deny: ["browser", "canvas"] },
      },
    },
  },
}
```

<Accordion title="cache-ttl 模式行為">

- `mode: "cache-ttl"` 啟用修剪過程。
- `ttl` 控制修剪在上次快取觸碰後可以再次執行的頻率。
- 修剪首先會軟性修剪過大的工具結果，然後在需要時硬性清除較舊的工具結果。

**Soft-trim** 保留開頭和結尾，並在中間插入 `...`。

**Hard-clear** 用佔位符替換整個工具結果。

[[BLOCK_1]]

- 圖像區塊永遠不會被修剪/清除。
- 比例是基於字元的（大約），而不是精確的 token 數量。
- 如果存在的助理訊息少於 `keepLastAssistants`，則跳過修剪。

</Accordion>

請參閱 [Session Pruning](/concepts/session-pruning) 以獲取行為詳細資訊。

### Block streaming

```json5
{
  agents: {
    defaults: {
      blockStreamingDefault: "off", // on | off
      blockStreamingBreak: "text_end", // text_end | message_end
      blockStreamingChunk: { minChars: 800, maxChars: 1200 },
      blockStreamingCoalesce: { idleMs: 1000 },
      humanDelay: { mode: "natural" }, // off | natural | custom (use minMs/maxMs)
    },
  },
}
```

- 非 Telegram 頻道需要明確的 `*.blockStreaming: true` 來啟用區塊回覆。
- 頻道覆蓋：`channels.<channel>.blockStreamingCoalesce`（以及每個帳戶的變體）。Signal/Slack/Discord/Google Chat 預設 `minChars: 1500`。
- `humanDelay`：區塊回覆之間的隨機暫停。`natural` = 800–2500 毫秒。每個代理的覆蓋：`agents.list[].humanDelay`。

請參閱 [Streaming](/concepts/streaming) 以獲取行為和分塊的詳細資訊。

### Typing indicators

```json5
{
  agents: {
    defaults: {
      typingMode: "instant", // never | instant | thinking | message
      typingIntervalSeconds: 6,
    },
  },
}
```

- 預設值：`instant` 用於直接聊天/提及，`message` 用於未提及的群組聊天。
- 每次會話的覆蓋：`session.typingMode`，`session.typingIntervalSeconds`。

請參閱 [Typing Indicators](/concepts/typing-indicators)。

### `agents.defaults.sandbox`

可選的 **Docker 沙盒** 用於嵌入式代理。請參閱 [Sandboxing](/gateway/sandboxing) 獲取完整指南。

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
          binds: ["/home/user/source:/source:rw"],
        },
        browser: {
          enabled: false,
          image: "openclaw-sandbox-browser:bookworm-slim",
          network: "openclaw-sandbox-browser",
          cdpPort: 9222,
          cdpSourceRange: "172.21.0.1/32",
          vncPort: 5900,
          noVncPort: 6080,
          headless: false,
          enableNoVnc: true,
          allowHostControl: false,
          autoStart: true,
          autoStartTimeoutMs: 12000,
        },
        prune: {
          idleHours: 24,
          maxAgeDays: 7,
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "apply_patch",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

<Accordion title="沙盒詳細資訊">

**工作區存取：**

- `none`: 每個範疇的沙盒工作區在 `~/.openclaw/sandboxes`
- `ro`: 沙盒工作區位於 `/workspace`，代理工作區以唯讀方式掛載於 `/agent`
- `rw`: 代理工作區以讀寫方式掛載於 `/workspace`

**範圍：**

- `session`: 每個會話的容器 + 工作區
- `agent`: 每個代理的容器 + 工作區（預設）
- `shared`: 共享容器和工作區（無跨會話隔離）

**`setupCommand`** 在容器創建後執行一次（透過 `sh -lc`）。需要網路出口、可寫的根目錄以及根使用者。

**容器預設為 `network: "none"`** — 如果代理需要外部訪問，請設置為 `"bridge"`（或自定義橋接網路）。`"host"` 被阻擋。`"container:<id>"` 預設被阻擋，除非您明確設置 `sandbox.docker.dangerouslyAllowContainerNamespaceJoin: true`（緊急解鎖）。

**進來的附件**會被暫存到 `media/inbound/*` 的活躍工作區中。

**`docker.binds`** 會掛載額外的主機目錄；全域和每個代理的綁定會合併。

**沙盒瀏覽器** (`sandbox.browser.enabled`): Chromium + CDP 在容器中。noVNC URL 注入到系統提示中。無需 `browser.enabled` 在 `openclaw.json` 中。  
noVNC 觀察者訪問預設使用 VNC 認證，並且 OpenClaw 會發出一個短期有效的 token URL（而不是在共享 URL 中暴露密碼）。

- `allowHostControl: false` (預設) 阻止沙盒會話針對主機瀏覽器進行操作。
- `network` 預設為 `openclaw-sandbox-browser` (專用橋接網路)。僅在您明確希望全球橋接連接時，才設置為 `bridge`。
- `cdpSourceRange` 可選地限制 CDP 進入在容器邊緣的 CIDR 範圍（例如 `172.21.0.1/32`）。
- `sandbox.browser.binds` 僅將額外的主機目錄掛載到沙盒瀏覽器容器中。當設置時（包括 `[]`），它會替換瀏覽器容器的 `docker.binds`。
- 啟動預設在 `scripts/sandbox-browser-entrypoint.sh` 中定義，並針對容器主機進行調整：
  - `--remote-debugging-address=127.0.0.1`
  - `--remote-debugging-port=<derived from OPENCLAW_BROWSER_CDP_PORT>`
  - `--user-data-dir=${HOME}/.chrome`
  - `--no-first-run`
  - `--no-default-browser-check`
  - `--disable-3d-apis`
  - `--disable-gpu`
  - `--disable-software-rasterizer`
  - `--disable-dev-shm-usage`
  - `--disable-background-networking`
  - `--disable-features=TranslateUI`
  - `--disable-breakpad`
  - `--disable-crash-reporter`
  - `--renderer-process-limit=2`
  - `--no-zygote`
  - `--metrics-recording-only`
  - `--disable-extensions` (預設啟用)
  - `--disable-3d-apis`、`--disable-software-rasterizer` 和 `--disable-gpu` 預設啟用，若 WebGL/3D 使用需要，可以用 `OPENCLAW_BROWSER_DISABLE_GRAPHICS_FLAGS=0` 禁用。
  - `OPENCLAW_BROWSER_DISABLE_EXTENSIONS=0` 會重新啟用擴充，如果您的工作流程依賴於它們。
  - `--renderer-process-limit=2` 可以用 `OPENCLAW_BROWSER_RENDERER_PROCESS_LIMIT=<N>` 進行更改；設置 `0` 以使用 Chromium 的預設進程限制。
  - 當 `noSandbox` 啟用時，還包括 `--no-sandbox` 和 `--disable-setuid-sandbox`。
  - 預設是容器映像的基線；使用自定義瀏覽器映像和自定義入口點來更改容器預設。

</Accordion>

[[BLOCK_1]]  
建立映像檔：  
[[BLOCK_1]]

```bash
scripts/sandbox-setup.sh           # main sandbox image
scripts/sandbox-browser-setup.sh   # optional browser image
```

### `agents.list` (每個代理的覆蓋設定)

```json5
{
  agents: {
    list: [
      {
        id: "main",
        default: true,
        name: "Main Agent",
        workspace: "~/.openclaw/workspace",
        agentDir: "~/.openclaw/agents/main/agent",
        model: "anthropic/claude-opus-4-6", // or { primary, fallbacks }
        params: { cacheRetention: "none" }, // overrides matching defaults.models params by key
        identity: {
          name: "Samantha",
          theme: "helpful sloth",
          emoji: "🦥",
          avatar: "avatars/samantha.png",
        },
        groupChat: { mentionPatterns: ["@openclaw"] },
        sandbox: { mode: "off" },
        runtime: {
          type: "acp",
          acp: {
            agent: "codex",
            backend: "acpx",
            mode: "persistent",
            cwd: "/workspace/openclaw",
          },
        },
        subagents: { allowAgents: ["*"] },
        tools: {
          profile: "coding",
          allow: ["browser"],
          deny: ["canvas"],
          elevated: { enabled: true },
        },
      },
    ],
  },
}
```

- `id`: 穩定代理 ID（必填）。
- `default`: 當設定多個時，第一個生效（會記錄警告）。如果沒有設定，第一個列表專案為預設值。
- `model`: 字串形式僅覆蓋 `primary`；物件形式 `{ primary, fallbacks }` 會同時覆蓋兩者（`[]` 禁用全域回退）。僅覆蓋 `primary` 的 Cron 工作仍會繼承預設回退，除非你設定 `fallbacks: []`。
- `params`: 每個代理的串流參數會合併到 `agents.defaults.models` 中選定的模型專案上。用於代理特定的覆蓋，例如 `cacheRetention`、`temperature` 或 `maxTokens`，而不需重複整個模型目錄。
- `runtime`: 可選的每個代理執行時描述符。當代理應該預設為 ACP 體驗會話時，使用 `type: "acp"` 與 `runtime.acp` 預設值（`agent`、`backend`、`mode`、`cwd`）。
- `identity.avatar`: 工作區相對路徑、`http(s)` URL 或 `data:` URI。
- `identity` 來源預設值：`ackReaction` 來自 `emoji`，`mentionPatterns` 來自 `name`/`emoji`。
- `subagents.allowAgents`: 允許清單的代理 ID 用於 `sessions_spawn`（`["*"]` = 任何；預設：僅相同代理）。
- 沙盒繼承保護：如果請求者會話是沙盒化的，`sessions_spawn` 會拒絕那些將在非沙盒環境中執行的目標。

---

## Multi-agent routing

在一個 Gateway 內執行多個獨立的代理。請參閱 [Multi-Agent](/concepts/multi-agent)。

```json5
{
  agents: {
    list: [
      { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },
      { id: "work", workspace: "~/.openclaw/workspace-work" },
    ],
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
  ],
}
```

### 綁定匹配欄位

- `type` (可選): `route` 用於正常路由（缺省類型為 route），`acp` 用於持久的 ACP 對話綁定。
- `match.channel` (必填)
- `match.accountId` (可選; `*` = 任何帳戶; 若省略則為預設帳戶)
- `match.peer` (可選; `{ kind: direct|group|channel, id }`)
- `match.guildId` / `match.teamId` (可選; 特定於通道)
- `acp` (可選; 僅適用於 `type: "acp"`): `{ mode, label, cwd, backend }`

**確定性匹配順序：**

1. `match.peer`
2. `match.guildId`
3. `match.teamId`
4. `match.accountId` (精確，不包含同儕/公會/團隊)
5. `match.accountId: "*"` (頻道範圍)
6. 預設代理人

在每個層級中，第一個符合的 `bindings` 專案獲勝。

對於 `type: "acp"` 條目，OpenClaw 透過精確的對話身份 (`match.channel` + 帳戶 + `match.peer.id`) 來解析，而不使用上述的路由綁定層級順序。

### 每個代理的存取設定檔

<Accordion title="完全訪問（無沙盒）">

```json5
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
      },
    ],
  },
}
```

</Accordion>

<Accordion title="唯讀工具 + 工作區">

```json5
{
  agents: {
    list: [
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: { mode: "all", scope: "agent", workspaceAccess: "ro" },
        tools: {
          allow: [
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "exec", "process", "browser"],
        },
      },
    ],
  },
}
```

</Accordion>

<Accordion title="無檔案系統存取（僅限訊息）">

```json5
{
  agents: {
    list: [
      {
        id: "public",
        workspace: "~/.openclaw/workspace-public",
        sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
        tools: {
          allow: [
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
            "whatsapp",
            "telegram",
            "slack",
            "discord",
            "gateway",
          ],
          deny: [
            "read",
            "write",
            "edit",
            "apply_patch",
            "exec",
            "process",
            "browser",
            "canvas",
            "nodes",
            "cron",
            "gateway",
            "image",
          ],
        },
      },
    ],
  },
}
```

</Accordion>

請參閱 [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) 以獲取優先順序的詳細資訊。

---

## Session

```json5
{
  session: {
    scope: "per-sender",
    dmScope: "main", // main | per-peer | per-channel-peer | per-account-channel-peer
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      mode: "daily", // daily | idle
      atHour: 4,
      idleMinutes: 60,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      direct: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    parentForkMaxTokens: 100000, // skip parent-thread fork above this token count (0 disables)
    maintenance: {
      mode: "warn", // warn | enforce
      pruneAfter: "30d",
      maxEntries: 500,
      rotateBytes: "10mb",
      resetArchiveRetention: "30d", // duration or false
      maxDiskBytes: "500mb", // optional hard budget
      highWaterBytes: "400mb", // optional cleanup target
    },
    threadBindings: {
      enabled: true,
      idleHours: 24, // default inactivity auto-unfocus in hours (`0` disables)
      maxAgeHours: 0, // default hard max age in hours (`0` disables)
    },
    mainKey: "main", // legacy (runtime always uses "main")
    agentToAgent: { maxPingPongTurns: 5 },
    sendPolicy: {
      rules: [{ action: "deny", match: { channel: "discord", chatType: "group" } }],
      default: "allow",
    },
  },
}
```

<Accordion title="會話欄位詳細資訊">

- **`dmScope`**: 如何將 DM 分組。
  - `main`: 所有 DM 共享主要會話。
  - `per-peer`: 根據發送者 ID 在不同通道中隔離。
  - `per-channel-peer`: 根據通道 + 發送者隔離（建議用於多用戶收件箱）。
  - `per-account-channel-peer`: 根據帳戶 + 通道 + 發送者隔離（建議用於多帳戶）。
- **`identityLinks`**: 將標準 ID 映射到提供者前綴的對等體，以便跨通道會話共享。
- **`reset`**: 主要重置策略。 `daily` 在 `atHour` 當地時間重置；`idle` 在 `idleMinutes` 之後重置。當兩者都設定時，先到者優先。
- **`resetByType`**: 每類型的覆蓋 (`direct`, `group`, `thread`)。舊版 `dm` 被接受為 `direct` 的別名。
- **`parentForkMaxTokens`**: 創建分支線程會話時允許的最大父會話 `totalTokens`（預設 `100000`）。
  - 如果父 `totalTokens` 超過此值，OpenClaw 將啟動一個新的線程會話，而不是繼承父轉錄歷史。
  - 設定 `0` 以禁用此保護，並始終允許父級分支。
- **`mainKey`**: 遺留字段。執行時現在始終使用 `"main"` 作為主要直接聊天桶。
- **`sendPolicy`**: 根據 `channel`、`chatType` (`direct|group|channel`，與遺留 `dm` 別名)、`keyPrefix` 或 `rawKeyPrefix` 匹配。第一個拒絕者優先。
- **`maintenance`**: 會話存儲清理 + 保留控制。
  - `mode`: `warn` 僅發出警告；`enforce` 進行清理。
  - `pruneAfter`: 過期條目的年齡截止（預設 `30d`）。
  - `maxEntries`: `sessions.json` 中條目的最大數量（預設 `500`）。
  - `rotateBytes`: 當其超過此大小時輪換 `sessions.json`（預設 `10mb`）。
  - `resetArchiveRetention`: `*.reset.<timestamp>` 轉錄檔案的保留。預設為 `pruneAfter`；設置 `false` 以禁用。
  - `maxDiskBytes`: 可選的會話目錄磁碟預算。在 `warn` 模式下，它記錄警告；在 `enforce` 模式下，它首先刪除最舊的工件/會話。
  - `highWaterBytes`: 預算清理後的可選目標。預設為 `80%` 的 `maxDiskBytes`。
- **`threadBindings`**: 線程綁定會話功能的全局預設值。
  - `enabled`: 主預設開關（提供者可以覆蓋；Discord 使用 `channels.discord.threadBindings.enabled`）
  - `idleHours`: 預設不活動自動失焦的時間（小時）（`0` 禁用；提供者可以覆蓋）
  - `maxAgeHours`: 預設硬性最大年齡（小時）（`0` 禁用；提供者可以覆蓋）

</Accordion>

---

## Messages

```json5
{
  messages: {
    responsePrefix: "🦞", // or "auto"
    ackReaction: "👀",
    ackReactionScope: "group-mentions", // group-mentions | group-all | direct | all
    removeAckAfterReply: false,
    queue: {
      mode: "collect", // steer | followup | collect | steer-backlog | steer+backlog | queue | interrupt
      debounceMs: 1000,
      cap: 20,
      drop: "summarize", // old | new | summarize
      byChannel: {
        whatsapp: "collect",
        telegram: "collect",
      },
    },
    inbound: {
      debounceMs: 2000, // 0 disables
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
      },
    },
  },
}
```

### Response prefix

Per-channel/account overrides: `channels.<channel>.responsePrefix`, `channels.<channel>.accounts.<id>.responsePrefix`.

解析（最具體者勝）：帳戶 → 頻道 → 全域。 `""` 禁用並停止級聯。 `"auto"` 衍生 `[{identity.name}]`。

**範本變數：**

| 變數              | 描述           | 範例                        |
| ----------------- | -------------- | --------------------------- |
| `{model}`         | 短模型名稱     | `claude-opus-4-6`           |
| `{modelFull}`     | 完整模型識別碼 | `anthropic/claude-opus-4-6` |
| `{provider}`      | 提供者名稱     | `anthropic`                 |
| `{thinkingLevel}` | 當前思考層級   | `high`, `low`, `off`        |
| `{identity.name}` | 代理身份名稱   | (與 `"auto"` 相同)          |

變數不區分大小寫。`{think}` 是 `{thinkingLevel}` 的別名。

### Ack 反應

- 預設為活動代理的 `identity.emoji`，否則為 `"👀"`。設定 `""` 以禁用。
- 每個頻道的覆蓋：`channels.<channel>.ackReaction`，`channels.<channel>.accounts.<id>.ackReaction`。
- 解析順序：帳戶 → 頻道 → `messages.ackReaction` → 身份回退。
- 範圍：`group-mentions`（預設）、`group-all`、`direct`、`all`。
- `removeAckAfterReply`：在回覆後移除確認（僅限 Slack/Discord/Telegram/Google Chat）。

### 輸入去彈跳

將來自同一發件人的快速純文字訊息批次處理為單一代理回應。媒體/附件立即清除。控制命令繞過去彈的延遲。

### TTS (文字轉語音)

```json5
{
  messages: {
    tts: {
      auto: "always", // off | always | inbound | tagged
      mode: "final", // final | all
      provider: "elevenlabs",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: { enabled: true },
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
      openai: {
        apiKey: "openai_api_key",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
    },
  },
}
```

- `auto` 控制自動 TTS。 `/tts off|always|inbound|tagged` 在每個會話中覆蓋設定。
- `summaryModel` 覆蓋 `agents.defaults.model.primary` 以進行自動摘要。
- `modelOverrides` 預設為啟用； `modelOverrides.allowProvider` 預設為 `false`（選擇加入）。
- API 金鑰回退至 `ELEVENLABS_API_KEY`/`XI_API_KEY` 和 `OPENAI_API_KEY`。
- `openai.baseUrl` 覆蓋 OpenAI TTS 端點。解析順序為設定，然後是 `OPENAI_TTS_BASE_URL`，再然後是 `https://api.openai.com/v1`。
- 當 `openai.baseUrl` 指向非 OpenAI 端點時，OpenClaw 將其視為 OpenAI 兼容的 TTS 伺服器，並放寬模型/聲音驗證。

---

## Talk

[[BLOCK_1]]  
Talk 模式的預設值（macOS/iOS/Android）。  
[[BLOCK_1]]

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    voiceAliases: {
      Clawd: "EXAVITQu4vr4xnSDxMaL",
      Roger: "CwhRBWXzGAHq8TQ4Fs17",
    },
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    silenceTimeoutMs: 1500,
    interruptOnSpeech: true,
  },
}
```

- 語音 ID 會回退到 `ELEVENLABS_VOICE_ID` 或 `SAG_VOICE_ID`。
- `apiKey` 和 `providers.*.apiKey` 接受純文字字串或 SecretRef 物件。
- `ELEVENLABS_API_KEY` 的回退僅在未設定 Talk API 金鑰時適用。
- `voiceAliases` 允許 Talk 指令使用友好的名稱。
- `silenceTimeoutMs` 控制 Talk 模式在用戶靜默後等待多長時間才發送文字稿。未設定時將保持平台的預設暫停時間 (`700 ms on macOS and Android, 900 ms on iOS`)。

---

## Tools

### Tool profiles

`tools.profile` 設定了一個基本的允許清單，然後是 `tools.allow`/`tools.deny`：

當未設置時，本地入職將新的本地設定預設為 `tools.profile: "coding"`（現有的明確設定檔將被保留）。

| Profile     | Includes                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------- |
| `minimal`   | `session_status` 只有                                                                     |
| `coding`    | `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`                    |
| `messaging` | `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status` |
| `full`      | 無限制（與未設置相同）                                                                    |

### 工具群組

| 群組               | 工具                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `group:runtime`    | `exec`, `process` (`bash` 被接受為 `exec` 的別名)                                        |
| `group:fs`         | `read`, `write`, `edit`, `apply_patch`                                                   |
| `group:sessions`   | `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status` |
| `group:memory`     | `memory_search`, `memory_get`                                                            |
| `group:web`        | `web_search`, `web_fetch`                                                                |
| `group:ui`         | `browser`, `canvas`                                                                      |
| `group:automation` | `cron`, `gateway`                                                                        |
| `group:messaging`  | `message`                                                                                |
| `group:nodes`      | `nodes`                                                                                  |
| `group:openclaw`   | 所有內建工具（不包括提供者插件）                                                         |

### `tools.allow` / `tools.deny`

全域工具允許/拒絕政策（拒絕優先）。不區分大小寫，支援 `*` 通配符。即使在 Docker 沙盒關閉時也會應用。

```json5
{
  tools: { deny: ["browser", "canvas"] },
}
```

### `tools.byProvider`

進一步限制特定供應商或模型的工具。順序：基本設定檔 → 供應商設定檔 → 允許/拒絕。

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

### `tools.elevated`

控制提升的 (主機) 執行存取權限：

```json5
{
  tools: {
    elevated: {
      enabled: true,
      allowFrom: {
        whatsapp: ["+15555550123"],
        discord: ["1234567890123", "987654321098765432"],
      },
    },
  },
}
```

- 每個代理的覆蓋 (`agents.list[].tools.elevated`) 只能進一步限制。
- `/elevated on|off|ask|full` 每個會話儲存狀態；內聯指令適用於單一訊息。
- 提升的 `exec` 在主機上執行，繞過沙盒限制。

### `tools.exec`

```json5
{
  tools: {
    exec: {
      backgroundMs: 10000,
      timeoutSec: 1800,
      cleanupMs: 1800000,
      notifyOnExit: true,
      notifyOnExitEmptySuccess: false,
      applyPatch: {
        enabled: false,
        allowModels: ["gpt-5.2"],
      },
    },
  },
}
```

### `tools.loopDetection`

工具循環安全檢查預設為**禁用**。設置 `enabled: true` 以啟用檢測。設定可以在 `tools.loopDetection` 中全局定義，並在 `agents.list[].tools.loopDetection` 中針對每個代理進行覆蓋。

```json5
{
  tools: {
    loopDetection: {
      enabled: true,
      historySize: 30,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    },
  },
}
```

- `historySize`: 最大工具調用歷史保留用於迴圈分析。
- `warningThreshold`: 重複無進展模式的閾值以發出警告。
- `criticalThreshold`: 阻止關鍵迴圈的較高重複閾值。
- `globalCircuitBreakerThreshold`: 任何無進展執行的硬停止閾值。
- `detectors.genericRepeat`: 對重複相同工具/相同參數的調用發出警告。
- `detectors.knownPollNoProgress`: 對已知的輪詢工具 (`process.poll`, `command_status`, 等等) 發出警告/阻止。
- `detectors.pingPong`: 對交替無進展對模式發出警告/阻止。
- 如果 `warningThreshold >= criticalThreshold` 或 `criticalThreshold >= globalCircuitBreakerThreshold`，驗證失敗。

### `tools.web`

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "brave_api_key", // or BRAVE_API_KEY env
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        userAgent: "custom-ua",
      },
    },
  },
}
```

### `tools.media`

設定入站媒體理解（圖像/音頻/影片）：

```json5
{
  tools: {
    media: {
      concurrency: 2,
      audio: {
        enabled: true,
        maxBytes: 20971520,
        scope: {
          default: "deny",
          rules: [{ action: "allow", match: { chatType: "direct" } }],
        },
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          { type: "cli", command: "whisper", args: ["--model", "base", "{{MediaPath}}"] },
        ],
      },
      video: {
        enabled: true,
        maxBytes: 52428800,
        models: [{ provider: "google", model: "gemini-3-flash-preview" }],
      },
    },
  },
}
```

<Accordion title="媒體模型條目欄位">

**提供者條目** (`type: "provider"` 或省略):

- `provider`: API 提供者 ID (`openai`, `anthropic`, `google`/`gemini`, `groq`，等等)
- `model`: 模型 ID 覆寫
- `profile` / `preferredProfile`: `auth-profiles.json` 設定檔選擇

**CLI 入口** (`type: "cli"`):

- `command`: 可執行檔以執行
- `args`: 模板參數（支援 `{{MediaPath}}`、`{{Prompt}}`、`{{MaxChars}}` 等等）

**常見欄位：**

- `capabilities`: 可選列表 (`image`, `audio`, `video`). 預設值: `openai`/`anthropic`/`minimax` → 圖片, `google` → 圖片+音訊+影片, `groq` → 音訊。
- `prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`: 每個條目的覆蓋設定。
- 失敗時將回退到下一個條目。

Provider auth 遵循標準順序：`auth-profiles.json` → 環境變數 → `models.providers.*.apiKey`。

</Accordion>

### `tools.agentToAgent`

```json5
{
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },
}
```

### `tools.sessions`

控制哪些會話可以被會話工具 (`sessions_list`, `sessions_history`, `sessions_send`) 目標。

預設：`tree`（當前會話 + 由其產生的會話，例如子代理）。

```json5
{
  tools: {
    sessions: {
      // "self" | "tree" | "agent" | "all"
      visibility: "tree",
    },
  },
}
```

[[BLOCK_1]]

- `self`: 只有當前的會話金鑰。
- `tree`: 當前會話 + 由當前會話產生的會話（子代理）。
- `agent`: 任何屬於當前代理 ID 的會話（如果您在相同的代理 ID 下執行每個發送者會話，則可以包括其他用戶）。
- `all`: 任何會話。跨代理目標仍然需要 `tools.agentToAgent`。
- 沙盒限制：當前會話被沙盒化且 `agents.defaults.sandbox.sessionToolsVisibility="spawned"` 時，即使 `tools.sessions.visibility="all"`，可見性也會強制設置為 `tree`。

### `tools.sessions_spawn`

控制 `sessions_spawn` 的內嵌附件支援。

```json5
{
  tools: {
    sessions_spawn: {
      attachments: {
        enabled: false, // opt-in: set true to allow inline file attachments
        maxTotalBytes: 5242880, // 5 MB total across all files
        maxFiles: 50,
        maxFileBytes: 1048576, // 1 MB per file
        retainOnSessionKeep: false, // keep attachments when cleanup="keep"
      },
    },
  },
}
```

Notes:

- 附件僅支援 `runtime: "subagent"`。ACP 執行時會拒絕它們。
- 檔案在 `.openclaw/attachments/<uuid>/` 的子工作區中具現化，並帶有 `.manifest.json`。
- 附件內容會自動從記錄持久性中刪除。
- Base64 輸入會經過嚴格的字母/填充檢查以及預解碼大小保護。
- 檔案權限對於目錄是 `0700`，對於檔案是 `0600`。
- 清理遵循 `cleanup` 政策：`delete` 會始終移除附件；`keep` 只有在 `retainOnSessionKeep: true` 時才會保留它們。

### `tools.subagents`

```json5
{
  agents: {
    defaults: {
      subagents: {
        model: "minimax/MiniMax-M2.5",
        maxConcurrent: 1,
        runTimeoutSeconds: 900,
        archiveAfterMinutes: 60,
      },
    },
  },
}
```

- `model`: 產生的子代理的預設模型。如果省略，子代理將繼承呼叫者的模型。
- `runTimeoutSeconds`: 當工具呼叫省略 `runTimeoutSeconds` 時，`sessions_spawn` 的預設超時（秒）。`0` 表示沒有超時。
- 每個子代理的工具政策: `tools.subagents.tools.allow` / `tools.subagents.tools.deny`。

---

## 自訂提供者和基本 URL

OpenClaw 使用 pi-coding-agent 模型目錄。透過 `models.providers` 在設定中或 `~/.openclaw/agents/<agentId>/agent/models.json` 添加自訂提供者。

```json5
{
  models: {
    mode: "merge", // merge (default) | replace
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions", // openai-completions | openai-responses | anthropic-messages | google-generative-ai
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
}
```

- 使用 `authHeader: true` + `headers` 來滿足自訂的身份驗證需求。
- 使用 `OPENCLAW_AGENT_DIR` (或 `PI_CODING_AGENT_DIR`) 來覆蓋代理設定根目錄。
- 匹配提供者 ID 的合併優先順序：
  - 非空的代理 `models.json` `baseUrl` 值優先。
  - 非空的代理 `apiKey` 值僅在該提供者在當前設定/身份驗證檔案上下文中不是由 SecretRef 管理時才優先。
  - 由 SecretRef 管理的提供者 `apiKey` 值是從來源標記中刷新 (`ENV_VAR_NAME` 用於環境引用，`secretref-managed` 用於檔案/執行引用)，而不是持久化已解析的秘密。
  - 由 SecretRef 管理的提供者標頭值是從來源標記中刷新 (`secretref-env:ENV_VAR_NAME` 用於環境引用，`secretref-managed` 用於檔案/執行引用)。
  - 空的或缺失的代理 `apiKey`/`baseUrl` 會回退到設定中的 `models.providers`。
  - 匹配的模型 `contextWindow`/`maxTokens` 使用顯式設定和隱式目錄值之間的較高值。
  - 當你希望設定完全重寫 `models.json` 時，使用 `models.mode: "replace"`。
  - 標記持久性是來源權威的：標記是從活動來源設定快照（解析前）寫入，而不是從已解析的執行時秘密值寫入。

### Provider field details

- `models.mode`: 提供者目錄行為 (`merge` 或 `replace`)。
- `models.providers`: 以提供者 ID 為鍵的自訂提供者映射。
- `models.providers.*.api`: 請求適配器 (`openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`, 等等)。
- `models.providers.*.apiKey`: 提供者憑證（建議使用 SecretRef/env 替代）。
- `models.providers.*.auth`: 認證策略 (`api-key`, `token`, `oauth`, `aws-sdk`)。
- `models.providers.*.injectNumCtxForOpenAICompat`: 對於 Ollama + `openai-completions`，將 `options.num_ctx` 注入請求中（預設值: `true`）。
- `models.providers.*.authHeader`: 在需要時強制在 `Authorization` 標頭中傳輸憑證。
- `models.providers.*.baseUrl`: 上游 API 基本 URL。
- `models.providers.*.headers`: 用於代理/租戶路由的額外靜態標頭。
- `models.providers.*.models`: 明確的提供者模型目錄條目。
- `models.providers.*.models.*.compat.supportsDeveloperRole`: 可選的相容性提示。對於 `api: "openai-completions"` 具有非空非原生 `baseUrl`（主機不是 `api.openai.com`），OpenClaw 在執行時強制將其設置為 `false`。空的/省略的 `baseUrl` 保持預設的 OpenAI 行為。
- `models.bedrockDiscovery`: Bedrock 自動發現設置根目錄。
- `models.bedrockDiscovery.enabled`: 開啟/關閉發現輪詢。
- `models.bedrockDiscovery.region`: 用於發現的 AWS 區域。
- `models.bedrockDiscovery.providerFilter`: 用於目標發現的可選提供者 ID 過濾器。
- `models.bedrockDiscovery.refreshInterval`: 發現刷新輪詢間隔。
- `models.bedrockDiscovery.defaultContextWindow`: 發現模型的回退上下文窗口。
- `models.bedrockDiscovery.defaultMaxTokens`: 發現模型的回退最大輸出token數。

### Provider examples

<Accordion title="Cerebras (GLM 4.6 / 4.7)">

```json5
{
  env: { CEREBRAS_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: {
        primary: "cerebras/zai-glm-4.7",
        fallbacks: ["cerebras/zai-glm-4.6"],
      },
      models: {
        "cerebras/zai-glm-4.7": { alias: "GLM 4.7 (Cerebras)" },
        "cerebras/zai-glm-4.6": { alias: "GLM 4.6 (Cerebras)" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      cerebras: {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "zai-glm-4.7", name: "GLM 4.7 (Cerebras)" },
          { id: "zai-glm-4.6", name: "GLM 4.6 (Cerebras)" },
        ],
      },
    },
  },
}
```

使用 `cerebras/zai-glm-4.7` 代表 Cerebras；使用 `zai/glm-4.7` 代表 Z.AI 直接。

</Accordion>

<Accordion title="OpenCode">

```json5
{
  agents: {
    defaults: {
      model: { primary: "opencode/claude-opus-4-6" },
      models: { "opencode/claude-opus-4-6": { alias: "Opus" } },
    },
  },
}
```

設定 `OPENCODE_API_KEY` (或 `OPENCODE_ZEN_API_KEY`). 使用 `opencode/...` 參考來查詢 Zen 目錄或 `opencode-go/...` 參考來查詢 Go 目錄。快速鍵: `openclaw onboard --auth-choice opencode-zen` 或 `openclaw onboard --auth-choice opencode-go`。

</Accordion>

<Accordion title="Z.AI (GLM-4.7)">

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
}
```

設定 `ZAI_API_KEY`。`z.ai/*` 和 `z-ai/*` 是接受的別名。快捷方式：`openclaw onboard --auth-choice zai-api-key`。

- 一般端點: `https://api.z.ai/api/paas/v4`
- 編碼端點（預設）: `https://api.z.ai/api/coding/paas/v4`
- 對於一般端點，定義一個自訂提供者並覆寫基本 URL。

</Accordion>

<Accordion title="Moonshot AI (Kimi)">

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
      models: { "moonshot/kimi-k2.5": { alias: "Kimi K2.5" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

`baseUrl: "https://api.moonshot.cn/v1"` 或 `openclaw onboard --auth-choice moonshot-api-key-cn`。

</Accordion>

<Accordion title="Kimi Coding">

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/k2p5" },
      models: { "kimi-coding/k2p5": { alias: "Kimi K2.5" } },
    },
  },
}
```

Anthropic 兼容的內建提供者。快捷方式: `openclaw onboard --auth-choice kimi-code-api-key`。

</Accordion>

<Accordion title="合成（與人類相容）">

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.5" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.5": { alias: "MiniMax M2.5" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.5",
            name: "MiniMax M2.5",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

基本 URL 應省略 `/v1`（Anthropic 用戶端會自動附加）。快捷方式：`openclaw onboard --auth-choice synthetic-api-key`。

</Accordion>

<Accordion title="MiniMax M2.5 (direct)">

```json5
{
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2.5" },
      models: {
        "minimax/MiniMax-M2.5": { alias: "Minimax" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.5",
            name: "MiniMax M2.5",
            reasoning: true,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Set `MINIMAX_API_KEY`。快捷鍵：`openclaw onboard --auth-choice minimax-api`。

</Accordion>

<Accordion title="本地模型 (LM Studio)">

請參閱 [Local Models](/gateway/local-models)。簡而言之：在高效能硬體上透過 LM Studio Responses API 執行 MiniMax M2.5；保持合併的託管模型以作為備援。

</Accordion>

---

## Skills

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills"],
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn
    },
    entries: {
      "nano-banana-pro": {
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" }, // or plaintext string
        env: { GEMINI_API_KEY: "GEMINI_KEY_HERE" },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

- `allowBundled`: 僅限於捆綁技能的可選允許清單（管理/工作區技能不受影響）。
- `entries.<skillKey>.enabled: false` 即使是捆綁/安裝的技能也會被禁用。
- `entries.<skillKey>.apiKey`: 方便技能聲明主要環境變數（明文字串或 SecretRef 物件）。

---

## Plugins

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: [],
    load: {
      paths: ["~/Projects/oss/voice-call-extension"],
    },
    entries: {
      "voice-call": {
        enabled: true,
        hooks: {
          allowPromptInjection: false,
        },
        config: { provider: "twilio" },
      },
    },
  },
}
```

- 從 `~/.openclaw/extensions`、`<workspace>/.openclaw/extensions` 載入，還有 `plugins.load.paths`。
- **設定變更需要重新啟動網關。**
- `allow`：可選的允許清單（僅載入列出的插件）。`deny` 具有優先權。
- `plugins.entries.<id>.apiKey`：插件級 API 金鑰便利欄位（當插件支援時）。
- `plugins.entries.<id>.env`：插件範圍的環境變數映射。
- `plugins.entries.<id>.hooks.allowPromptInjection`：當 `false` 時，核心區塊 `before_prompt_build` 並忽略來自舊版 `before_agent_start` 的提示變更欄位，同時保留舊版 `modelOverride` 和 `providerOverride`。
- `plugins.entries.<id>.config`：插件定義的設定物件（由插件架構驗證）。
- `plugins.slots.memory`：選擇活動記憶體插件 ID，或 `"none"` 以禁用記憶體插件。
- `plugins.slots.contextEngine`：選擇活動上下文引擎插件 ID；預設為 `"legacy"`，除非您安裝並選擇其他引擎。
- `plugins.installs`：由 `openclaw plugins update` 使用的 CLI 管理安裝元數據。
  - 包含 `source`、`spec`、`sourcePath`、`installPath`、`version`、`resolvedName`、`resolvedVersion`、`resolvedSpec`、`integrity`、`shasum`、`resolvedAt`、`installedAt`。
  - 將 `plugins.installs.*` 視為管理狀態；優先使用 CLI 命令而非手動編輯。

請參閱 [Plugins](/tools/plugin)。

---

## Browser

```json5
{
  browser: {
    enabled: true,
    evaluateEnabled: true,
    defaultProfile: "chrome",
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: true, // default trusted-network mode
      // allowPrivateNetwork: true, // legacy alias
      // hostnameAllowlist: ["*.example.com", "example.com"],
      // allowedHostnames: ["localhost"],
    },
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
    color: "#FF4500",
    // headless: false,
    // noSandbox: false,
    // extraArgs: [],
    // relayBindHost: "0.0.0.0", // only when the extension relay must be reachable across namespaces (for example WSL2)
    // executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    // attachOnly: false,
  },
}
```

- `evaluateEnabled: false` 禁用 `act:evaluate` 和 `wait --fn`。
- `ssrfPolicy.dangerouslyAllowPrivateNetwork` 在未設置時預設為 `true`（受信網路模型）。
- 設定 `ssrfPolicy.dangerouslyAllowPrivateNetwork: false` 以實現嚴格的公共瀏覽器導航。
- `ssrfPolicy.allowPrivateNetwork` 作為舊版別名仍然受到支援。
- 在嚴格模式下，使用 `ssrfPolicy.hostnameAllowlist` 和 `ssrfPolicy.allowedHostnames` 來明確例外情況。
- 遠端設定檔僅限附加（啟動/停止/重置被禁用）。
- 自動檢測順序：如果是基於 Chromium 的預設瀏覽器 → Chrome → Brave → Edge → Chromium → Chrome Canary。
- 控制服務：僅限回環（端口來源於 `gateway.port`，預設為 `18791`）。
- `extraArgs` 將額外啟動標誌附加到本地 Chromium 啟動（例如 `--disable-gpu`、視窗大小或除錯標誌）。
- `relayBindHost` 更改 Chrome 擴充中繼的監聽位置。若要僅限回環訪問，請保持未設置；僅在中繼必須跨越命名空間邊界（例如 WSL2）且主機網路已被信任時，設置明確的非回環綁定地址，例如 `0.0.0.0`。

---

## UI

```json5
{
  ui: {
    seamColor: "#FF4500",
    assistant: {
      name: "OpenClaw",
      avatar: "CB", // emoji, short text, image URL, or data URI
    },
  },
}
```

- `seamColor`: 原生應用程式 UI 鉻的重點顏色（對話模式氣泡色調等）。
- `assistant`: 控制 UI 身份覆蓋。回退至當前代理身份。

---

## Gateway

```json5
{
  gateway: {
    mode: "local", // local | remote
    port: 18789,
    bind: "loopback",
    auth: {
      mode: "token", // none | token | password | trusted-proxy
      token: "your-token",
      // password: "your-password", // or OPENCLAW_GATEWAY_PASSWORD
      // trustedProxy: { userHeader: "x-forwarded-user" }, // for mode=trusted-proxy; see /gateway/trusted-proxy-auth
      allowTailscale: true,
      rateLimit: {
        maxAttempts: 10,
        windowMs: 60000,
        lockoutMs: 300000,
        exemptLoopback: true,
      },
    },
    tailscale: {
      mode: "off", // off | serve | funnel
      resetOnExit: false,
    },
    controlUi: {
      enabled: true,
      basePath: "/openclaw",
      // root: "dist/control-ui",
      // allowedOrigins: ["https://control.example.com"], // required for non-loopback Control UI
      // dangerouslyAllowHostHeaderOriginFallback: false, // dangerous Host-header origin fallback mode
      // allowInsecureAuth: false,
      // dangerouslyDisableDeviceAuth: false,
    },
    remote: {
      url: "ws://gateway.tailnet:18789",
      transport: "ssh", // ssh | direct
      token: "your-token",
      // password: "your-password",
    },
    trustedProxies: ["10.0.0.1"],
    // Optional. Default false.
    allowRealIpFallback: false,
    tools: {
      // Additional /tools/invoke HTTP denies
      deny: ["browser"],
      // Remove tools from the default HTTP deny list
      allow: ["gateway"],
    },
    push: {
      apns: {
        relay: {
          baseUrl: "https://relay.example.com",
          timeoutMs: 10000,
        },
      },
    },
  },
}
```

<Accordion title="閘道欄位詳細資訊">

- `mode`: `local`（執行閘道）或 `remote`（連接到遠端閘道）。閘道拒絕啟動，除非 `local`。
- `port`: 單一多路復用端口用於 WS + HTTP。優先順序：`--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > `18789`。
- `bind`: `auto`、`loopback`（預設）、`lan` (`0.0.0.0`)、`tailnet`（僅限 Tailscale IP）或 `custom`。
- **舊版綁定別名**：在 `gateway.bind` 中使用綁定模式值 (`auto`、`loopback`、`lan`、`tailnet`、`custom`)，而不是主機別名 (`0.0.0.0`、`127.0.0.1`、`localhost`、`::`、`::1`)。
- **Docker 注意事項**：預設 `loopback` 綁定在容器內部監聽 `127.0.0.1`。使用 Docker 橋接網路 (`-p 18789:18789`)，流量會到達 `eth0`，因此閘道無法訪問。使用 `--network host`，或設置 `bind: "lan"`（或 `bind: "custom"` 與 `customBindHost: "0.0.0.0"`）以在所有介面上監聽。
- **身份驗證**：預設需要。非迴圈綁定需要共享的 token/密碼。入門精靈預設生成一個 token。
- 如果同時設定了 `gateway.auth.token` 和 `gateway.auth.password`（包括 SecretRefs），請明確將 `gateway.auth.mode` 設置為 `token` 或 `password`。當兩者都設定且模式未設置時，啟動和服務安裝/修復流程會失敗。
- `gateway.auth.mode: "none"`: 明確的無身份驗證模式。僅用於受信任的本地迴圈設置；這在入門提示中故意不提供。
- `gateway.auth.mode: "trusted-proxy"`: 將身份驗證委派給身份感知的反向代理，並信任來自 `gateway.trustedProxies` 的身份標頭（請參見 [受信任的代理身份驗證](/gateway/trusted-proxy-auth)）。
- `gateway.auth.allowTailscale`: 當 `true` 時，Tailscale Serve 身份標頭可以滿足控制 UI/WebSocket 身份驗證（通過 `tailscale whois` 驗證）；HTTP API 端點仍然需要 token/密碼身份驗證。這種無 token 流程假設閘道主機是受信任的。當 `tailscale.mode = "serve"` 時，預設為 `true`。
- `gateway.auth.rateLimit`: 可選的失敗身份驗證限制器。按用戶端 IP 和身份驗證範圍應用（共享密鑰和設備 token 獨立跟蹤）。被阻止的嘗試返回 `429` + `Retry-After`。
  - `gateway.auth.rateLimit.exemptLoopback` 預設為 `true`；當您故意希望本地主機流量也受到速率限制時，請設置 `false`（用於測試設置或嚴格的代理部署）。
- 瀏覽器來源的 WS 身份驗證嘗試在禁用迴圈豁免的情況下始終受到限制（對瀏覽器基於本地主機的暴力破解的深度防禦）。
- `tailscale.mode`: `serve`（僅限 tailnet，迴圈綁定）或 `funnel`（公開，需要身份驗證）。
- `controlUi.allowedOrigins`: 明確的瀏覽器來源允許清單，用於閘道 WebSocket 連接。當預期來自非迴圈來源的瀏覽器用戶端時，這是必需的。
- `controlUi.dangerouslyAllowHostHeaderOriginFallback`: 危險模式，啟用主機標頭來源回退，適用於故意依賴主機標頭來源政策的部署。
- `remote.transport`: `ssh`（預設）或 `direct`（ws/wss）。對於 `direct`，`remote.url` 必須是 `ws://` 或 `wss://`。
- `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1`: 用戶端側的緊急覆蓋，允許明文 `ws://` 連接到受信任的私有網路 IP；預設仍然僅限於迴圈。
- `gateway.remote.token` / `.password` 是遠端用戶端憑證欄位。它們本身不設定閘道身份驗證。
- `gateway.push.apns.relay.baseUrl`: 用於官方/TestFlight iOS 構建的外部 APNs 中繼的基本 HTTPS URL，當它們將中繼支援的註冊發佈到閘道後。此 URL 必須與編譯到 iOS 構建中的中繼 URL 匹配。
- `gateway.push.apns.relay.timeoutMs`: 閘道到中繼的發送超時（以毫秒為單位）。預設為 `10000`。
- 中繼支援的註冊被委派給特定的閘道身份。配對的 iOS 應用程序獲取 `gateway.identity.get`，將該身份包含在中繼註冊中，並將註冊範圍的發送授權轉發給閘道。另一個閘道無法重用該存儲的註冊。
- `OPENCLAW_APNS_RELAY_BASE_URL` / `OPENCLAW_APNS_RELAY_TIMEOUT_MS`: 用於上述中繼設定的臨時環境覆蓋。
- `OPENCLAW_APNS_RELAY_ALLOW_HTTP=true`: 僅限開發的逃生口，用於迴圈 HTTP 中繼 URL。生產中繼 URL 應保持在 HTTPS 上。
- 本地閘道調用路徑僅在 `gateway.auth.*` 未設置時可以使用 `gateway.remote.*` 作為回退。
- 如果 `gateway.auth.token` / `gateway.auth.password` 通過 SecretRef 明確設定且未解析，則解析將失敗並關閉（無遠端回退掩碼）。
- `trustedProxies`: 終止 TLS 的反向代理 IP。僅列出您控制的代理。
- `allowRealIpFallback`: 當 `true` 時，閘道接受 `X-Real-IP` 如果 `X-Forwarded-For` 缺失。預設 `false` 用於失敗關閉行為。
- `gateway.tools.deny`: 對 HTTP `POST /tools/invoke` 阻止的額外工具名稱（擴充預設拒絕清單）。
- `gateway.tools.allow`: 從預設 HTTP 拒絕清單中移除工具名稱。

</Accordion>

### OpenAI相容的端點

- 聊天完成：預設為禁用。可使用 `gateway.http.endpoints.chatCompletions.enabled: true` 啟用。
- 回應 API：`gateway.http.endpoints.responses.enabled`。
- 回應 URL 輸入強化：
  - `gateway.http.endpoints.responses.maxUrlParts`
  - `gateway.http.endpoints.responses.files.urlAllowlist`
  - `gateway.http.endpoints.responses.images.urlAllowlist`
- 可選的回應強化標頭：
  - `gateway.http.securityHeaders.strictTransportSecurity`（僅對您控制的 HTTPS 來源設置；請參見 [受信任的代理認證](/gateway/trusted-proxy-auth#tls-termination-and-hsts)）

### 多實例隔離

在一個主機上執行多個網關，並使用獨特的端口和狀態目錄：

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
openclaw gateway --port 19001
```

便利標誌：`--dev`（使用 `~/.openclaw-dev` + 埠 `19001`）、`--profile <name>`（使用 `~/.openclaw-<name>`）。

請參閱 [Multiple Gateways](/gateway/multiple-gateways)。

---

## Hooks

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    maxBodyBytes: 262144,
    defaultSessionKey: "hook:ingress",
    allowRequestSessionKey: false,
    allowedSessionKeyPrefixes: ["hook:"],
    allowedAgentIds: ["hooks", "main"],
    presets: ["gmail"],
    transformsDir: "~/.openclaw/hooks/transforms",
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        agentId: "hooks",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "From: {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}",
        deliver: true,
        channel: "last",
        model: "openai/gpt-5.2-mini",
      },
    ],
  },
}
```

Auth: `Authorization: Bearer <token>` 或 `x-openclaw-token: <token>`。

**端點：**

- `POST /hooks/wake` → `{ text, mode?: "now"|"next-heartbeat" }`
- `POST /hooks/agent` → `{ message, name?, agentId?, sessionKey?, wakeMode?, deliver?, channel?, to?, model?, thinking?, timeoutSeconds? }`
  - `sessionKey` 來自請求有效載荷僅在 `hooks.allowRequestSessionKey=true` 時被接受（預設值：`false`）。
- `POST /hooks/<name>` → 透過 `hooks.mappings` 解決

<Accordion title="映射細節">

- `match.path` 匹配 `/hooks` 之後的子路徑 (例如 `/hooks/gmail` → `gmail`)。
- `match.source` 匹配一般路徑的有效載荷欄位。
- 像 `{{messages[0].subject}}` 這樣的模板從有效載荷中讀取。
- `transform` 可以指向返回掛鉤動作的 JS/TS 模組。
  - `transform.module` 必須是相對路徑，並且必須在 `hooks.transformsDir` 內 (絕對路徑和遍歷會被拒絕)。
- `agentId` 路由到特定代理；未知的 ID 會回退到預設值。
- `allowedAgentIds`: 限制明確路由 (`*` 或省略 = 允許所有，`[]` = 拒絕所有)。
- `defaultSessionKey`: 可選的固定會話金鑰，用於沒有明確 `sessionKey` 的掛鉤代理執行。
- `allowRequestSessionKey`: 允許 `/hooks/agent` 呼叫者設置 `sessionKey` (預設: `false`)。
- `allowedSessionKeyPrefixes`: 可選的前綴允許清單，用於明確的 `sessionKey` 值 (請求 + 對應)，例如 `["hook:"]`。
- `deliver: true` 將最終回覆發送到一個通道；`channel` 預設為 `last`。
- `model` 覆蓋此掛鉤執行的 LLM (如果設置了模型目錄，必須被允許)。

</Accordion>

### Gmail 整合

```json5
{
  hooks: {
    gmail: {
      account: "openclaw@gmail.com",
      topic: "projects/<project-id>/topics/gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      pushToken: "shared-push-token",
      hookUrl: "http://127.0.0.1:18789/hooks/gmail",
      includeBody: true,
      maxBytes: 20000,
      renewEveryMinutes: 720,
      serve: { bind: "127.0.0.1", port: 8788, path: "/" },
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

- 當設定後，Gateway 會在啟動時自動啟動 `gog gmail watch serve`。設置 `OPENCLAW_SKIP_GMAIL_WATCHER=1` 以禁用此功能。
- 不要在 Gateway 旁邊執行單獨的 `gog gmail watch serve`。

---

## Canvas host

```json5
{
  canvasHost: {
    root: "~/.openclaw/workspace/canvas",
    liveReload: true,
    // enabled: false, // or OPENCLAW_SKIP_CANVAS_HOST=1
  },
}
```

- 提供可由代理編輯的 HTML/CSS/JS 和 A2UI，透過 HTTP 在 Gateway 端口下執行：
  - `http://<gateway-host>:<gateway.port>/__openclaw__/canvas/`
  - `http://<gateway-host>:<gateway.port>/__openclaw__/a2ui/`
- 僅限本地使用：保持 `gateway.bind: "loopback"`（預設）。
- 非迴圈綁定：畫布路由需要 Gateway 認證（token/password/trusted-proxy），與其他 Gateway HTTP 介面相同。
- Node WebViews 通常不會發送認證標頭；在節點配對並連接後，Gateway 會廣告節點範圍的能力 URL 以便於畫布/A2UI 存取。
- 能力 URL 綁定到活動的節點 WS 會話並迅速過期。IP 基礎的回退不會被使用。
- 將即時重載用戶端注入到提供的 HTML 中。
- 當為空時，自動創建啟動器 `index.html`。
- 也在 `/__openclaw__/a2ui/` 提供 A2UI。
- 變更需要重新啟動 Gateway。
- 對於大型目錄或 `EMFILE` 錯誤，禁用即時重載。

---

## Discovery

### mDNS (Bonjour)

```json5
{
  discovery: {
    mdns: {
      mode: "minimal", // minimal | full | off
    },
  },
}
```

- `minimal` (預設): 從 TXT 記錄中省略 `cliPath` + `sshPort`。
- `full`: 包含 `cliPath` + `sshPort`。
- 主機名稱預設為 `openclaw`。可用 `OPENCLAW_MDNS_HOSTNAME` 進行覆蓋。

### 廣域網域 (DNS-SD)

```json5
{
  discovery: {
    wideArea: { enabled: true },
  },
}
```

在 `~/.openclaw/dns/` 下撰寫一個單播 DNS-SD 區域。為了實現跨網路發現，建議搭配 DNS 伺服器（推薦使用 CoreDNS）和 Tailscale 分割 DNS。

Setup: `openclaw dns setup --apply`.

---

## Environment

### `env` (內嵌環境變數)

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

- 內聯環境變數僅在過程環境缺少該鍵時應用。
- `.env` 檔案：當前工作目錄 `.env` + `~/.openclaw/.env`（不會覆蓋現有變數）。
- `shellEnv`：從您的登入殼程式設定檔導入缺少的預期鍵。
- 詳情請參見 [Environment](/help/environment) 以了解完整的優先順序。

### 環境變數替換

在任何設定字串中引用環境變數，使用 `${VAR_NAME}`：

```json5
{
  gateway: {
    auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" },
  },
}
```

- 只有大寫名稱匹配: `[A-Z_][A-Z0-9_]*`。
- 缺少/空的變數在設定加載時會拋出錯誤。
- 使用 `$${VAR}` 來轉義字面量 `${VAR}`。
- 與 `$include` 一起使用。

---

## Secrets

Secret refs 是累加的：明文值仍然可以使用。

### `SecretRef`

使用一個物件形狀：

```json5
{ source: "env" | "file" | "exec", provider: "default", id: "..." }
```

Validation:

- `provider` 樣式: `^[a-z][a-z0-9_-]{0,63}$`
- `source: "env"` ID 樣式: `^[A-Z][A-Z0-9_]{0,127}$`
- `source: "file"` ID: 絕對 JSON 指標 (例如 `"/providers/openai/apiKey"`)
- `source: "exec"` ID 樣式: `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`
- `source: "exec"` ID 不能包含 `.` 或 `..` 斜線分隔的路徑段 (例如 `a/../b` 被拒絕)

### 支援的憑證介面

- Canonical matrix: [SecretRef Credential Surface](/reference/secretref-credential-surface)
- `secrets apply` 支援的 `openclaw.json` 憑證路徑。
- `auth-profiles.json` 參考在執行時解析和審計範圍中包含。

### Secret providers config

```json5
{
  secrets: {
    providers: {
      default: { source: "env" }, // optional explicit env provider
      filemain: {
        source: "file",
        path: "~/.openclaw/secrets.json",
        mode: "json",
        timeoutMs: 5000,
      },
      vault: {
        source: "exec",
        command: "/usr/local/bin/openclaw-vault-resolver",
        passEnv: ["PATH", "VAULT_ADDR"],
      },
    },
    defaults: {
      env: "default",
      file: "filemain",
      exec: "vault",
    },
  },
}
```

[[BLOCK_1]]

- `file` 提供者支援 `mode: "json"` 和 `mode: "singleValue"` (`id` 必須在 singleValue 模式下為 `"value"`)。
- `exec` 提供者需要一個絕對的 `command` 路徑，並在 stdin/stdout 上使用協議有效載荷。
- 預設情況下，符號連結命令路徑會被拒絕。設置 `allowSymlinkCommand: true` 以允許在驗證解析的目標路徑時使用符號連結路徑。
- 如果 `trustedDirs` 被設定，則受信目錄檢查適用於解析的目標路徑。
- `exec` 子環境預設為最小；使用 `passEnv` 明確傳遞所需的變數。
- 秘密引用在啟用時解析為記憶體快照，然後請求路徑僅讀取該快照。
- 在啟用期間，主動表面過濾適用：在啟用的表面上未解析的引用會導致啟動/重新加載失敗，而不活躍的表面則會跳過並顯示診斷資訊。

---

## Auth storage

```json5
{
  auth: {
    profiles: {
      "anthropic:me@example.com": { provider: "anthropic", mode: "oauth", email: "me@example.com" },
      "anthropic:work": { provider: "anthropic", mode: "api_key" },
    },
    order: {
      anthropic: ["anthropic:me@example.com", "anthropic:work"],
    },
  },
}
```

- 每個代理的設定檔存儲在 `<agentDir>/auth-profiles.json`。
- `auth-profiles.json` 支援值層級的引用 (`keyRef` 用於 `api_key`，`tokenRef` 用於 `token`)。
- 靜態執行時憑證來自於記憶體中解析的快照；當發現時，舊版靜態 `auth.json` 條目會被清除。
- 從 `~/.openclaw/credentials/oauth.json` 導入舊版 OAuth。
- 請參閱 [OAuth](/concepts/oauth)。
- 機密的執行時行為和 `audit/configure/apply` 工具： [機密管理](/gateway/secrets)。

---

## Logging

```json5
{
  logging: {
    level: "info",
    file: "/tmp/openclaw/openclaw.log",
    consoleLevel: "info",
    consoleStyle: "pretty", // pretty | compact | json
    redactSensitive: "tools", // off | tools
    redactPatterns: ["\\bTOKEN\\b\\s*[=:]\\s*([\"']?)([^\\s\"']+)\\1"],
  },
}
```

- 預設日誌檔案: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`。
- 設定 `logging.file` 以獲得穩定的路徑。
- `consoleLevel` 在 `--verbose` 時提升至 `debug`。

---

## CLI

```json5
{
  cli: {
    banner: {
      taglineMode: "off", // random | default | off
    },
  },
}
```

- `cli.banner.taglineMode` 控制橫幅標語樣式：
  - `"random"` (預設)：旋轉有趣/季節性標語。
  - `"default"`：固定中性標語 (`All your chats, one OpenClaw.`)。
  - `"off"`：不顯示標語文字（橫幅標題/版本仍然顯示）。
- 若要隱藏整個橫幅（不僅僅是標語），請設置環境變數 `OPENCLAW_HIDE_BANNER=1`。

---

## Wizard

CLI 錫杖所寫的元資料 (`onboard`, `configure`, `doctor`):

```json5
{
  wizard: {
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunVersion: "2026.1.4",
    lastRunCommit: "abc1234",
    lastRunCommand: "configure",
    lastRunMode: "local",
  },
}
```

---

## Identity

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Samantha",
          theme: "helpful sloth",
          emoji: "🦥",
          avatar: "avatars/samantha.png",
        },
      },
    ],
  },
}
```

由 macOS 入門助手撰寫。衍生預設值：

- `messages.ackReaction` 來自 `identity.emoji` (回退至 👀)
- `mentionPatterns` 來自 `identity.name`/`identity.emoji`
- `avatar` 接受：工作區相對路徑、`http(s)` URL，或 `data:` URI

---

## Bridge (舊版，已移除)

目前的版本不再包含 TCP 橋接。節點透過 Gateway WebSocket 進行連接。`bridge.*` 金鑰不再是設定架構的一部分（在移除之前，驗證會失敗；`openclaw doctor --fix` 可以刪除未知的金鑰）。

<Accordion title="舊版橋接設定（歷史參考）">

```json
{
  "bridge": {
    "enabled": true,
    "port": 18790,
    "bind": "tailnet",
    "tls": {
      "enabled": true,
      "autoGenerate": true
    }
  }
}
```

</Accordion>

---

## Cron

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2,
    webhook: "https://example.invalid/legacy", // deprecated fallback for stored notify:true jobs
    webhookToken: "replace-with-dedicated-token", // optional bearer token for outbound webhook auth
    sessionRetention: "24h", // duration string or false
    runLog: {
      maxBytes: "2mb", // default 2_000_000 bytes
      keepLines: 2000, // default 2000
    },
  },
}
```

- `sessionRetention`: 完成的獨立 cron 執行會話在從 `sessions.json` 中修剪之前應保留多久。也控制已刪除的 cron 轉錄檔的清理。預設值: `24h`; 設定 `false` 以禁用。
- `runLog.maxBytes`: 每個執行日誌檔案的最大大小 (`cron/runs/<jobId>.jsonl`) 在修剪之前。預設值: `2_000_000` 位元組。
- `runLog.keepLines`: 當執行日誌修剪被觸發時保留的最新行數。預設值: `2000`。
- `webhookToken`: 用於 cron webhook POST 傳送的 bearer token (`delivery.mode = "webhook"`)，如果省略則不會發送身份驗證標頭。
- `webhook`: 已棄用的舊版備用 webhook URL (http/https)，僅用於仍有 `notify: true` 的儲存工作。

請參閱 [Cron Jobs](/automation/cron-jobs)。

---

## 媒體模型範本變數

Template placeholders expanded in `tools.media.models[].args`:

| 變數               | 描述                                         |
| ------------------ | -------------------------------------------- |
| `{{Body}}`         | 完整的進站訊息內容                           |
| `{{RawBody}}`      | 原始內容（無歷史/發送者包裝）                |
| `{{BodyStripped}}` | 去除群組提及的內容                           |
| `{{From}}`         | 發送者識別碼                                 |
| `{{To}}`           | 目的地識別碼                                 |
| `{{MessageSid}}`   | 頻道訊息 ID                                  |
| `{{SessionId}}`    | 當前會話 UUID                                |
| `{{IsNewSession}}` | `"true"` 當新會話創建時                      |
| `{{MediaUrl}}`     | 進站媒體偽 URL                               |
| `{{MediaPath}}`    | 本地媒體路徑                                 |
| `{{MediaType}}`    | 媒體類型（圖片/音訊/文件/…）                 |
| `{{Transcript}}`   | 音訊逐字稿                                   |
| `{{Prompt}}`       | CLI 條目的解析媒體提示                       |
| `{{MaxChars}}`     | CLI 條目的解析最大輸出字元數                 |
| `{{ChatType}}`     | `"direct"` 或 `"group"`                      |
| `{{GroupSubject}}` | 群組主題（最佳努力）                         |
| `{{GroupMembers}}` | 群組成員預覽（最佳努力）                     |
| `{{SenderName}}`   | 發送者顯示名稱（最佳努力）                   |
| `{{SenderE164}}`   | 發送者電話號碼（最佳努力）                   |
| `{{Provider}}`     | 供應商提示（whatsapp、telegram、discord 等） |

---

## Config includes (`$include`)

將設定拆分為多個檔案：

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789 },
  agents: { $include: "./agents.json5" },
  broadcast: {
    $include: ["./clients/mueller.json5", "./clients/schmidt.json5"],
  },
}
```

**合併行為：**

- 單一檔案：替換包含的物件。
- 檔案陣列：按順序深度合併（後者覆蓋前者）。
- 同級鍵：在包含後合併（覆蓋包含的值）。
- 嵌套包含：最多可達 10 層深。
- 路徑：相對於包含的檔案解析，但必須保持在頂層設定目錄內 (`dirname` 的 `openclaw.json`)。只有在仍然能夠解析在該邊界內時，才允許使用絕對/`../` 形式。
- 錯誤：對於缺失檔案、解析錯誤和循環包含提供清晰的訊息。

---

_Related: [設定](/gateway/configuration) · [設定範例](/gateway/configuration-examples) · [醫生](/gateway/doctor)_
