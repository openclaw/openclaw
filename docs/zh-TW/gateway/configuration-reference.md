---
title: "設定參考"
description: "~/.openclaw/openclaw.json 的完整欄位參考"
---

# 設定參考

`~/.openclaw/openclaw.json` 中可用的每個欄位。若要了解任務導向的概觀，請參閱[設定](/gateway/configuration)。

設定格式為 **JSON5** (允許註解 + 結尾逗號)。所有欄位都是可選的 — OpenClaw 會在省略時使用安全預設值。

---

## 頻道

每個頻道在其設定區段存在時會自動啟動（除非 `enabled: false`）。

### 私訊和群組存取

所有頻道都支援私訊政策和群組政策：

| 私訊政策            | 行為                                                            |
| ------------------- | --------------------------------------------------------------- |
| `pairing` (預設)    | 未知寄件者會收到一次性配對碼；擁有者必須批准                    |
| `allowlist`         | 僅限 `allowFrom` 中的寄件者 (或已配對的允許儲存)                |
| `open`              | 允許所有傳入的私訊 (需要 `allowFrom: ["*"]`)                    |
| `disabled`          | 忽略所有傳入的私訊                                              |

| 群組政策              | 行為                                               |
| --------------------- | ------------------------------------------------------ |
| `allowlist` (預設)    | 僅限符合已設定允許清單的群組                       |
| `open`                | 繞過群組允許清單 (提及門控仍然適用)                   |
| `disabled`            | 阻止所有群組/聊天室訊息                          |

<Note>
`channels.defaults.groupPolicy` 會在供應商的 `groupPolicy` 未設定時設定預設值。
配對碼會在 1 小時後過期。待處理的私訊配對請求每個頻道上限為 **3 個**。
Slack/Discord 有一個特殊的回退機制：如果其供應商區段完全遺失，執行階段群組政策可以解析為 `open`（並在啟動時發出警告）。
</Note>

### WhatsApp

WhatsApp 透過 Gateway 的網路頻道 (Baileys Web) 執行。當連結的工作階段存在時會自動啟動。

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

- 如果存在，出站指令預設使用帳號 `default`；否則使用第一個已設定的帳號 ID（已排序）。
- 舊版單帳號 Baileys 憑證目錄會由 `openclaw doctor` 遷移到 `whatsapp/default`。
- 每個帳號的覆寫：`channels.whatsapp.accounts.<id>.sendReadReceipts`。

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
          allowFrom: [" @admin"],
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
      streamMode: "partial", // off | partial | block
      draftChunk: {
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph", // paragraph | newline | sentence
      },
      actions: { reactions: true, sendMessage: true },
      reactionNotifications: "own", // off | own | all
      mediaMaxMb: 5,
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
      network: { autoSelectFamily: false },
      proxy: "socks5://localhost:9050",
      webhookUrl: "https://example.com/telegram-webhook",
      webhookSecret: "secret",
      webhookPath: "/telegram-webhook",
    },
  },
}
```

- 機器人權杖：`channels.telegram.botToken` 或 `channels.telegram.tokenFile`，並以 `TELEGRAM_BOT_TOKEN` 作為預設帳號的回退。
- `configWrites: false` 會阻擋 Telegram 啟動的設定寫入（超級群組 ID 遷移、`/config set|unset`）。
- 草稿串流使用 Telegram `sendMessageDraft` (需要私人聊天主題)。
- 重試政策：請參閱[重試政策](/concepts/retry)。

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
      dm: {
        enabled: true,
        policy: "pairing",
        allowFrom: ["1234567890", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
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
      maxLinesPerMessage: 17,
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

- 權杖：`channels.discord.token`，並以 `DISCORD_BOT_TOKEN` 作為預設帳號的回退。
- 使用 `user:<id>` (私訊) 或 `channel:<id>` (公會頻道) 作為傳遞目標；純數字 ID 會被拒絕。
- 公會 slug 為小寫，空格以 `-` 取代；頻道鍵使用 slug 化名稱 (無 `#`)。建議使用公會 ID。
- 機器人撰寫的訊息預設會被忽略。`allowBots: true` 會啟用它們 (自己的訊息仍然會被過濾)。
- `maxLinesPerMessage` (預設 17) 會將過長的訊息分割，即使其字元數小於 2000。

**反應通知模式：** `off` (無)，`own` (機器人的訊息，預設)，`all` (所有訊息)，`allowlist` (來自 `guilds.<id>.users` 上的所有訊息)。

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

- 服務帳號 JSON：內嵌 (`serviceAccount`) 或檔案式 (`serviceAccountFile`)。
- 環境變數回退：`GOOGLE_CHAT_SERVICE_ACCOUNT` 或 `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`。
- 使用 `spaces/<spaceId>` 或 `users/<userId|email>` 作為傳遞目標。

### Slack

```json5
{
  channels: {
    slack: {
      enabled: true,
      botToken: "xoxb-...",
      appToken: "xapp-...",
      dm: {
        enabled: true,
        policy: "pairing",
        allowFrom: ["U123", "U456", "*"],
        groupEnabled: false,
        groupChannels: ["G123"],
      },
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
      textChunkLimit: 4000,
      chunkMode: "length",
      mediaMaxMb: 20,
    },
  },
}
```

- **Socket 模式**需要 `botToken` 和 `appToken`（預設帳號的環境變數回退為 `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`）。
- **HTTP 模式**需要 `botToken` 加上 `signingSecret`（在根目錄或每個帳號）。
- `configWrites: false` 阻擋 Slack 啟動的設定寫入。
- 使用 `user:<id>` (私訊) 或 `channel:<id>` 作為傳遞目標。

