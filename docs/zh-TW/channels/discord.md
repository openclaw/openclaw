---
summary: "Discord 機器人支援狀態、功能與設定"
read_when:
  - 處理 Discord 頻道功能時
title: "Discord"
---

# Discord (Bot API)

狀態：已準備好透過官方 Discord Gateway 支援私訊 (DMs) 與伺服器頻道。

<CardGroup cols={3}>
  <Card title="配對" icon="link" href="/channels/pairing">
    Discord 私訊預設為配對模式。
  </Card>
  <Card title="Slash 指令" icon="terminal" href="/tools/slash-commands">
    原生指令行為與指令目錄。
  </Card>
  <Card title="頻道疑難排解" icon="wrench" href="/channels/troubleshooting">
    跨頻道診斷與修復流程。
  </Card>
</CardGroup>

## 快速設定

<Steps>
  <Step title="建立 Discord 機器人並啟用 Intents">
    在 Discord Developer Portal 中建立應用程式，新增機器人，然後啟用：

    - **Message Content Intent**
    - **Server Members Intent**（角色允許清單與基於角色的路由所需；建議用於名稱對 ID 的允許清單比對）

  </Step>

  <Step title="設定 Token">

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

    預設帳號的環境變數備援：

```bash
DISCORD_BOT_TOKEN=...
```

  </Step>

  <Step title="邀請機器人並啟動 Gateway">
    邀請機器人加入您的伺服器，並授予訊息權限。

```bash
openclaw gateway
```

  </Step>

  <Step title="核准首次私訊配對">

```bash
openclaw pairing list discord
openclaw pairing approve discord <CODE>
```

    配對碼將在 1 小時後過期。

  </Step>
</Steps>

<Note>
Token 解析具備帳號感知能力。設定檔中的 Token 數值優先於環境變數備援。`DISCORD_BOT_TOKEN` 僅用於預設帳號。
</Note>

## 執行階段模型

- Gateway 負責管理 Discord 連線。
- 回覆路由是確定的：Discord 的輸入會回覆至 Discord。
- 預設情況下 (`session.dmScope=main`)，直接對話會共用智慧代理的主要工作階段 (`agent:main:main`)。
- 伺服器頻道使用獨立的工作階段金鑰 (`agent:<agentId>:discord:channel:<channelId>`)。
- 群組私訊預設會被忽略 (`channels.discord.dm.groupEnabled=false`)。
- 原生 Slash 指令在獨立的指令工作階段中執行 (`agent:<agentId>:discord:slash:<userId>`)，同時仍會將 `CommandTargetSessionKey` 傳遞至路由後的對話工作階段。

## 存取控制與路由

