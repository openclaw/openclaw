---
summary: "Discord bot support status, capabilities, and configuration"
read_when:
  - Working on Discord channel features
title: Discord
---

# Discord (Bot API)

狀態：已準備好透過官方 Discord 閘道進行私訊和公會頻道的交流。

<CardGroup cols={3}>
  <Card title="配對" icon="link" href="/channels/pairing">
    Discord 直接訊息預設為配對模式。
  </Card>
  <Card title="斜線指令" icon="terminal" href="/tools/slash-commands">
    原生指令行為和指令目錄。
  </Card>
  <Card title="頻道故障排除" icon="wrench" href="/channels/troubleshooting">
    跨頻道診斷和修復流程。
  </Card>
</CardGroup>

## 快速設定

您需要創建一個新的應用程式並添加一個機器人，然後將該機器人添加到您的伺服器，並將其與 OpenClaw 配對。我們建議將您的機器人添加到您自己的私人伺服器。如果您還沒有伺服器，請先[創建一個](https://support.discord.com/hc/en-us/articles/204849977-How-do-I-create-a-server)（選擇 **Create My Own > For me and my friends**）。

<Steps>
  <Step title="建立 Discord 應用程式和機器人">
    前往 [Discord 開發者入口網站](https://discord.com/developers/applications) 並點擊 **新應用程式**。將其命名為 "OpenClaw" 之類的名稱。

點擊側邊欄上的 **Bot**。將 **Username** 設定為你所稱呼的 OpenClaw 代理的名稱。

</Step>

<Step title="啟用特權意圖">
    仍然在 **Bot** 頁面，向下滾動到 **特權網關意圖** 並啟用：

- **訊息內容意圖**（必填）
  - **伺服器成員意圖**（建議；角色白名單和名稱對 ID 匹配時必填）
  - **在場意圖**（選填；僅在需要在場更新時使用）

</Step>

<Step title="複製你的機器人token">
    向上滾動回到 **Bot** 頁面，然後點擊 **重置token**。

<Note>
    儘管名稱如此，這會生成您的第一個 token — 並沒有任何東西被「重置」。
</Note>

請複製這個 token 並將其保存到某個地方。這是您的 **Bot Token**，稍後您將需要它。

</Step>

<Step title="生成邀請 URL 並將機器人添加到您的伺服器">
    在側邊欄中點擊 **OAuth2**。您將生成一個具有正確權限的邀請 URL，以將機器人添加到您的伺服器。

向下滾動到 **OAuth2 URL Generator** 並啟用：

- `bot`
  - `applications.commands`

將會出現一個 **Bot Permissions** 區域。啟用：

- 查看頻道
  - 發送訊息
  - 閱讀訊息歷史
  - 嵌入連結
  - 附加檔案
  - 添加反應（可選）

將生成的 URL 複製到最下方，貼上到您的瀏覽器中，選擇您的伺服器，然後點擊 **繼續** 以連接。您現在應該能在 Discord 伺服器中看到您的機器人。

</Step>

<Step title="啟用開發者模式並收集您的 ID">
    回到 Discord 應用程式，您需要啟用開發者模式，以便可以複製內部 ID。

1. 點擊 **使用者設定**（在你的頭像旁邊的齒輪圖示）→ **進階** → 開啟 **開發者模式**
2. 右鍵點擊側邊欄中的 **伺服器圖示** → **複製伺服器 ID**
3. 右鍵點擊你的 **頭像** → **複製使用者 ID**

請將您的 **Server ID** 和 **User ID** 以及您的 Bot Token 一起保存 — 您將在下一步將這三個資訊發送給 OpenClaw。

</Step>

<Step title="允許伺服器成員發送私訊">
    為了讓配對功能正常運作，Discord 需要允許你的機器人發送私訊給你。右鍵點擊你的 **伺服器圖示** → **隱私設定** → 開啟 **私訊**。

這讓伺服器成員（包括機器人）可以發送私訊給你。如果你想要使用 OpenClaw 的 Discord 私訊，請保持此功能啟用。如果你只打算使用公會頻道，配對後可以關閉私訊功能。

</Step>

<Step title="步驟 0：安全地設置您的機器人token（請勿在聊天中發送）">
    您的 Discord 機器人token是個秘密（就像密碼一樣）。在發送消息給您的代理之前，請在執行 OpenClaw 的機器上設置它。

```bash
openclaw config set channels.discord.token '"YOUR_BOT_TOKEN"' --json
openclaw config set channels.discord.enabled true --json
openclaw gateway
```

如果 OpenClaw 已經作為背景服務執行，請使用 `openclaw gateway restart`。

</Step>

<Step title="設定 OpenClaw 並配對">

<Tabs>
      <Tab title="詢問您的代理人">
        在任何現有的通道（例如 Telegram）上與您的 OpenClaw 代理人聊天並告訴它。如果 Discord 是您的首選通道，請改用 CLI / config 標籤。

> "我已經在設定中設置了我的 Discord 機器人 token。請使用用戶 ID `<user_id>` 和伺服器 ID `<server_id>` 完成 Discord 設定。"

      </Tab>
      <Tab title="CLI / config">
        如果您偏好基於檔案的設定，請設置：

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

[[BLOCK_N]] Env fallback for the default account: [[BLOCK_N]]

```bash
DISCORD_BOT_TOKEN=...
```

SecretRef 值也支援 `channels.discord.token`（環境變數/檔案/執行提供者）。請參閱 [Secrets Management](/gateway/secrets)。

</Tab>
    </Tabs>

</Step>

<Step title="批准第一次 DM 配對">
    等待網關執行後，然後在 Discord 中發送 DM 給你的機器人。它會回覆一個配對程式碼。

<Tabs>
      <Tab title="詢問您的代理人">
        將配對碼發送給您在現有通道上的代理人：

> "批准此 Discord 配對程式碼：`<CODE>`"

      </Tab>
      <Tab title="CLI">

```bash
openclaw pairing list discord
openclaw pairing approve discord <CODE>
```

</Tab>
    </Tabs>

配對程式碼在 1 小時後過期。

您現在應該可以透過 Discord 的私訊與您的代理進行聊天。

</Step>
</Steps>

<Note>
Token 解決是與帳戶相關的。設定的 token 值優先於環境回退。`DISCORD_BOT_TOKEN` 僅用於預設帳戶。
對於進階的外部呼叫（訊息工具/頻道操作），每次呼叫都會使用明確的 `token`。帳戶政策/重試設定仍然來自於活躍執行快照中選擇的帳戶。
</Note>

## 建議：設置公會工作區

一旦 DM 功能運作正常，您可以將您的 Discord 伺服器設置為完整的工作區，每個頻道都擁有自己的代理會話和上下文。這對於只有您和您的機器人的私人伺服器來說是推薦的做法。

<Steps>
  <Step title="將您的伺服器加入公會允許清單">
    這樣可以讓您的代理在伺服器的任何頻道中回應，而不僅僅是在私訊中。

<Tabs>
      <Tab title="詢問你的代理人">
        > "將我的 Discord 伺服器 ID `<server_id>` 加入公會允許清單"
      </Tab>
      <Tab title="設定">

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        YOUR_SERVER_ID: {
          requireMention: true,
          users: ["YOUR_USER_ID"],
        },
      },
    },
  },
}
```

</Tab>
    </Tabs>

</Step>

<Step title="允許不帶 @提及的回應">
    預設情況下，您的代理僅在被 @提及時才會在公會頻道中回應。對於私人伺服器，您可能希望它對每條消息都做出回應。

<Tabs>
      <Tab title="詢問你的代理人">
        > "允許我的代理人在這個伺服器上回應，而不需要被 @提及"
      </Tab>
      <Tab title="設定">
        在你的公會設定中設置 `requireMention: false`:

```json5
{
  channels: {
    discord: {
      guilds: {
        YOUR_SERVER_ID: {
          requireMention: false,
        },
      },
    },
  },
}
```

</Tab>
    </Tabs>

</Step>

<Step title="在公會頻道中規劃記憶">
    預設情況下，長期記憶 (MEMORY.md) 只會在私訊會話中加載。公會頻道不會自動加載 MEMORY.md。

<Tabs>
      <Tab title="詢問你的代理">
        > "當我在 Discord 頻道中提問時，如果需要從 MEMORY.md 獲取長期上下文，請使用 memory_search 或 memory_get。"
      </Tab>
      <Tab title="手動">
        如果你需要在每個頻道中共享上下文，請將穩定的指示放在 `AGENTS.md` 或 `USER.md`（它們會在每個會話中注入）。將長期筆記保存在 `MEMORY.md` 中，並使用記憶工具按需訪問它們。
      </Tab>
    </Tabs>

</Step>
</Steps>

現在在你的 Discord 伺服器上創建一些頻道並開始聊天。你的代理可以看到頻道名稱，每個頻道都有自己的獨立會話——因此你可以設置 `#coding`、`#home`、`#research`，或任何適合你工作流程的內容。