**反應通知模式：** `off`、`own` (預設)、`all`、`allowlist` (來自 `reactionAllowlist`)。

**討論串工作階段隔離：** `thread.historyScope` 為每個討論串 (預設) 或跨頻道共用。`thread.inheritParent` 會將父頻道謄本複製到新的討論串。

| 動作群組      | 預設值   | 備註                   |
| ------------ | ------- | ---------------------- |
| reactions    | enabled | 反應 + 列出反應          |
| messages     | enabled | 讀取/傳送/編輯/刪除      |
| pins         | enabled | 釘選/取消釘選/列出       |
| memberInfo   | enabled | 成員資訊               |
| emojiList    | enabled | 自訂表情符號清單         |

### Mattermost

Mattermost 以外掛程式形式提供：`openclaw plugins install @openclaw/mattermost`。

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
      textChunkLimit: 4000,
      chunkMode: "length",
    },
  },
}
```

聊天模式：`oncall` (在 @-提及時回應，預設)，`onmessage` (每則訊息)，`onchar` (以觸發字元開頭的訊息)。

### Signal

```json5
{
  channels: {
    signal: {
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      historyLimit: 50,
    },
  },
}
```

**反應通知模式：** `off`、`own` (預設)、`all`、`allowlist` (來自 `reactionAllowlist`)。

### iMessage

OpenClaw 產生 `imsg rpc` (透過標準 I/O 的 JSON-RPC)。無需守護程式或連接埠。

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "imsg",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "user @gateway-host",
      dmPolicy: "pairing",
      allowFrom: ["+15555550123", "user @example.com", "chat_id:123"],
      historyLimit: 50,
      includeAttachments: false,
      mediaMaxMb: 16,
      service: "auto",
      region: "US",
    },
  },
}
```

- 需要對訊息資料庫的完全磁碟存取權限。
- 建議使用 `chat_id:<id>` 目標。使用 `imsg chats --limit 20` 列出聊天。
- `cliPath` 可以指向 SSH 包裝器；設定 `remoteHost` 以進行 SCP 附件擷取。

<Accordion title="iMessage SSH 包裝器範例">

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$ @"
```

</Accordion>

### 多帳號 (所有頻道)

每個頻道可執行多個帳號 (每個帳號都有其 `accountId`)：

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

- 當 `accountId` 省略時 (CLI + 路由)，會使用 `default`。
- 環境變數權杖僅適用於**預設**帳號。
- 基本頻道設定適用於所有帳號，除非每個帳號有覆寫。
- 使用 `bindings[].match.accountId` 將每個帳號路由到不同的智慧代理。

### 群組聊天提及門控

群組訊息預設為**需要提及**（中繼資料提及或正規表示式模式）。適用於 WhatsApp、Telegram、Discord、Google Chat 和 iMessage 群組聊天。

**提及類型：**

- **中繼資料提及**：原生平台 @-提及。在 WhatsApp 自我聊天模式中被忽略。
- **文字模式**：`agents.list[].groupChat.mentionPatterns` 中的正規表示式模式。總是會檢查。
- 只有當偵測可能時（原生提及或至少一個模式），才會強制執行提及門控。

```json5
{
  messages: {
    groupChat: { historyLimit: 50 },
  },
  agents: {
    list: [{ id: "main", groupChat: { mentionPatterns: [" @openclaw", "openclaw"] } }],
  },
}
```

`messages.groupChat.historyLimit` 設定全域預設值。頻道可以使用 `channels.<channel>.historyLimit`（或每個帳號）覆寫。設定為 `0` 以停用。

#### 私訊歷史記錄限制

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

解析：每個私訊覆寫 → 供應商預設 → 無限制（全部保留）。

支援：`telegram`、`whatsapp`、`discord`、`slack`、`signal`、`imessage`、`msteams`。

#### 自我聊天模式

在 `allowFrom` 中包含您自己的號碼以啟用自我聊天模式 (忽略原生 @-提及，僅回應文字模式)：

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
        groupChat: { mentionPatterns: ["reisponde", " @openclaw"] },
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

<Accordion title="指令詳情">

- 文字指令必須是**獨立**訊息，前面帶有 `/`。
- `native: "auto"` 會為 Discord/Telegram 開啟原生指令，而 Slack 則關閉。
- 每個頻道的覆寫：`channels.discord.commands.native` (布林值或 `"auto"`)。`false` 會清除之前註冊的指令。
- `channels.telegram.customCommands` 會新增額外的 Telegram 機器人選單項目。
- `bash: true` 會啟用 `! <cmd>` 以用於主機 shell。需要 `tools.elevated.enabled` 以及寄件者在 `tools.elevated.allowFrom.<channel>` 中。
- `config: true` 啟用 `/config` (讀取/寫入 `openclaw.json`)。
- `channels.<provider>.configWrites` 控制每個頻道的設定變更 (預設值: true)。
- `allowFrom` 適用於每個供應商。設定後，它是**唯一**的授權來源 (頻道允許清單/配對和 `useAccessGroups` 會被忽略)。
- 當 `allowFrom` 未設定時，`useAccessGroups: false` 允許指令繞過存取群組政策。

</Accordion>

---

## 智慧代理預設值

### `agents.defaults.workspace`

預設值：`~/.openclaw/workspace`。

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

### `agents.defaults.repoRoot`

系統提示的執行階段行中顯示的選用儲存庫根目錄。如果未設定，OpenClaw 會從工作區向上自動偵測。

```json5
{
  agents: { defaults: { repoRoot: "~/Projects/openclaw" } },
}
```

### `agents.defaults.skipBootstrap`

停用自動建立工作區引導檔案 (`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`BOOTSTRAP.md`)。