<Tabs>
  <Tab title="私訊原則">
    `channels.discord.dm.policy` 控制私訊存取：

    - `pairing` (預設)
    - `allowlist`
    - `open` (需要將 `channels.discord.dm.allowFrom` 包含 `"*"` )
    - `disabled`

    若私訊原則未設為 open，未知使用者將被封鎖（或在 `pairing` 模式下提示進行配對）。

    傳送的私訊目標格式：

    - `user:<id>`
    - `< @id>` 提及

    單純的數字 ID 具備歧義，除非提供明確的使用者/頻道目標類型，否則會被拒絕。

  </Tab>

  <Tab title="伺服器原則">
    伺服器處理受 `channels.discord.groupPolicy` 控制：

    - `open`
    - `allowlist`
    - `disabled`

    當 `channels.discord` 存在時，安全基準為 `allowlist`。

    `allowlist` 行為：

    - 伺服器必須符合 `channels.discord.guilds` (優先使用 `id`，亦接受 slug)
    - 選填的傳送者允許清單：`users` (ID 或名稱) 與 `roles` (僅限角色 ID)；若設定其中之一，當傳送者符合 `users` 或 `roles` 時即獲允許。
    - 若伺服器已設定 `channels`，則未列出的頻道將被拒絕。
    - 若伺服器沒有 `channels` 區塊，則該允許清單伺服器中的所有頻道皆獲允許。

    範例：

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        "123456789012345678": {
          requireMention: true,
          users: ["987654321098765432"],
          roles: ["123456789012345678"],
          channels: {
            general: { allow: true },
            help: { allow: true, requireMention: true },
          },
        },
      },
    },
  },
}
```

    若您僅設定 `DISCORD_BOT_TOKEN` 而未建立 `channels.discord` 區塊，執行階段備援將為 `groupPolicy="open"` (並在日誌中顯示警告)。

  </Tab>

  <Tab title="提及與群組私訊">
    伺服器訊息預設受提及限制 (mention-gated)。

    提及偵測包含：

    - 明確的機器人提及
    - 設定的提及模式 (`agents.list[].groupChat.mentionPatterns`，備援 `messages.groupChat.mentionPatterns`)
    - 支援案例中的隱含回覆機器人行為

    `requireMention` 是針對每個伺服器/頻道進行設定 (`channels.discord.guilds...`)。

    群組私訊：

    - 預設：忽略 (`dm.groupEnabled=false`)
    - 選填的允許清單透過 `dm.groupChannels` 設定 (頻道 ID 或 slug)

  </Tab>
</Tabs>

### 基於角色的智慧代理路由

使用 `bindings[].match.roles` 根據角色 ID 將 Discord 伺服器成員路由至不同的智慧代理。基於角色的綁定僅接受角色 ID，且會在對等或父級對等綁定之後、僅限伺服器綁定之前進行評估。若綁定同時設定了其他匹配欄位（例如 `peer` + `guildId` + `roles`），則所有設定的欄位皆須匹配。

```json5
{
  bindings: [
    {
      agentId: "opus",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
        roles: ["111111111111111111"],
      },
    },
    {
      agentId: "sonnet",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
      },
    },
  ],
}
```

## 開發者入口網站設定

<AccordionGroup>
  <Accordion title="建立應用程式與機器人">

    1. Discord Developer Portal -> **Applications** -> **New Application**
    2. **Bot** -> **Add Bot**
    3. 複製機器人 Token

  </Accordion>

  <Accordion title="特權 Intents">
    在 **Bot -> Privileged Gateway Intents** 中啟用：

    - Message Content Intent
    - Server Members Intent (建議)

    Presence intent 為選填，僅在您想要接收狀態更新時才需要。設定機器人狀態 (`setPresence`) 不需要為成員啟用狀態更新。

  </Accordion>

  <Accordion title="OAuth 範圍與基準權限">
    OAuth URL 產生器：

    - 範圍 (scopes)：`bot`, `applications.commands`

    典型的基準權限：

    - View Channels (查看頻道)
    - Send Messages (傳送訊息)
    - Read Message History (讀取訊息歷史紀錄)
    - Embed Links (內嵌連結)
    - Attach Files (附加檔案)
    - Add Reactions (新增反應，選填)

    除非明確需要，否則請避免使用 `Administrator` (管理員)。

  </Accordion>

  <Accordion title="複製 ID">
    啟用 Discord 開發者模式，然後複製：

    - 伺服器 ID
    - 頻道 ID
    - 使用者 ID

    在 OpenClaw 設定中建議使用數字 ID，以進行可靠的稽核與探測。

  </Accordion>
</AccordionGroup>

## 原生指令與指令授權

- `commands.native` 預設為 `"auto"` 且已為 Discord 啟用。
- 各別頻道覆寫：`channels.discord.commands.native`。
- `commands.native=false` 會明確清除先前註冊的 Discord 原生指令。
- 原生指令授權使用與一般訊息處理相同的 Discord 允許清單/原則。
- 未獲授權的使用者可能仍可在 Discord UI 中看到指令；執行時仍會強制執行 OpenClaw 授權並回傳 "not authorized"。

請參閱 [Slash 指令](/tools/slash-commands) 以了解指令目錄與行為。

## 功能詳情

<AccordionGroup>
  <Accordion title="回覆標籤與原生回覆">
    Discord 支援智慧代理輸出中的回覆標籤：

    - `[[reply_to_current]]`
    - `[[reply_to:<id>]]`

    受 `channels.discord.replyToMode` 控制：

    - `off` (預設)
    - `first`
    - `all`

    訊息 ID 會顯示在上下文/歷史紀錄中，以便智慧代理針對特定訊息。

  </Accordion>

  <Accordion title="歷史紀錄、上下文與討論串行為">
    伺服器歷史紀錄上下文：

    - `channels.discord.historyLimit` 預設為 `20`
    - 備援：`messages.groupChat.historyLimit`
    - `0` 表示停用

    私訊歷史紀錄控制：

    - `channels.discord.dmHistoryLimit`
    - `channels.discord.dms["<user_id>"].historyLimit`

    討論串行為：

    - Discord 討論串被路由為頻道工作階段
    - 父級討論串元數據可用於父級工作階段連結
    - 除非存在討論串專用的項目，否則討論串設定會繼承父頻道設定

    頻道主題會作為 **不可信** 的上下文注入（而非系統提示詞）。

  </Accordion>

  <Accordion title="表情符號回應通知">
    各伺服器的回應通知模式：

    - `off`
    - `own` (預設)
    - `all`
    - `allowlist` (使用 `guilds.<id>.users`)

    回應事件會轉換為系統事件，並附加至路由後的 Discord 工作階段。

  </Accordion>

  <Accordion title="設定寫入">
    由頻道發起的設定寫入預設為啟用。

    這會影響 `/config set|unset` 流程（當指令功能啟用時）。

    停用：

```json5
{
  channels: {
    discord: {
      configWrites: false,
    },
  },
}
```

  </Accordion>

  <Accordion title="Gateway 代理伺服器">
    透過 `channels.discord.proxy` 使用 HTTP(S) 代理伺服器路由 Discord Gateway WebSocket 流量。

```json5
{
  channels: {
    discord: {
      proxy: "http://proxy.example:8080",
    },
  },
}
```

    各帳號覆寫：

```json5
{
  channels: {
    discord: {
      accounts: {
        primary: {
          proxy: "http://proxy.example:8080",
        },
      },
    },
  },
}
```

  </Accordion>

  <Accordion title="PluralKit 支援">
    啟用 PluralKit 解析以將代理訊息對應至系統成員身分：

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // 選填；私有系統需要
      },
    },
  },
}
```

    備註：

    - 允許清單可以使用 `pk:<memberId>`
    - 成員顯示名稱透過名稱/slug 進行匹配
    - 查詢使用原始訊息 ID 且受時間範圍限制
    - 若查詢失敗，代理訊息將被視為機器人訊息並捨棄，除非 `allowBots=true`

  </Accordion>

  <Accordion title="狀態呈現設定">
    僅在您設定狀態 (status) 或活動 (activity) 欄位時，才會套用狀態呈現更新。

    僅限狀態範例：