## Runtime model

- Gateway 擁有 Discord 連接。
- 回覆路由是確定性的：Discord 的進來回覆會回到 Discord。
- 預設情況下 (`session.dmScope=main`), 直接聊天會共享代理的主要會話 (`agent:main:main`)。
- 公會頻道是隔離的會話金鑰 (`agent:<agentId>:discord:channel:<channelId>`)。
- 群組私訊預設會被忽略 (`channels.discord.dm.groupEnabled=false`)。
- 原生斜線指令在隔離的指令會話中執行 (`agent:<agentId>:discord:slash:<userId>`), 同時仍然攜帶 `CommandTargetSessionKey` 到路由的對話會話。

## Forum channels

Discord 論壇和媒體頻道僅接受主題貼文。OpenClaw 支援兩種創建主題的方式：

- 發送訊息到論壇父級 (`channel:<forumId>`) 以自動創建一個主題。主題標題使用您訊息中的第一行非空白內容。
- 使用 `openclaw message thread create` 直接創建一個主題。不要為論壇頻道傳遞 `--message-id`。

範例：發送至論壇父級以創建一個主題

```bash
openclaw message send --channel discord --target channel:<forumId> \
  --message "Topic title\nBody of the post"
```

範例：明確地創建一個論壇主題

```bash
openclaw message thread create --channel discord --target channel:<forumId> \
  --thread-name "Topic title" --message "Body of the post"
```