```json5
{
  agents: { defaults: { skipBootstrap: true } },
}
```

### `agents.defaults.bootstrapMaxChars`

每個工作區引導檔案在截斷前的最大字元數。預設值：`20000`。

```json5
{
  agents: { defaults: { bootstrapMaxChars: 20000 } },
}
```

### `agents.defaults.userTimezone`

用於系統提示情境的時區（非訊息時間戳記）。回退至主機時區。

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

### `agents.defaults.timeFormat`

系統提示中的時間格式。預設值：`auto` (作業系統偏好設定)。

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
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
      imageModel: {
        primary: "openrouter/qwen/qwen-2.5-vl-72b-instruct:free",
        fallbacks: ["openrouter/google/gemini-2.0-flash-vision:free"],
      },
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

- `model.primary`：格式為 `provider/model` (例如 `anthropic/claude-opus-4-6`)。如果您省略供應商，OpenClaw 會假定為 `anthropic` (已棄用)。
- `models`：已設定的模型目錄和 `/model` 的允許清單。每個項目都可以包含 `alias` (捷徑) 和 `params` (供應商專屬：`temperature`、`maxTokens`)。
- `imageModel`：僅在主要模型缺少影像輸入時使用。
- `maxConcurrent`：跨工作階段的最大並行智慧代理執行次數（每個工作階段仍為序列化）。預設值：1。

**內建別名簡寫** (僅當模型在 `agents.defaults.models` 中時適用)：

| 別名           | 模型                               |
| -------------- | ------------------------------- |
| `opus`         | `anthropic/claude-opus-4-6`     |
| `sonnet`       | `anthropic/claude-sonnet-4-5`   |
| `gpt`          | `openai/gpt-5.2`                |
| `gpt-mini`     | `openai/gpt-5-mini`             |
| `gemini`       | `google/gemini-3-pro-preview`   |
| `gemini-flash` | `google/gemini-3-flash-preview` |

您設定的別名總是優先於預設值。

Z.AI GLM-4.x 模型會自動啟用思考模式，除非您設定 `--thinking off` 或自行定義 `agents.defaults.models["zai/<model>"].params.thinking`。

### `agents.defaults.cliBackends`

用於純文字回退執行的選用 CLI 後端（無工具呼叫）。在 API 供應商失敗時作為備份非常有用。

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

- CLI 後端是文字優先的；工具總是停用。
- 當 `sessionArg` 設定時支援工作階段。
- 當 `imageArg` 接受檔案路徑時，支援影像傳遞。

### `agents.defaults.heartbeat`

週期性心跳執行。

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // 0m disables
        model: "openai/gpt-5.2-mini",
        includeReasoning: false,
        session: "main",
        to: "+15555550123",
        target: "last", // last | whatsapp | telegram | discord | ... | none
        prompt: "Read HEARTBEAT.md if it exists...",
        ackMaxChars: 300,
      },
    },
  },
}
```

- `every`：持續時間字串 (ms/s/m/h)。預設值：`30m`。
- 每個智慧代理：設定 `agents.list[].heartbeat`。當任何智慧代理定義 `heartbeat` 時，**只有那些智慧代理**會執行心跳。
- 心跳會完整執行智慧代理回合 — 間隔越短，消耗的權杖越多。

### `agents.defaults.compaction`

```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard", // default | safeguard
        reserveTokensFloor: 24000,
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

- `mode`：`default` 或 `safeguard` (用於長歷史記錄的分塊摘要)。請參閱[壓縮](/concepts/compaction)。
- `memoryFlush`：在自動壓縮之前進行靜默的智慧代理回合，以儲存持久記憶體。當工作區為唯讀時會跳過。

### `agents.defaults.contextPruning`

在傳送給 LLM 之前，從記憶體中的上下文修剪**舊的工具結果**。不會修改磁碟上的工作階段歷史記錄。

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

- `mode: "cache-ttl"` 啟用修剪傳遞。
- `ttl` 控制修剪可以再次運行的頻率 (上次快取觸摸之後)。
- 修剪首先軟修剪過大的工具結果，然後在需要時硬清除舊的工具結果。

**軟修剪**保留開頭 + 結尾並在中間插入 `...`。

**硬清除**將整個工具結果替換為佔位符。

備註：

- 影像區塊永遠不會被修剪/清除。
- 比例是基於字元 (近似值)，而非確切的權杖計數。
- 如果助手訊息少於 `keepLastAssistants`，則跳過修剪。

</Accordion>

請參閱[工作階段修剪](/concepts/session-pruning)以了解行為詳情。

### 區塊串流傳輸

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

- 非 Telegram 頻道需要明確的 `*.blockStreaming: true` 才能啟用區塊回覆。
- 頻道覆寫：`channels.<channel>.blockStreamingCoalesce` (以及每個帳號的變體)。Signal/Slack/Discord/Google Chat 預設 `minChars: 1500`。
- `humanDelay`：區塊回覆之間的隨機暫停。`natural` = 800-2500 毫秒。每個智慧代理覆寫：`agents.list[].humanDelay`。

請參閱[串流](/concepts/streaming)以了解行為 + 分塊詳情。

### 輸入指示器

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

- 預設值：直接聊天/提及為 `instant`，未提及的群組聊天為 `message`。
- 每個工作階段的覆寫：`session.typingMode`、`session.typingIntervalSeconds`。

請參閱[輸入指示器](/concepts/typing-indicators)。

### `agents.defaults.sandbox`

