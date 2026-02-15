---
summary: "Discord 機器人支援狀態、功能與設定"
read_when:
  - 處理 Discord 頻道功能時
title: "Discord"
---

# Discord (機器人 API)

狀態：透過官方 Discord Gateway 準備好進行私訊 (DM) 和公會頻道。

<CardGroup cols={3}>
  <Card title="配對" icon="link" href="/channels/pairing">
    Discord 私訊預設為配對模式。
  </Card>
  <Card title="斜線指令" icon="terminal" href="/tools/slash-commands">
    原生指令行為與指令目錄。
  </Card>
  <Card title="頻道疑難排解" icon="wrench" href="/channels/troubleshooting">
    跨頻道診斷與修復流程。
  </Card>
</CardGroup>

## 快速設定

<Steps>
  <Step title="建立 Discord 機器人並啟用意圖">
    在 Discord 開發者入口網站中建立一個應用程式，新增一個機器人，然後啟用：

    - **訊息內容意圖 (Message Content Intent)**
    - **伺服器成員意圖 (Server Members Intent)** (角色允許清單和基於角色的路由所需；建議用於名稱到 ID 的允許清單比對)

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

    預設帳戶的環境變數備用：

```bash
DISCORD_BOT_TOKEN=...
```

  </Step>

  <Step title="邀請機器人並啟動 Gateway">
    邀請機器人加入您的伺服器並授予訊息權限。

```bash
openclaw gateway
```

  </Step>

  <Step title="批准第一次私訊配對">

```bash
openclaw pairing list discord
openclaw pairing approve discord <CODE>
```

    配對碼在 1 小時後過期。

  </Step>
</Steps>

<Note>
Token 解析會依帳戶而定。設定中的 Token 值優先於環境變數備用。`DISCORD_BOT_TOKEN` 僅用於預設帳戶。
</Note>

## 運行時模型

- Gateway 擁有 Discord 連線。
- 回覆路由是確定性的：Discord 入站回覆會回到 Discord。
- 預設情況下 (`session.dmScope=main`)，直接聊天共用智慧代理主要工作階段 (`agent:main:main`)。
- 公會頻道是獨立的工作階段鍵值 (`agent:<agentId>:discord:channel:<channelId>`)。
- 群組私訊預設被忽略 (`channels.discord.dm.groupEnabled=false`)。
- 原生斜線指令在獨立的指令工作階段中運行 (`agent:<agentId>:discord:slash:<userId>`)，同時仍攜帶 `CommandTargetSessionKey` 到路由的對話工作階段。

## 存取控制與路由

<Tabs>
  <Tab title="私訊策略">
    `channels.discord.dm.policy` 控制私訊存取：

    - `pairing` (預設)
    - `allowlist`
    - `open` (需要 `channels.discord.dm.allowFrom` 包含 `"*"`)
    - `disabled`

    如果私訊策略不是開啟的，未知使用者將被封鎖 (或在 `pairing` 模式下提示配對)。

    私訊傳送的目標格式：

    - `user:<id>`
    - `< @id>` 提及

    裸露的數字 ID 是模糊的，除非提供明確的使用者/頻道目標類型，否則將被拒絕。

  </Tab>

  <Tab title="公會策略">
    公會處理由 `channels.discord.groupPolicy` 控制：

    - `open`
    - `allowlist`
    - `disabled`

    當 `channels.discord` 存在時，安全基準為 `allowlist`。

    `allowlist` 行為：

    - 公會必須符合 `channels.discord.guilds` (建議使用 `id`，接受 slug)
    - 可選的傳送者允許清單：`users` (ID 或名稱) 和 `roles` (僅角色 ID)；如果其中任何一個已設定，則傳送者在符合 `users` 或 `roles` 時被允許
    - 如果公會設定了 `channels`，則未列出的頻道將被拒絕
    - 如果公會沒有 `channels` 區塊，則該允許清單中的所有頻道都將被允許

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

    如果您只設定 `DISCORD_BOT_TOKEN` 而不建立 `channels.discord` 區塊，運行時備用為 `groupPolicy="open"` (並在日誌中發出警告)。

  </Tab>

  <Tab title="提及和群組私訊">
    公會訊息預設受到提及的限制。

    提及偵測包括：

    - 明確提及機器人
    - 設定的提及模式 (`agents.list[].groupChat.mentionPatterns`，備用 `messages.groupChat.mentionPatterns`)
    - 在支援情況下的隱式回覆機器人行為

    `requireMention` 在每個公會/頻道設定 (`channels.discord.guilds...`)。

    群組私訊：

    - 預設：忽略 (`dm.groupEnabled=false`)
    - 透過 `dm.groupChannels` (頻道 ID 或 slugs) 可選的允許清單

  </Tab>
</Tabs>

### 基於角色的智慧代理路由