論壇家長不接受 Discord 元件。如果您需要元件，請發送到該主題本身 (`channel:<threadId>`)。

## 互動元件

OpenClaw 支援 Discord components v2 容器用於代理訊息。使用訊息工具搭配 `components` 負載。互動結果會正常地作為入站訊息回傳給代理，並遵循現有的 Discord `replyToMode` 設定。

支援的區塊：

- `text`, `section`, `separator`, `actions`, `media-gallery`, `file`
- 行動列最多可容納 5 個按鈕或一個選擇選單
- 選擇類型：`string`, `user`, `role`, `mentionable`, `channel`

預設情況下，元件是一次性使用的。設定 `components.reusable=true` 以允許按鈕、選擇框和表單在過期之前可以多次使用。

要限制誰可以點擊按鈕，請在該按鈕上設置 `allowedUsers`（Discord 使用者 ID、標籤或 `*`）。當設定完成後，不匹配的使用者將收到一個短暫的拒絕通知。

`/model` 和 `/models` 斜線指令會開啟一個互動式模型選擇器，內含提供者和模型下拉選單，以及一個提交步驟。選擇器的回覆是短暫的，只有發起的使用者可以使用。

[[BLOCK_1]]

- `file` 區塊必須指向附件參考 (`attachment://<filename>`)
- 透過 `media`/`path`/`filePath` 提供附件（單一檔案）；使用 `media-gallery` 來處理多個檔案
- 使用 `filename` 來覆蓋上傳名稱，當它應該與附件參考相符時

[[BLOCK_1]]

- 添加 `components.modal`，最多可包含 5 個欄位
- 欄位類型：`text`、`checkbox`、`radio`、`select`、`role-select`、`user-select`
- OpenClaw 會自動添加觸發按鈕

[[BLOCK_1]]

```json5
{
  channel: "discord",
  action: "send",
  to: "channel:123456789012345678",
  message: "Optional fallback text",
  components: {
    reusable: true,
    text: "Choose a path",
    blocks: [
      {
        type: "actions",
        buttons: [
          {
            label: "Approve",
            style: "success",
            allowedUsers: ["123456789012345678"],
          },
          { label: "Decline", style: "danger" },
        ],
      },
      {
        type: "actions",
        select: {
          type: "string",
          placeholder: "Pick an option",
          options: [
            { label: "Option A", value: "a" },
            { label: "Option B", value: "b" },
          ],
        },
      },
    ],
    modal: {
      title: "Details",
      triggerLabel: "Open form",
      fields: [
        { type: "text", label: "Requester" },
        {
          type: "select",
          label: "Priority",
          options: [
            { label: "Low", value: "low" },
            { label: "High", value: "high" },
          ],
        },
      ],
    },
  },
}
```

## 存取控制與路由

<Tabs>
  <Tab title="DM 政策">
    `channels.discord.dmPolicy` 控制 DM 存取 (舊版: `channels.discord.dm.policy`):

- `pairing` (預設)
  - `allowlist`
  - `open` (需要 `channels.discord.allowFrom` 來包含 `"*"`; 遺留: `channels.discord.dm.allowFrom`)
  - `disabled`

如果 DM 政策未開啟，未知用戶將被阻擋（或在 `pairing` 模式下提示配對）。

[[BLOCK_1]]  
多帳戶優先順序：  
[[BLOCK_1]]

- `channels.discord.accounts.default.allowFrom` 僅適用於 `default` 帳戶。
  - 當命名帳戶的 `allowFrom` 未設定時，會繼承 `channels.discord.allowFrom`。
  - 命名帳戶不會繼承 `channels.discord.accounts.default.allowFrom`。

[[BLOCK_1]]  
DM 目標格式以便交付：  
[[BLOCK_1]]

- `user:<id>`
  - `<@id>` 提及

裸數字 ID 是模糊的，除非提供明確的用戶/頻道目標類型，否則將被拒絕。

</Tab>

<Tab title="公會政策">
    公會處理由 `channels.discord.groupPolicy` 控制：

- `open`
  - `allowlist`
  - `disabled`

Secure baseline when `channels.discord` exists is `allowlist`.

`allowlist` 行為：