嵌入式智慧代理的選用 **Docker 沙箱隔離**。請參閱[沙箱隔離](/gateway/sandboxing)以獲取完整指南。

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
          cdpPort: 9222,
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

<Accordion title="沙箱詳情">

**工作區存取：**

- `none`：`~/.openclaw/sandboxes` 下的每個範圍沙箱工作區
- `ro`：`/workspace` 下的沙箱工作區，智慧代理工作區以唯讀模式掛載到 `/agent`
- `rw`：智慧代理工作區以讀寫模式掛載到 `/workspace`

**範圍：**

- `session`：每個工作階段的容器 + 工作區
- `agent`：每個智慧代理一個容器 + 工作區 (預設)
- `shared`：共用容器和工作區 (無跨工作階段隔離)

**`setupCommand`** 在容器建立後執行一次 (透過 `sh -lc`)。需要網路出口、可寫入的根目錄、root 使用者。

**容器預設為 `network: "none"`** — 如果智慧代理需要出站存取，請設定為 `"bridge"`。

**傳入附件**會暫存到活動工作區的 `media/inbound/*`。

**`docker.binds`** 掛載額外的主機目錄；全域和每個智慧代理的綁定會合併。

**沙箱隔離瀏覽器** (`sandbox.browser.enabled`)：容器中的 Chromium + CDP。noVNC URL 注入到系統提示中。不需要主設定中 `browser.enabled`。

- `allowHostControl: false` (預設) 阻止沙箱隔離的工作階段針對主機瀏覽器。

</Accordion>

建置影像：

```bash
scripts/sandbox-setup.sh           # 主沙箱隔離影像
scripts/sandbox-browser-setup.sh   # 選用瀏覽器影像
```

### `agents.list` (每個智慧代理的覆寫)

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
        identity: {
          name: "Samantha",
          theme: "helpful sloth",
          emoji: "🦥",
          avatar: "avatars/samantha.png",
        },
        groupChat: { mentionPatterns: [" @openclaw"] },
        sandbox: { mode: "off" },
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

- `id`：穩定的智慧代理 ID (必需)。
- `default`：當設定多個時，第一個勝出 (會記錄警告)。如果沒有設定，清單中的第一個項目為預設值。
- `model`：字串形式僅覆寫 `primary`；物件形式 `{ primary, fallbacks }` 覆寫兩者 (`[]` 停用全域回退)。
- `identity.avatar`：工作區相對路徑、`http(s)` URL 或 `data:` URI。
- `identity` 衍生預設值：`ackReaction` 來自 `emoji`，`mentionPatterns` 來自 `name`/`emoji`。
- `subagents.allowAgents`：`sessions_spawn` 的智慧代理 ID 允許清單 (`["*"]` = 任何；預設：僅限相同智慧代理)。

---

## 多智慧代理路由

在一個 Gateway內部執行多個隔離的智慧代理。請參閱[多智慧代理](/concepts/multi-agent)。

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

- `match.channel` (必需)
- `match.accountId` (選用；`*` = 任何帳號；省略 = 預設帳號)
- `match.peer` (選用；`{ kind: direct|group|channel, id }`)
- `match.guildId` / `match.teamId` (選用；頻道專屬)

**確定性匹配順序：**

1. `match.peer`
2. `match.guildId`
3. `match.teamId`
4. `match.accountId` (精確，無 peer/guild/team)
5. `match.accountId: "*"` (頻道範圍)
6. 預設智慧代理

在每個層級中，第一個匹配的 `bindings` 項目獲勝。

### 每個智慧代理的存取設定檔

<Accordion title="完全存取 (無沙箱隔離)">

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

<Accordion title="無檔案系統存取 (僅限訊息)">

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

請參閱[多智慧代理沙箱隔離與工具](/tools/multi-agent-sandbox-tools)以了解優先順序詳情。

---

## 工作階段

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
    maintenance: {
      mode: "warn", // warn | enforce
      pruneAfter: "30d",
      maxEntries: 500,
      rotateBytes: "10mb",
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

<Accordion title="工作階段欄位詳情">

- **`dmScope`**：私訊的分組方式。
  - `main`：所有私訊共用主要工作階段。
  - `per-peer`：按跨頻道的寄件者 ID 隔離。
  - `per-channel-peer`：按頻道 + 寄件者隔離 (建議用於多使用者收件匣)。
  - `per-account-channel-peer`：按帳號 + 頻道 + 寄件者隔離 (建議用於多帳號)。
- **`identityLinks`**：將規範 ID 映射到帶有供應商前綴的對等點，以實現跨頻道工作階段共用。
- **`reset`**：主要重設政策。`daily` 在本地時間 `atHour` 重設；`idle` 在 `idleMinutes` 後重設。當兩者都設定時，哪個先過期就以哪個為準。
- **`resetByType`**：每個類型的覆寫 (`direct`、`group`、`thread`)。舊版 `dm` 接受作為 `direct` 的別名。
- **`mainKey`**：舊版欄位。執行階段現在始終使用 `"main"` 作為主要直接聊天儲存桶。
- **`sendPolicy`**：按 `channel`、`chatType` (`direct|group|channel`，帶有舊版 `dm` 別名) 或 `keyPrefix` 進行匹配。第一個拒絕規則獲勝。
- **`maintenance`**：`warn` 會在逐出時警告活動工作階段；`enforce` 應用修剪和輪換。

</Accordion>

---

## 訊息

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

### 回應前綴

每個頻道/帳號的覆寫：`channels.<channel>.responsePrefix`、`channels.<channel>.accounts.<id>.responsePrefix`。

解析 (最具體的優先)：帳號 → 頻道 → 全域。`""` 停用並停止級聯。`"auto"` 衍生 `[{identity.name}]`。

**範本變數：**

| 變數            | 說明                     | 範例                       |
| --------------- | ---------------------- | -------------------------- |
| `{model}`       | 短模型名稱             | `claude-opus-4-6`          |
| `{modelFull}`   | 完整模型識別碼         | `anthropic/claude-opus-4-6`|
| `{provider}`    | 供應商名稱             | `anthropic`                |
| `{thinkingLevel}` | 目前思考層級         | `high`, `low`, `off`       |
| `{identity.name}` | 智慧代理識別名稱         | (與 `"auto"` 相同)         |

變數不區分大小寫。`{think}` 是 `{thinkingLevel}` 的別名。

### 應答表情符號

- 預設為活動智慧代理的 `identity.emoji`，否則為 `"👀"`。設定 `""` 以停用。
- 範圍：`group-mentions` (預設)、`group-all`、`direct`、`all`。
- `removeAckAfterReply`：回覆後移除應答 (僅限 Slack/Discord/Telegram/Google Chat)。

### 入站去抖動

將來自同一寄件者的快速純文字訊息批次處理為單一智慧代理回合。媒體/附件立即刷新。控制指令繞過去抖動。

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
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
    },
  },
}
```

- `auto` 控制自動文字轉語音。`/tts off|always|inbound|tagged` 每個工作階段覆寫。
- `summaryModel` 覆寫 `agents.defaults.model.primary` 以進行自動摘要。
- API 鍵回退到 `ELEVENLABS_API_KEY`/`XI_API_KEY` 和 `OPENAI_API_KEY`。

---

## 對話

Talk 模式 (macOS/iOS/Android) 的預設值。

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
    interruptOnSpeech: true,
  },
}
```