```json5
{
  channels: {
    discord: {
      status: "idle",
    },
  },
}
```

    活動範例（自訂狀態是預設活動類型）：

```json5
{
  channels: {
    discord: {
      activity: "Focus time",
      activityType: 4,
    },
  },
}
```

    串流範例：

```json5
{
  channels: {
    discord: {
      activity: "Live coding",
      activityType: 1,
      activityUrl: "https://twitch.tv/openclaw",
    },
  },
}
```

    活動類型對照表：

    - 0: 正在玩 (Playing)
    - 1: 正在串流 (Streaming) (需要 `activityUrl`)
    - 2: 正在聽 (Listening)
    - 3: 正在看 (Watching)
    - 4: 自訂 (Custom) (將活動文字作為狀態說明；表情符號為選填)
    - 5: 正在競爭 (Competing)

  </Accordion>

  <Accordion title="在 Discord 中執行核准">
    Discord 支援在私訊中使用基於按鈕的執行核准。

    設定路徑：

    - `channels.discord.execApprovals.enabled`
    - `channels.discord.execApprovals.approvers`
    - `agentFilter`, `sessionFilter`, `cleanupAfterResolve`

    若核准因未知核准 ID 而失敗，請檢查核准者清單與功能是否啟用。

    相關文件：[執行核准](/tools/exec-approvals)

  </Accordion>
</AccordionGroup>

## 工具與動作閘門

Discord 訊息動作包含訊息傳遞、頻道管理、調解 (moderation)、狀態呈現與元數據動作。

核心範例：

- 訊息傳遞：`sendMessage`, `readMessages`, `editMessage`, `deleteMessage`, `threadReply`
- 回應：`react`, `reactions