- 公會必須符合 `channels.discord.guilds` （建議使用 `id`，接受 slug）
  - 可選的發送者白名單：`users` （建議使用穩定 ID）和 `roles` （僅限角色 ID）；如果設定了其中任何一項，當發送者符合 `users` 或 `roles` 時將被允許
  - 直接名稱/標籤匹配預設為禁用；僅在緊急情況下啟用 `channels.discord.dangerouslyAllowNameMatching: true` 兼容模式
  - 名稱/標籤支援 `users`，但 ID 更安全；`openclaw security audit` 在使用名稱/標籤條目時會發出警告
  - 如果公會設定了 `channels`，則未列出的頻道將被拒絕
  - 如果公會沒有 `channels` 阻止，則該白名單公會中的所有頻道均被允許

[[BLOCK_1]]

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        "123456789012345678": {
          requireMention: true,
          ignoreOtherMentions: true,
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

如果您只設定了 `DISCORD_BOT_TOKEN` 而沒有創建 `channels.discord` 區塊，則執行時回退為 `groupPolicy="allowlist"`（日誌中會有警告），即使 `channels.defaults.groupPolicy` 是 `open`。

</Tab>

<Tab title="提及和群組私訊">
    公會訊息預設為提及限制。

提及檢測包括：

- 明確的機器人提及
  - 設定的提及模式 (`agents.list[].groupChat.mentionPatterns`，後備 `messages.groupChat.mentionPatterns`)
  - 在支援的情況下，隱式的回覆機器人行為

`requireMention` 是根據公會/頻道 (`channels.discord.guilds...`) 進行設定的。  
`ignoreOtherMentions` 可選擇性地丟棄提及其他用戶/角色但不提及機器人的消息（不包括 @everyone/@here）。

Group DMs:

- default: ignored (`dm.groupEnabled=false`)
  - 可選的允許清單透過 `dm.groupChannels`（頻道 ID 或簡稱）

</Tab>
</Tabs>

### 基於角色的代理路由

使用 `bindings[].match.roles` 將 Discord 公會成員根據角色 ID 路由到不同的代理。基於角色的綁定僅接受角色 ID，並在對等或父對等綁定之後、以及公會專用綁定之前進行評估。如果綁定還設置了其他匹配欄位（例如 `peer` + `guildId` + `roles`），則所有設定的欄位必須匹配。

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

## 開發者入口網站設置

<AccordionGroup>
  <Accordion title="建立應用程式和機器人">

1. Discord 開發者入口網站 -> **應用程式** -> **新增應用程式** 2. **機器人** -> **新增機器人** 3. 複製機器人 token

</Accordion>

<Accordion title="特權意圖">
    在 **Bot -> 特權網關意圖** 中，啟用：

- 訊息內容意圖
  - 伺服器成員意圖（推薦）

Presence intent 是可選的，只有在您想要接收存在更新時才需要。設定機器人存在 (`setPresence`) 不需要為成員啟用存在更新。

</Accordion>

<Accordion title="OAuth 範圍和基本權限">
    OAuth URL 生成器：

- scopes: `bot`, `applications.commands`

典型的基線權限：

- 查看頻道
  - 發送訊息
  - 閱讀訊息歷史
  - 嵌入連結
  - 附加檔案
  - 添加反應（可選）

避免 `Administrator`，除非明確需要。

</Accordion>

<Accordion title="複製 ID">
    啟用 Discord 開發者模式，然後複製：

- server ID
  - channel ID
  - user ID

在 OpenClaw 設定中偏好使用數字 ID，以便進行可靠的審計和探測。

</Accordion>
</AccordionGroup>

## 原生命令與命令授權

- `commands.native` 預設為 `"auto"`，並且在 Discord 上啟用。
- 每個頻道的覆蓋設定： `channels.discord.commands.native`。
- `commands.native=false` 明確清除先前註冊的 Discord 原生命令。
- 原生命令的授權使用與正常訊息處理相同的 Discord 允許清單/政策。
- 對於未授權的使用者，命令仍可能在 Discord UI 中可見；執行仍會強制執行 OpenClaw 授權並返回「未授權」。

請參閱 [Slash commands](/tools/slash-commands) 以了解指令目錄和行為。

預設斜線指令設定：

`ephemeral: true`

## 功能詳情

<AccordionGroup>
  <Accordion title="回覆標籤和原生回覆">
    Discord 支援代理輸出的回覆標籤：

- `[[reply_to_current]]`
  - `[[reply_to:<id>]]`

受 `channels.discord.replyToMode` 控制：

- `off` (預設)
  - `first`
  - `all`

注意：`off` 禁用隱式回覆串接。顯式 `[[reply_to_*]]` 標籤仍然會被遵循。

訊息 ID 在上下文/歷史中顯示，以便代理可以針對特定訊息。

</Accordion>

<Accordion title="直播串流預覽">
    OpenClaw 可以透過發送臨時訊息並在文本到達時編輯它來串流草稿回覆。

- `channels.discord.streaming` 控制預覽串流 (`off` | `partial` | `block` | `progress`，預設值: `off`)。
  - `progress` 被接受以確保跨頻道的一致性，並對應到 Discord 上的 `partial`。
  - `channels.discord.streamMode` 是一個舊版別名，會自動遷移。
  - `partial` 隨著 token 的到達編輯單一預覽訊息。
  - `block` 發出草稿大小的區塊（使用 `draftChunk` 來調整大小和斷點）。

[[BLOCK_1]]  
範例：  
[[INLINE_1]]

```json5
{
  channels: {
    discord: {
      streaming: "partial",
    },
  },
}
```

`block` 模式的分塊預設值（限制為 `channels.discord.textChunkLimit`）：

```json5
{
  channels: {
    discord: {
      streaming: "block",
      draftChunk: {
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph",
      },
    },
  },
}
```

預覽串流僅限文字；媒體回覆將回退至正常傳送。

注意：預覽串流與區塊串流是分開的。當區塊串流在 Discord 中被明確啟用時，OpenClaw 會跳過預覽串流以避免重複串流。

</Accordion>

<Accordion title="歷史、背景與執行緒行為">
    公會歷史背景：

- `channels.discord.historyLimit` 預設 `20`
  - 備用: `messages.groupChat.historyLimit`
  - `0` 禁用

DM history controls:

- `channels.discord.dmHistoryLimit`
  - `channels.discord.dms["<user_id>"].historyLimit`

[[BLOCK_1]]  
執行緒行為：  
[[BLOCK_1]]

- Discord 線程被路由為頻道會話
  - 父線程的元數據可以用於父會話的連結
  - 線程設定繼承父頻道的設定，除非存在特定於線程的條目

Channel topics 是以 **不受信任** 的上下文注入的（而不是作為系統提示）。

</Accordion>

<Accordion title="子代理的線程綁定會話">
    Discord 可以將線程綁定到會話目標，以便該線程中的後續消息持續路由到相同的會話（包括子代理會話）。

Commands:

- `/focus <target>` 將當前/新線程綁定到子代理/會話目標
  - `/unfocus` 移除當前線程綁定
  - `/agents` 顯示活動執行和綁定狀態
  - `/session idle <duration|off>` 檢查/更新專注綁定的非活動自動失焦
  - `/session max-age <duration|off>` 檢查/更新專注綁定的硬性最大年齡

Config:

```json5
{
  session: {
    threadBindings: {
      enabled: true,
      idleHours: 24,
      maxAgeHours: 0,
    },
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        idleHours: 24,
        maxAgeHours: 0,
        spawnSubagentSessions: false, // opt-in
      },
    },
  },
}
```

Notes:

- `session.threadBindings.*` 設定全域預設值。
  - `channels.discord.threadBindings.*` 會覆蓋 Discord 的行為。
  - `spawnSubagentSessions` 必須為真才能自動創建/綁定 `sessions_spawn({ thread: true })` 的線程。
  - `spawnAcpSessions` 必須為真才能自動創建/綁定 ACP (`/acp spawn ... --thread ...` 或 `sessions_spawn({ runtime: "acp", thread: true })`) 的線程。
  - 如果帳戶的線程綁定被禁用，則 `/focus` 和相關的線程綁定操作將無法使用。

請參閱 [Sub-agents](/tools/subagents)、[ACP Agents](/tools/acp-agents) 和 [Configuration Reference](/gateway/configuration-reference)。

</Accordion>

<Accordion title="持久性 ACP 通道綁定">
    對於穩定的「隨時可用」ACP 工作區，設定針對 Discord 對話的頂層類型 ACP 綁定。

Config path:

- `bindings[]` with `type: "acp"` and `match.channel: "discord"`

[[BLOCK_1]]

```json5
{
  agents: {
    list: [
      {
        id: "codex",
        runtime: {
          type: "acp",
          acp: {
            agent: "codex",
            backend: "acpx",
            mode: "persistent",
            cwd: "/workspace/openclaw",
          },
        },
      },
    ],
  },
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "discord",
        accountId: "default",
        peer: { kind: "channel", id: "222222222222222222" },
      },
      acp: { label: "codex-main" },
    },
  ],
  channels: {
    discord: {
      guilds: {
        "111111111111111111": {
          channels: {
            "222222222222222222": {
              requireMention: false,
            },
          },
        },
      },
    },
  },
}
```

[[BLOCK_1]]

- 討論串訊息可以繼承父頻道的 ACP 綁定。
  - 在綁定的頻道或討論串中，`/new` 和 `/reset` 會在同一位置重置相同的 ACP 會話。
  - 臨時討論串綁定仍然有效，並且在活動期間可以覆蓋目標解析。

請參閱 [ACP Agents](/tools/acp-agents) 以獲取綁定行為的詳細資訊。

</Accordion>

<Accordion title="反應通知">
    每個公會的反應通知模式：

- `off`
  - `own` (預設)
  - `all`
  - `allowlist` (使用 `guilds.<id>.users`)

反應事件被轉換為系統事件，並附加到路由的 Discord 會話中。

</Accordion>

<Accordion title="Ack reactions">
    `ackReaction` 在 OpenClaw 處理進來的訊息時發送一個確認表情符號。

[[BLOCK_1]]  
Resolution order:  
[[INLINE_1]]

- `channels.discord.accounts.<accountId>.ackReaction`
  - `channels.discord.ackReaction`
  - `messages.ackReaction`
  - 代理身份表情符號後備 (`agents.list[].identity.emoji`, 否則 "👀")

Notes:

- Discord 支援 Unicode 表情符號或自訂表情符號名稱。
  - 使用 `""` 來禁用某個頻道或帳號的反應。

</Accordion>

<Accordion title="Config writes">
    頻道啟動的設定寫入預設為啟用。

這會影響 `/config set|unset` 流程（當命令功能啟用時）。

[[BLOCK_1]]

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

<Accordion title="Gateway proxy">
    通過 HTTP(S) 代理路由 Discord gateway WebSocket 流量和啟動 REST 查詢（應用程式 ID + 允許清單解析）使用 `channels.discord.proxy`。

```json5
{
  channels: {
    discord: {
      proxy: "http://proxy.example:8080",
    },
  },
}
```

每個帳戶的覆蓋：

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
    啟用 PluralKit 解析，以將代理消息映射到系統成員身份：

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; needed for private systems
      },
    },
  },
}
```

[[BLOCK_1]]

- 允許清單可以使用 `pk:<memberId>`
  - 成員顯示名稱僅在 `channels.discord.dangerouslyAllowNameMatching: true` 時根據名稱/slug 進行匹配
  - 查詢使用原始訊息 ID，並受到時間窗口的限制
  - 如果查詢失敗，代理訊息將被視為機器人訊息並被丟棄，除非 `allowBots=true`

</Accordion>

<Accordion title="狀態設定">
    當您設置狀態或活動欄位，或啟用自動狀態時，狀態更新將會生效。

[[BLOCK_1]]  
Status only example:  
[[INLINE_1]]

```json5
{
  channels: {
    discord: {
      status: "idle",
    },
  },
}
```

Activity example (custom status is the default activity type):

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

[[BLOCK_1]]  
串流範例：  
[[BLOCK_1]]

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

Activity type map:

- 0: 玩耍
  - 1: 串流 (需要 `activityUrl`)
  - 2: 收聽
  - 3: 觀看
  - 4: 自訂 (使用活動文字作為狀態；表情符號為選擇性)
  - 5: 競賽

[[BLOCK_N]] 自動存在範例（執行時健康信號）：[[BLOCK_N]]

```json5
{
  channels: {
    discord: {
      autoPresence: {
        enabled: true,
        intervalMs: 30000,
        minUpdateIntervalMs: 15000,
        exhaustedText: "token exhausted",
      },
    },
  },
}
```

自動狀態映射將執行時可用性對應到 Discord 狀態：健康 => 在線，降級或未知 => 閒置，耗盡或不可用 => 不打擾。可選的文字覆蓋：

- `autoPresence.healthyText`
  - `autoPresence.degradedText`
  - `autoPresence.exhaustedText` (支援 `{reason}` 佔位符)

</Accordion>

<Accordion title="Discord中的執行批准">
    Discord 支援在私訊中使用基於按鈕的執行批准，並且可以選擇在發起的頻道中發佈批准提示。

Config path:

- `channels.discord.execApprovals.enabled`
  - `channels.discord.execApprovals.approvers`
  - `channels.discord.execApprovals.target` (`dm` | `channel` | `both`, 預設: `dm`)
  - `agentFilter`, `sessionFilter`, `cleanupAfterResolve`

當 `target` 是 `channel` 或 `both` 時，批准提示會在頻道中顯示。只有設定的批准者可以使用按鈕；其他用戶會收到一個短暫的拒絕通知。批准提示包含命令文本，因此僅在受信任的頻道中啟用頻道傳送。如果無法從會話金鑰中推導出頻道 ID，OpenClaw 將回退到 DM 傳送。

此處理程序的網關身份驗證使用與其他網關用戶端相同的共享憑證解析合約：

- 環境優先的本地身份驗證 (`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` 然後 `gateway.auth.*`)
  - 在本地模式下，`gateway.remote.*` 只能在 `gateway.auth.*` 未設置時作為後備使用；已設定但未解析的本地 SecretRefs 會安全失敗
  - 當適用時，透過 `gateway.remote.*` 支援遠端模式
  - URL 覆蓋是安全的：CLI 覆蓋不會重用隱式憑證，而環境覆蓋僅使用環境憑證

如果批准失敗且顯示未知的批准 ID，請檢查批准者列表和功能啟用情況。

相關文件：[執行批准](/tools/exec-approvals)

</Accordion>
</AccordionGroup>

## 工具與行動閘門

Discord 訊息操作包括訊息傳送、頻道管理、管理、存在狀態和元資料操作。

[[BLOCK_1]]  
核心範例：  
[[BLOCK_1]]

- messaging: `sendMessage`, `readMessages`, `editMessage`, `deleteMessage`, `threadReply`
- reactions: `react`, `reactions`, `emojiList`
- moderation: `timeout`, `kick`, `ban`
- presence: `setPresence`

Action gates 生活在 `channels.discord.actions.*`。

[[BLOCK_1]]  
預設閘道行為：  
[[BLOCK_1]]

| 行動群組                                                                                                                                                                 | 預設值 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| reactions, messages, threads, pins, polls, search, memberInfo, roleInfo, channelInfo, channels, voiceStatus, events, stickers, emojiUploads, stickerUploads, permissions | 啟用   |
| roles                                                                                                                                                                    | 停用   |
| moderation                                                                                                                                                               | 停用   |
| presence                                                                                                                                                                 | 停用   |

## Components v2 UI

OpenClaw 使用 Discord components v2 來進行執行批准和跨上下文標記。Discord 訊息操作也可以接受 `components` 來實現自訂 UI（進階；需要 Carbon 元件實例），而舊版 `embeds` 仍然可用，但不建議使用。

- `channels.discord.ui.components.accentColor` 設定 Discord 元件容器使用的重點顏色（十六進位）。
- 可透過 `channels.discord.accounts.<id>.ui.components.accentColor` 針對每個帳號進行設定。
- 當存在元件 v2 時，`embeds` 將被忽略。

[[BLOCK_1]]  
範例：  
[[BLOCK_1]]

```json5
{
  channels: {
    discord: {
      ui: {
        components: {
          accentColor: "#5865F2",
        },
      },
    },
  },
}
```

## Voice channels

OpenClaw 可以加入 Discord 語音頻道進行即時、持續的對話。這與語音訊息附件是分開的。

[[BLOCK_1]]  
Requirements:  
[[BLOCK_1]]

- 啟用原生指令 (`commands.native` 或 `channels.discord.commands.native`)。
- 設定 `channels.discord.voice`。
- 機器人需要在目標語音頻道中擁有連接 + 說話的權限。

使用僅限 Discord 的原生指令 `/vc join|leave|status` 來控制會話。該指令使用帳戶的預設代理，並遵循與其他 Discord 指令相同的允許清單和群組政策規則。

[[BLOCK_1]]  
自動加入範例：  
[[BLOCK_1]]

```json5
{
  channels: {
    discord: {
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
    },
  },
}
```

[[BLOCK_1]]

- `voice.tts` 只會覆蓋 `messages.tts` 以進行語音播放。
- 語音轉錄會根據 Discord `allowFrom` (或 `dm.allowFrom`) 來推斷擁有者狀態；非擁有者的講者無法訪問僅限擁有者的工具（例如 `gateway` 和 `cron`）。
- 語音預設為啟用；設置 `channels.discord.voice.enabled=false` 以禁用它。
- `voice.daveEncryption` 和 `voice.decryptionFailureTolerance` 會傳遞到 `@discordjs/voice` 的加入選項。
- `@discordjs/voice` 的預設值為 `daveEncryption=true` 和 `decryptionFailureTolerance=24`，如果未設置的話。
- OpenClaw 也會監控接收解密失敗，並在短時間內重複失敗後自動恢復，通過離開/重新加入語音頻道。
- 如果接收日誌重複顯示 `DecryptionFailed(UnencryptedWhenPassthroughDisabled)`，這可能是上游 `@discordjs/voice` 接收錯誤，已在 [discord.js #11419](https://github.com/discordjs/discord.js/issues/11419) 中追蹤。

## 語音訊息

Discord 語音訊息顯示波形預覽，並需要 OGG/Opus 音訊及其元資料。OpenClaw 自動生成波形，但需要 `ffmpeg` 和 `ffprobe` 在網關主機上可用，以便檢查和轉換音訊檔案。

[[BLOCK_1]]  
Requirements and constraints:  
[[BLOCK_1]]

- 提供一個 **本地檔案路徑**（不接受 URL）。
- 省略文字內容（Discord 不允許在同一個有效載荷中同時包含文字和語音訊息）。
- 任何音訊格式皆可接受；OpenClaw 在需要時會轉換為 OGG/Opus。

[[BLOCK_1]]  
範例：  
[[BLOCK_1]]

```bash
message(action="send", channel="discord", target="channel:123", path="/path/to/audio.mp3", asVoice=true)
```

## 故障排除

<AccordionGroup>
  <Accordion title="使用不允許的意圖或機器人未看到公會訊息">

- 啟用訊息內容意圖
  - 當你依賴用戶/成員解析時，啟用伺服器成員意圖
  - 更改意圖後重新啟動網關

</Accordion>

<Accordion title="公會訊息意外被封鎖">

- 驗證 `groupPolicy`
  - 驗證公會的允許清單在 `channels.discord.guilds` 下
  - 如果公會 `channels` 地圖存在，則僅允許列出的頻道
  - 驗證 `requireMention` 行為和提及模式

有用的檢查：

```bash
openclaw doctor
openclaw channels status --probe
openclaw logs --follow
```

</Accordion>

<Accordion title="Require mention false but still blocked">
    常見原因：

- `groupPolicy="allowlist"` 沒有匹配的公會/頻道允許清單
  - `requireMention` 設定在錯誤的位置（必須在 `channels.discord.guilds` 或頻道條目下）
  - 發送者被公會/頻道 `users` 允許清單阻擋

</Accordion>

<Accordion title="長時間執行的處理程序超時或重複回覆">

典型日誌：

- `Listener DiscordMessageListener timed out after 30000ms for event MESSAGE_CREATE`
  - `Slow listener detected ...`
  - `discord inbound worker timed out after ...`

Listener budget knob:

- 單一帳戶: `channels.discord.eventQueue.listenerTimeout`
  - 多重帳戶: `channels.discord.accounts.<accountId>.eventQueue.listenerTimeout`

Worker run timeout knob:

- 單一帳戶: `channels.discord.inboundWorker.runTimeoutMs`
  - 多重帳戶: `channels.discord.accounts.<accountId>.inboundWorker.runTimeoutMs`
  - 預設: `1800000` (30 分鐘); 設定 `0` 以禁用

推薦的基準：

```json5
{
  channels: {
    discord: {
      accounts: {
        default: {
          eventQueue: {
            listenerTimeout: 120000,
          },
          inboundWorker: {
            runTimeoutMs: 1800000,
          },
        },
      },
    },
  },
}
```

使用 `eventQueue.listenerTimeout` 來設置慢速監聽器，並且僅在您想要為排隊的代理回合設置單獨的安全閥時使用 `inboundWorker.runTimeoutMs`。

</Accordion>

<Accordion title="權限審核不匹配">
    `channels status --probe` 權限檢查僅適用於數字頻道 ID。

如果您使用 slug 鍵，執行時匹配仍然可以正常運作，但探測無法完全驗證權限。

</Accordion>

<Accordion title="DM 和配對問題">

- DM 已禁用: `channels.discord.dm.enabled=false`
  - DM 政策已禁用: `channels.discord.dmPolicy="disabled"` (舊版: `channels.discord.dm.policy`)
  - 正在等待 `pairing` 模式的配對批准

</Accordion>

<Accordion title="Bot to bot loops">
    預設情況下，機器人發送的訊息會被忽略。

如果您設定 `channels.discord.allowBots=true`，請使用嚴格的提及和允許清單規則以避免循環行為。  
建議使用 `channels.discord.allowBots="mentions"` 來僅接受提及機器人的訊息。

</Accordion>

<Accordion title="語音 STT 下降與 DecryptionFailed(...)">

- 保持 OpenClaw 為最新版本 (`openclaw update`)，以確保 Discord 語音接收恢復邏輯存在
  - 確認 `channels.discord.voice.daveEncryption=true` (預設)
  - 從 `channels.discord.voice.decryptionFailureTolerance=24` (上游預設) 開始，僅在必要時進行調整
  - 監控日誌以查看：
    - `discord voice: DAVE decrypt failures detected`
    - `discord voice: repeated decrypt failures; attempting rejoin`
  - 如果在自動重新加入後仍然出現故障，收集日誌並與 [discord.js #11419](https://github.com/discordjs/discord.js/issues/11419) 進行比較

</Accordion>
</AccordionGroup>

## 設定參考指標

[[BLOCK_1]]

- [設定參考 - Discord](/gateway/configuration-reference#discord)

高信號 Discord 欄位：

- startup/auth: `enabled`, `token`, `accounts.*`, `allowBots`
- policy: `groupPolicy`, `dm.*`, `guilds.*`, `guilds.*.channels.*`
- command: `commands.native`, `commands.useAccessGroups`, `configWrites`, `slashCommand.*`
- event queue: `eventQueue.listenerTimeout` (listener budget), `eventQueue.maxQueueSize`, `eventQueue.maxConcurrency`
- inbound worker: `inboundWorker.runTimeoutMs`
- reply/history: `replyToMode`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- delivery: `textChunkLimit`, `chunkMode`, `maxLinesPerMessage`
- streaming: `streaming` (legacy alias: `streamMode`), `draftChunk`, `blockStreaming`, `blockStreamingCoalesce`
- media/retry: `mediaMaxMb`, `retry`
  - `mediaMaxMb` 限制外發的 Discord 上傳 (預設: `8MB`)
- actions: `actions.*`
- presence: `activity`, `status`, `activityType`, `activityUrl`
- UI: `ui.components.accentColor`
- features: `threadBindings`, 頂層 `bindings[]` (`type: "acp"`), `pluralkit`, `execApprovals`, `intents`, `agentComponents`, `heartbeat`, `responsePrefix`

## 安全與操作

- 將機器人 token 視為秘密 (`DISCORD_BOT_TOKEN` 在受監督的環境中較為推薦)。
- 授予最小權限的 Discord 權限。
- 如果命令 deploy/state 過時，請重新啟動網關並使用 `openclaw channels status --probe` 重新檢查。

## Related

- [配對](/channels/pairing)
- [頻道路由](/channels/channel-routing)
- [多代理路由](/concepts/multi-agent)
- [故障排除](/channels/troubleshooting)
- [斜線指令](/tools/slash-commands)