使用 `bindings[].match.roles` 根據角色 ID 將 Discord 公會成員路由到不同的智慧代理。基於角色的綁定只接受角色 ID，並在對等或父對等綁定之後、公會專屬綁定之前進行評估。如果綁定也設定了其他匹配欄位 (例如 `peer` + `guildId` + `roles`)，則所有設定的欄位都必須匹配。

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
  <Accordion title="建立應用程式和機器人">

    1. Discord 開發者入口網站 -> **應用程式** -> **新增應用程式**
    2. **機器人** -> **新增機器人**
    3. 複製機器人 Token

  </Accordion>

  <Accordion title="特權意圖">
    在 **機器人 -> 特權 Gateway 意圖** 中，啟用：

    - 訊息內容意圖 (Message Content Intent)
    - 伺服器成員意圖 (Server Members Intent) (建議)

    狀態意圖是可選的，只有在您想接收狀態更新時才需要。設定機器人狀態 (`setPresence`) 不需要為成員啟用狀態更新。

  </Accordion>

  <Accordion title="OAuth 範圍和基本權限">
    OAuth URL 產生器：

    - 範圍：`bot`, `applications.commands`

    典型基本權限：

    - 檢視頻道
    - 傳送訊息
    - 讀取訊息歷史記錄
    - 嵌入連結
    - 附加檔案
    - 新增反應 (可選)

    除非明確需要，否則請避免 `管理員`。

  </Accordion>

  <Accordion title="複製 ID">
    啟用 Discord 開發者模式，然後複製：

    - 伺服器 ID
    - 頻道 ID
    - 使用者 ID

    在 OpenClaw 設定中優先使用數字 ID，以進行可靠的稽核和探測。

  </Accordion>
</AccordionGroup>

## 原生指令和指令認證

- `commands.native` 預設為 `"auto"` 並為 Discord 啟用。
- 每個頻道覆寫：`channels.discord.commands.native`。
- `commands.native=false` 會明確清除先前註冊的 Discord 原生指令。
- 原生指令認證使用與正常訊息處理相同的 Discord 允許清單/策略。
- 指令可能仍會在使用者的 Discord UI 中可見，但未經授權的使用者無法執行；執行仍強制執行 OpenClaw 認證並返回「未經授權」。

請參閱 [斜線指令](/tools/slash-commands) 以了解指令目錄和行為。

## 功能詳情

<AccordionGroup>
  <Accordion title="回覆標籤和原生回覆">
    Discord 支援智慧代理輸出中的回覆標籤：

    - `[[reply_to_current]]`
    - `[[reply_to:<id>]]`

    由 `channels.discord.replyToMode` 控制：

    - `off` (預設)
    - `first`
    - `all`

    訊息 ID 會顯示在上下文/歷史記錄中，以便智慧代理可以針對特定訊息。

  </Accordion>

  <Accordion title="歷史記錄、上下文和執行緒行為">
    公會歷史記錄上下文：

    - `channels.discord.historyLimit` 預設 `20`
    - 備用：`messages.groupChat.historyLimit`
    - `0` 禁用

    私訊歷史記錄控制：

    - `channels.discord.dmHistoryLimit`
    - `channels.discord.dms["<user_id>"].historyLimit`

    執行緒行為：

    - Discord 執行緒被路由為頻道工作階段
    - 父執行緒中繼資料可用於父工作階段連結
    - 執行緒設定繼承父頻道設定，除非存在執行緒專用條目

    頻道主題被注入為**不受信任**的上下文 (而非系統提示)。

  </Accordion>

  <Accordion title="反應通知">
    每個公會的反應通知模式：

    - `off`
    - `own` (預設)
    - `all`
    - `allowlist` (使用 `guilds.<id>.users`)

    反應事件會轉換為系統事件並附加到路由的 Discord 工作階段。

  </Accordion>

  <Accordion title="設定寫入">
    頻道發起的設定寫入預設為啟用。

    這會影響 `/config set|unset` 流程 (當指令功能啟用時)。

    禁用：

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

  <Accordion title="Gateway 代理">
    使用 `channels.discord.proxy` 透過 HTTP(S) 代理路由 Discord Gateway WebSocket 流量。

```json5
{
  channels: {
    discord: {
      proxy: "http://proxy.example:8080",
    },
  },
}
```

    每個帳戶覆寫：

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
    啟用 PluralKit 解析以將代理訊息映射到系統成員身分：

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // 可選；私有系統所需
      },
    },
  },
}
```

    注意事項：

    - 允許清單可以使用 `pk:<memberId>`
    - 成員顯示名稱按名稱/slug 匹配
    - 查詢使用原始訊息 ID 且受時間窗限制
    - 如果查詢失敗，代理訊息將被視為機器人訊息並丟棄，除非 `allowBots=true`

  </Accordion>

  <Accordion title="狀態設定">
    狀態更新僅在您設定狀態或活動欄位時應用。

    僅狀態範例：

```json5
{
  channels: {
    discord: {
      status: "idle",
    },
  },
}
```

    活動範例 (自訂狀態是預設活動類型)：

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

    活動類型對應：

    - 0: 玩遊戲
    - 1: 串流 (需要 `activityUrl`)
    - 2: 聽音樂
    - 3: 看影片
    - 4: 自訂 (將活動文字用作狀態；表情符號是可選的)
    - 5: 競賽

  </Accordion>

  <Accordion title="Discord 中的執行批准">
    Discord 支援在私訊中使用按鈕進行執行批准。

    設定路徑：

    - `channels.discord.execApprovals.enabled`
    - `channels.discord.execApprovals.approvers`
    - `agentFilter`, `sessionFilter`, `cleanupAfterResolve`

    如果批准因未知的批准 ID 而失敗，請驗證批准者清單和功能啟用。

    相關文件：[執行批准](/tools/exec-approvals)

  </Accordion>
</AccordionGroup>

## 工具和動作閘門

Discord 訊息動作包括傳訊、頻道管理員、審核、狀態和中繼資料動作。

核心範例：

- 傳訊：`sendMessage`, `readMessages`, `editMessage`, `deleteMessage`, `threadReply`
- 反應：`react`, `reactions`, `emojiList