- 語音 ID 回退到 `ELEVENLABS_VOICE_ID` 或 `SAG_VOICE_ID`。
- `apiKey` 回退到 `ELEVENLABS_API_KEY`。
- `voiceAliases` 允許 Talk 指令使用友善名稱。

---

## 工具

### 工具設定檔

`tools.profile` 在 `tools.allow`/`tools.deny` 之前設定基本允許清單：

| 設定檔       | 包含內容                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------- |
| `minimal`   | 僅 `session_status`                                                                       |
| `coding`    | `group:fs`、`group:runtime`、`group:sessions`、`group:memory`、`image`                     |
| `messaging` | `group:messaging`、`sessions_list`、`sessions_history`、`sessions_send`、`session_status` |
| `full`      | 無限制 (與未設定相同)                                                                     |

### 工具群組

| 群組              | 工具                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `group:runtime`    | `exec`、`process` (`bash` 接受為 `exec` 的別名)                                           |
| `group:fs`         | `read`、`write`、`edit`、`apply_patch`                                                   |
| `group:sessions`   | `sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status` |
| `group:memory`     | `memory_search`、`memory_get`                                                            |
| `group:web`        | `web_search`、`web_fetch`                                                                |
| `group:ui`         | `browser`、`canvas`                                                                      |
| `group:automation` | `cron`、`gateway`                                                                        |
| `group:messaging`  | `message`                                                                                |
| `group:nodes`      | `nodes`                                                                                  |
| `group:openclaw`   | 所有內建工具 (不包括供應商外掛程式)                                                      |

### `tools.allow` / `tools.deny`

全域工具允許/拒絕政策 (拒絕優先)。不區分大小寫，支援 `*` 萬用字元。即使 Docker 沙箱隔離關閉也適用。

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

控制提升 (主機) 執行存取權：

```json5
{
  tools: {
    elevated: {
      enabled: true,
      allowFrom: {
        whatsapp: ["+15555550123"],
        discord: ["steipete", "1234567890123"],
      },
    },
  },
}
```

- 每個智慧代理覆寫 (`agents.list[].tools.elevated`) 只能進一步限制。
- `/elevated on|off|ask|full` 儲存每個工作階段的狀態；內嵌指令適用於單一訊息。
- 提升的 `exec` 在主機上執行，繞過沙箱隔離。

### `tools.exec`

```json5
{
  tools: {
    exec: {
      backgroundMs: 10000,
      timeoutSec: 1800,
      cleanupMs: 1800000,
      notifyOnExit: true,
      applyPatch: {
        enabled: false,
        allowModels: ["gpt-5.2"],
      },
    },
  },
}
```

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

設定傳入媒體理解 (圖片/音訊/視訊)：

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

<Accordion title="媒體模型項目欄位">

**供應商項目** (`type: "provider"` 或省略)：

- `provider`：API 供應商 ID (`openai`、`anthropic`、`google`/`gemini`、`groq` 等)
- `model`：模型 ID 覆寫
- `profile` / `preferredProfile`：驗證設定檔選擇

**CLI 項目** (`type: "cli"`)：

- `command`：要執行的可執行檔
- `args`：範本化引數 (支援 `{{MediaPath}}`、`{{Prompt}}`、`{{MaxChars}}` 等)

**常用欄位：**

- `capabilities`：選用清單 (`image`、`audio`、`video`)。預設值：`openai`/`anthropic`/`minimax` → 圖片，`google` → 圖片+音訊+視訊，`groq` → 音訊。
- `prompt`、`maxChars`、`maxBytes`、`timeoutSeconds`、`language`：每個項目的覆寫。
- 失敗會回退到下一個項目。

供應商驗證遵循標準順序：驗證設定檔 → 環境變數 → `models.providers.*.apiKey`。

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

### `tools.subagents`

```json5
{
  agents: {
    defaults: {
      subagents: {
        model: "minimax/MiniMax-M2.1",
        maxConcurrent: 1,
        archiveAfterMinutes: 60,
      },
    },
  },
}
```

- `model`：產生子智慧代理的預設模型。如果省略，子智慧代理會繼承呼叫者的模型。
- 每個子智慧代理的工具政策：`tools.subagents.tools.allow` / `tools.subagents.tools.deny`。

---

## 自訂供應商和基礎 URL

OpenClaw 使用 pi-coding-agent 模型目錄。透過設定中的 `models.providers` 或 `~/.openclaw/agents/<agentId>/agent/models.json` 新增自訂供應商。

```json5
{
  models: {
    mode: "merge", // merge (預設) | replace
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

- 使用 `authHeader: true` + `headers` 滿足自訂驗證需求。
- 使用 `OPENCLAW_AGENT_DIR` (或 `PI_CODING_AGENT_DIR`) 覆寫智慧代理設定根目錄。

### 供應商範例

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

Cerebras 使用 `cerebras/zai-glm-4.7`；Z.AI 直接使用 `zai/glm-4.7`。

</Accordion>

<Accordion title="OpenCode Zen">

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

設定 `OPENCODE_API_KEY` (或 `OPENCODE_ZEN_API_KEY`)。捷徑：`openclaw onboard --auth-choice opencode-zen`。

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

設定 `ZAI_API_KEY`。`z.ai/*` 和 `z-ai/*` 是可接受的別名。捷徑：`openclaw onboard --auth-choice zai-api-key`。

- 一般端點：`https://api.z.ai/api/paas/v4`
- 程式碼端點 (預設)：`https://api.z.ai/api/coding/paas/v4`
- 對於一般端點，請定義具有基本 URL 覆寫的自訂供應商。

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

對於中國端點：`baseUrl: "https://api.moonshot.cn/v1"` 或 `openclaw onboard --auth-choice moonshot-api-key-cn`。

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

與 Anthropic 相容的內建供應商。捷徑：`openclaw onboard --auth-choice kimi-code-api-key`。

</Accordion>

<Accordion title="Synthetic (與 Anthropic 相容)">

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
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
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
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

基礎 URL 應省略 `/v1` (Anthropic 客戶端會附加)。捷徑：`openclaw onboard --auth-choice synthetic-api-key`。

</Accordion>

<Accordion title="MiniMax M2.1 (直接)">

```json5
{
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2.1" },
      models: {
        "minimax/MiniMax-M2.1": { alias: "Minimax" },
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
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
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

設定 `MINIMAX_API_KEY`。捷徑：`openclaw onboard --auth-choice minimax-api`。

</Accordion>

<Accordion title="本地模型 (LM Studio)">

請參閱[本地模型](/gateway/local-models)。簡而言之：在強大硬體上透過 LM Studio Responses API 執行 MiniMax M2.1；保留託管模型以備用。

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
        apiKey: "GEMINI_KEY_HERE",
        env: { GEMINI_API_KEY: "GEMINI_KEY_HERE" },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

- `allowBundled`：僅適用於捆綁 Skills 的選用允許清單 (託管/工作區 Skills 不受影響)。
- `entries.<skillKey>.enabled: false` 即使捆綁/安裝，也會停用 Skill。
- `entries.<skillKey>.apiKey`：方便 Skills 宣告主要環境變數。

---

## 外掛程式

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
        config: { provider: "twilio" },
      },
    },
  },
}
```

- 從 `~/.openclaw/extensions`、`<workspace>/.openclaw/extensions` 以及 `plugins.load.paths` 載入。
- **設定變更需要 Gateway重新啟動。**
- `allow`：選用允許清單 (僅載入列出的外掛程式)。`deny` 優先。

請參閱[外掛程式](/tools/plugin)。

---

## 瀏覽器

```json5
{
  browser: {
    enabled: true,
    evaluateEnabled: true,
    defaultProfile: "chrome",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
    color: "#FF4500",
    // headless: false,
    // noSandbox: false,
    // executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    // attachOnly: false,
  },
}
```

- `evaluateEnabled: false` 停用 `act:evaluate` 和 `wait --fn`。
- 遠端設定檔僅限附加 (啟動/停止/重設已停用)。
- 自動偵測順序：基於 Chromium 的預設瀏覽器 → Chrome → Brave → Edge → Chromium → Chrome Canary。
- 控制服務：僅限 local loopback (連接埠源自 `gateway.port`，預設 `18791`)。

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

- `seamColor`：原生應用程式 UI 介面的強調色 (Talk 模式氣泡色調等)。
- `assistant`：控制 UI 識別覆寫。回退到活動智慧代理識別。

---

## Gateway

```json5
{
  gateway: {
    mode: "local", // local | remote
    port: 18789,
    bind: "loopback",
    auth: {
      mode: "token", // token | password
      token: "your-token",
      // password: "your-password", // or OPENCLAW_GATEWAY_PASSWORD
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
    tools: {
      // Additional /tools/invoke HTTP denies
      deny: ["browser"],
      // Remove tools from the default HTTP deny list
      allow: ["gateway"],
    },
  },
}
```

<Accordion title="Gateway欄位詳情">

- `mode`：`local` (執行 Gateway) 或 `remote` (連接到遠端 Gateway)。Gateway除非是 `local` 模式，否則拒絕啟動。
- `port`：用於 WS + HTTP 的單一多工連接埠。優先順序：`--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > `18789`。
- `bind`：`auto`、`loopback` (預設)、`lan` (`0.0.0.0`)、`tailnet` (僅 Tailscale IP) 或 `custom`。
- **驗證**：預設為必填。非 local loopback 綁定需要共用權杖/密碼。新手導覽精靈預設會產生權杖。
- `auth.allowTailscale`：當為 `true` 時，Tailscale Serve 身分標頭滿足驗證 (透過 `tailscale whois` 驗證)。當 `tailscale.mode = "serve"` 時預設為 `true`。
- `auth.rateLimit`：選用的失敗驗證限制器。適用於每個客戶端 IP 和每個驗證範圍 (共用密鑰和裝置權杖獨立追蹤)。被阻擋的嘗試會傳回 `429` + `Retry-After`。
  - `auth.rateLimit.exemptLoopback` 預設為 `true`；當您有意希望 localhost 流量也受速率限制時 (用於測試設定或嚴格代理部署)，請設定為 `false`。
- `tailscale.mode`：`serve` (僅 tailnet，local loopback 綁定) 或 `funnel` (公開，需要驗證)。
- `remote.transport`：`ssh` (預設) 或 `direct` (ws/wss)。對於 `direct`，`remote.url` 必須是 `ws://` 或 `wss://`。
- `gateway.remote.token` 僅用於遠端 CLI 呼叫；不會啟用本地 Gateway 驗證。
- `trustedProxies`：終止 TLS 的反向代理 IP。僅列出您控制的代理。
- `gateway.tools.deny`：用於 HTTP `POST /tools/invoke` 的額外工具名稱 (擴展預設拒絕清單)。
- `gateway.tools.allow`：從預設 HTTP 拒絕清單中移除工具名稱。

</Accordion>

### OpenAI 相容端點

- 聊天補齊：預設停用。透過 `gateway.http.endpoints.chatCompletions.enabled: true` 啟用。
- 回應 API：`gateway.http.endpoints.responses.enabled`。
- 回應 URL 輸入強化：
  - `gateway.http.endpoints.responses.maxUrlParts`
  - `gateway.http.endpoints.responses.files.urlAllowlist`
  - `gateway.http.endpoints.responses.images.urlAllowlist`

### 多實例隔離

在一個主機上執行多個 Gateway，具有獨特的連接埠和狀態目錄：

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
openclaw gateway --port 19001
```

便利旗標：`--dev` (使用 `~/.openclaw-dev` + 連接埠 `19001`)、`--profile <name>` (使用 `~/.openclaw-<name>`)。

請參閱[多個 Gateway](/gateway/multiple-gateways)。

---

## 鉤子

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
    transformsDir: "~/.openclaw/hooks",
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

驗證：`Authorization: Bearer <token>` 或 `x-openclaw-token: <token>`。

**端點：**

- `POST /hooks/wake` → `{ text, mode?: "now"|"next-heartbeat" }`
- `POST /hooks/agent` → `{ message, name?, agentId?, sessionKey?, wakeMode?, deliver?, channel?, to?, model?, thinking?, timeoutSeconds? }`
  - 只有當 `hooks.allowRequestSessionKey=true` (預設值：`false`) 時，才接受來自請求酬載的 `sessionKey`。
- `POST /hooks/<name>` → 透過 `hooks.mappings` 解析

<Accordion title="映射詳情">

- `match.path` 匹配 `/hooks` 後的子路徑 (例如 `/hooks/gmail` → `gmail`)。
- `match.source` 匹配通用路徑的酬載欄位。
- 範本，如 `{{messages[0].subject}}`，從酬載中讀取。
- `transform` 可以指向傳回鉤子動作的 JS/TS 模組。
- `agentId` 路由到特定的智慧代理；未知 ID 會回退到預設值。
- `allowedAgentIds`：限制明確路由 (`*` 或省略 = 允許所有，`[]` = 拒絕所有)。
- `defaultSessionKey`：對於沒有明確 `sessionKey` 的鉤子智慧代理執行，可選的固定工作階段鍵名。
- `allowRequestSessionKey`：允許 `/hooks/agent` 呼叫者設定 `sessionKey` (預設值：`false`)。
- `allowedSessionKeyPrefixes`：用於明確 `sessionKey` 值 (請求 + 映射) 的可選前綴允許清單，例如 `["hook:"]`。
- `deliver: true` 將最終回覆傳送到頻道；`channel` 預設為 `last`。
- `model` 覆寫此鉤子執行的 LLM (如果已設定模型目錄，則必須允許)。

</Accordion>

### Gmail 整合

```json5
{
  hooks: {
    gmail: {
      account: "openclaw @gmail.com",
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

- Gateway在啟動時會自動啟動 `gog gmail watch serve`。設定 `OPENCLAW_SKIP_GMAIL_WATCHER=1` 以停用。
- 不要與 Gateway同時執行獨立的 `gog gmail watch serve`。

---

## Canvas 主機

```json5
{
  canvasHost: {
    root: "~/.openclaw/workspace/canvas",
    port: 18793,
    liveReload: true,
    // enabled: false, // or OPENCLAW_SKIP_CANVAS_HOST=1
  },
}
```

- 透過 HTTP 為 iOS/Android 節點提供 HTML/CSS/JS。
- 將熱重載客戶端注入到提供的 HTML 中。
- 當為空時，自動建立啟動 `index.html`。
- 也透過 `/__openclaw__/a2ui/` 提供 A2UI。
- 變更需要 Gateway重新啟動。
- 針對大型目錄或 `EMFILE` 錯誤停用熱重載。

---

## 裝置探索

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

- `minimal` (預設)：從 TXT 記錄中省略 `cliPath` + `sshPort`。
- `full`：包含 `cliPath` + `sshPort`。
- 主機名稱預設為 `openclaw`。使用 `OPENCLAW_MDNS_HOSTNAME` 覆寫。

### 廣域 (DNS-SD)

```json5
{
  discovery: {
    wideArea: { enabled: true },
  },
}
```

在 `~/.openclaw/dns/` 下寫入單播 DNS-SD 區域。對於跨網路裝置探索，與 DNS 伺服器 (建議使用 CoreDNS) + Tailscale 分割 DNS 搭配使用。

設定：`openclaw dns setup --apply`。

---

## 環境

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

- 內嵌環境變數僅在處理程序環境中缺少鍵名時才適用。
- `.env` 檔案：CWD `.env` + `~/.openclaw/.env` (兩者都不會覆寫現有變數)。
- `shellEnv`：從您的登入 shell 設定檔匯入缺少的預期鍵名。
- 請參閱[環境](/help/environment)以獲取完整的優先順序。

### 環境變數替換

在任何設定字串中使用 `${VAR_NAME}` 引用環境變數：

```json5
{
  gateway: {
    auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" },
  },
}
```

- 僅匹配大寫名稱：`[A-Z_][A-Z0-9_]*`。
- 缺少/空白的變數會在設定載入時拋出錯誤。
- 使用 `$${VAR}` 進行文字 `${VAR}` 的跳脫。
- 適用於 `$include`。

---

## 驗證儲存

```json5
{
  auth: {
    profiles: {
      "anthropic:me @example.com": { provider: "anthropic", mode: "oauth", email: "me @example.com" },
      "anthropic:work": { provider: "anthropic", mode: "api_key" },
    },
    order: {
      anthropic: ["anthropic:me @example.com", "anthropic:work"],
    },
  },
}
```

- 每個智慧代理的驗證設定檔儲存於 `<agentDir>/auth-profiles.json`。
- 舊版 OAuth 從 `~/.openclaw/credentials/oauth.json` 匯入。
- 請參閱[OAuth](/concepts/oauth)。

---

## 日誌記錄

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

- 預設日誌檔案：`/tmp/openclaw/openclaw-YYYY-MM-DD.log`。
- 設定 `logging.file` 以獲取穩定路徑。
- 當 `--verbose` 時，`consoleLevel` 會提升到 `debug`。

---

## 精靈

CLI 精靈 (`onboard`、`configure`、`doctor`) 寫入的中繼資料：

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

## 身分

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

由 macOS 新手導覽助手寫入。衍生預設值：

- `messages.ackReaction` 來自 `identity.emoji` (回退到 👀)
- `mentionPatterns` 來自 `identity.name`/`identity.emoji`
- `avatar` 接受：工作區相對路徑、`http(s)` URL 或 `data:` URI

---

## Bridge (舊版，已移除)

目前的建置已不再包含 TCP Bridge。節點透過 Gateway WebSocket 連接。`bridge.*` 鍵不再是設定模式的一部分 (驗證會失敗直到移除；`openclaw doctor --fix` 可以剝離未知鍵)。

<Accordion title="舊版 Bridge 設定 (歷史參考)">

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

## 定時任務

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2,
    sessionRetention: "24h", // duration string or false
  },
}
```

- `sessionRetention`：已完成的定時任務工作階段在修剪前保留的時間。預設值：`24h`。

請參閱[定時任務](/automation/cron-jobs)。

---

## 媒體模型範本變數

在 `tools.media.*.models[].args` 中展開的範本佔位符：

| 變數               | 說明                                       |
| ------------------ | ------------------------------------------ |
| `{{Body}}`         | 完整的傳入訊息主體                         |
| `{{RawBody}}`      | 原始主體 (無歷史記錄/寄件者包裝)           |
| `{{BodyStripped}}` | 剝離群組提及的主體                         |
| `{{From}}`         | 寄件者識別碼                               |
| `{{To}}`           | 目的地識別碼                               |
| `{{MessageSid}}`   | 頻道訊息 ID                                |
| `{{SessionId}}`    | 目前工作階段 UUID                          |
| `{{IsNewSession}}` | 建立新工作階段時為 `"true"`                |
| `{{MediaUrl}}`     | 傳入媒體虛擬 URL                           |
| `{{MediaPath}}`    | 本地媒體路徑                               |
| `{{MediaType}}`    | 媒體類型 (圖片/音訊/文件/…)                |
| `{{Transcript}}`   | 音訊謄本                                   |
| `{{Prompt}}`       | CLI 項目的解析媒體提示                     |
| `{{MaxChars}}`     | CLI 項目的解析最大輸出字元數               |
| `{{ChatType}}`     | `"direct"` 或 `"group"`                    |
| `{{GroupSubject}}` | 群組主旨 (盡力而為)                        |
| `{{GroupMembers}}` | 群組成員預覽 (盡力而為)                    |
| `{{SenderName}}`   | 寄件者顯示名稱 (盡力而為)                  |
| `{{SenderE164}}`   | 寄件者電話號碼 (盡力而為)                  |
| `{{Provider}}`     | 供應商提示 (whatsapp, telegram, discord, etc.) |

---

## 設定包含 (`$include`)

將設定分割成多個檔案：

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

- 單一檔案：替換包含物件。
- 檔案陣列：依序深度合併 (後者覆寫前者)。
- 同級鍵：在包含後合併 (覆寫包含的值)。
- 巢狀包含：最多 10 層深度。
- 路徑：相對 (相對於包含檔案)、絕對或 `../` 父參考。
- 錯誤：針對缺少檔案、解析錯誤和循環包含提供清晰的訊息。

---

_相關：[設定](/gateway/configuration) · [設定範例](/gateway/configuration-examples) · [Doctor](/gateway/doctor)_
