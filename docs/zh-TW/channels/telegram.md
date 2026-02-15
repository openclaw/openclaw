---
summary: "Telegram 機器人支援狀態、功能與設定"
read_when:
  - 處理 Telegram 功能或 webhook 時
title: "Telegram"
---

# Telegram (Bot API)

狀態：透過 grammY 支援機器人私訊 + 群組，已達到正式版就緒。長輪詢是預設模式；webhook 模式為選用。

<CardGroup cols={3}>
  <Card title="配對" icon="link" href="/channels/pairing">
    Telegram 的預設私訊策略是配對。
  </Card>
  <Card title="頻道疑難排解" icon="wrench" href="/channels/troubleshooting">
    跨頻道診斷與修復手冊。
  </Card>
  <Card title="Gateway 設定" icon="settings" href="/gateway/configuration">
    完整的頻道設定模式與範例。
  </Card>
</CardGroup>

## 快速設定

<Steps>
  <Step title="在 BotFather 中建立機器人權杖">
    開啟 Telegram 並與 ** @BotFather** 聊天 (確認帳號正是 ` @BotFather`)。

    執行 `/newbot`，依照提示操作，並儲存權杖。

  </Step>

  <Step title="設定權杖與私訊策略">

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

    環境變數備用：`TELEGRAM_BOT_TOKEN=...` (僅限預設帳戶)。

  </Step>

  <Step title="啟動 Gateway 並批准首次私訊">

```bash
openclaw gateway
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

    配對碼會在 1 小時後過期。

  </Step>

  <Step title="將機器人新增至群組">
    將機器人新增至您的群組，然後設定 `channels.telegram.groups` 和 `groupPolicy` 以符合您的存取模型。
  </Step>
</Steps>

<Note>
權杖解析順序與帳戶相關。實際上，設定值優先於環境變數備用，且 `TELEGRAM_BOT_TOKEN` 僅適用於預設帳戶。
</Note>

## Telegram 端設定

<AccordionGroup>
  <Accordion title="隱私模式與群組可見性">
    Telegram 機器人預設為 **隱私模式**，這會限制它們接收的群組訊息。

    如果機器人必須查看所有群組訊息，請：

    - 透過 `/setprivacy` 停用隱私模式，或
    - 將機器人設為群組管理員。

    切換隱私模式時，請在每個群組中移除並重新新增機器人，以便 Telegram 套用變更。

  </Accordion>

  <Accordion title="群組權限">
    管理員狀態在 Telegram 群組設定中控制。

    管理員機器人會接收所有群組訊息，這對於始終開啟的群組行為很有用。

  </Accordion>

  <Accordion title="有用的 BotFather 開關">

    - `/setjoingroups` 允許/拒絕新增群組
    - `/setprivacy` 用於群組可見性行為

  </Accordion>
</AccordionGroup>

## 存取控制與啟用

<Tabs>
  <Tab title="私訊策略">
    `channels.telegram.dmPolicy` 控制私訊存取：

    - `pairing` (預設)
    - `allowlist` (允許清單)
    - `open` (需要 `allowFrom` 包含 `"*"` )
    - `disabled` (已停用)

    `channels.telegram.allowFrom` 接受數字 ID 和使用者名稱。`telegram:` / `tg:` 前綴被接受並正規化。

    ### 尋找您的 Telegram 使用者 ID

    更安全（無第三方機器人）：

    1. 私訊您的機器人。
    2. 執行 `openclaw logs --follow`。
    3. 讀取 `from.id`。

    官方 Bot API 方法：

```bash
curl "https://api.telegram.org/bot<bot_token>/getUpdates"
```

    第三方方法（隱私性較低）：` @userinfobot` 或 ` @getidsbot`。

  </Tab>

  <Tab title="群組策略與允許清單">
    有兩個獨立的控制項：

    1. **允許哪些群組** (`channels.telegram.groups`)
       - 無 `groups` 設定：允許所有群組
       - 已設定 `groups`：作為允許清單 (明確的 ID 或 `"*"` )

    2. **允許哪些傳送者在群組中** (`channels.telegram.groupPolicy`)
       - `open` (開放)
       - `allowlist` (預設)
       - `disabled` (已停用)

    `groupAllowFrom` 用於群組傳送者篩選。如果未設定，Telegram 會回退到 `allowFrom`。

    範例：允許特定群組中的任何成員：

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
```

  </Tab>

  <Tab title="提及行為">
    群組回覆預設需要提及。

    提及可以來自：

    - 原生 ` @botusername` 提及，或
    - 提及模式來自：
      - `agents.list[].groupChat.mentionPatterns`
      - `messages.groupChat.mentionPatterns`

    工作階段層級指令開關：

    - `/activation always`
    - `/activation mention`

    這些僅更新工作階段狀態。請使用設定進行持久化。

    持久性設定範例：

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false },
      },
    },
  },
}
```

    取得群組聊天 ID：

    - 將群組訊息轉寄給 ` @userinfobot` / ` @getidsbot`
    - 或從 `openclaw logs --follow` 讀取 `chat.id`
    - 或檢查 Bot API `getUpdates`

  </Tab>
</Tabs>

## 執行階段行為

- Telegram 由 Gateway 程序擁有。
- 路由是確定性的：Telegram 入站回覆會返回 Telegram（模型不會選擇頻道）。
- 入站訊息會正規化為共享頻道封包，包含回覆中繼資料和媒體預留位置。
- 群組工作階段透過群組 ID 隔離。論壇主題會附加 `:topic:<threadId>` 以保持主題隔離。
- 私訊訊息可以攜帶 `message_thread_id`；OpenClaw 會使用具有執行緒感知的工作階段鍵路由它們，並保留執行緒 ID 用於回覆。
- 長輪詢使用 grammY 執行器，並具有每個聊天/每個執行緒的序列。整體執行器接收器併發使用 `agents.defaults.maxConcurrent`。
- Telegram Bot API 不支援已讀回條 (`sendReadReceipts` 不適用)。

## 功能參考

<AccordionGroup>
  <Accordion title="Telegram 私訊中的草稿串流傳輸">
    OpenClaw 可以透過 Telegram 草稿氣泡 (`sendMessageDraft`) 串流傳輸部分回覆。

    要求：

    - `channels.telegram.streamMode` 不是 `"off"` (預設值：`"partial"`)
    - 私人聊天
    - 入站更新包含 `message_thread_id`
    - 機器人主題已啟用 (`getMe().has_topics_enabled`)

    模式：

    - `off`：無草稿串流傳輸
    - `partial`：來自部分文字的頻繁草稿更新
    - `block`：使用 `channels.telegram.draftChunk` 進行區塊式草稿更新

    區塊模式的 `draftChunk` 預設值：

    - `minChars: 200`
    - `maxChars: 800`
    - `breakPreference: "paragraph"`

    `maxChars` 由 `channels.telegram.textChunkLimit` 限制。

    草稿串流傳輸僅限私訊；群組/頻道不使用草稿氣泡。

    如果您想要提早收到實際的 Telegram 訊息而不是草稿更新，請使用區塊串流傳輸 (`channels.telegram.blockStreaming: true`)。

    僅限 Telegram 的推理串流傳輸：

    - `/reasoning stream` 在生成時將推理傳送至草稿氣泡
    - 最終答案在沒有推理文字的情況下傳送

  </Accordion>

  <Accordion title="格式化與 HTML 回退">
    出站文字使用 Telegram `parse_mode: "HTML"`。

    - 類似 Markdown 的文字會渲染為 Telegram 安全的 HTML。
    - 原始模型 HTML 會被轉義以減少 Telegram 解析失敗。
    - 如果 Telegram 拒絕解析的 HTML，OpenClaw 會以純文字重試。

    連結預覽預設啟用，可以透過 `channels.telegram.linkPreview: false` 停用。

  </Accordion>

  <Accordion title="原生指令與自訂指令">
    Telegram 指令選單註冊在啟動時透過 `setMyCommands` 處理。

    原生指令預設值：

    - `commands.native: "auto"` 啟用 Telegram 的原生指令

    新增自訂指令選單項目：

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
    },
  },
}
```

    規則：

    - 名稱正規化（去除開頭的 `/`，小寫）
    - 有效模式：`a-z`、`0-9`、`_`，長度 `1..32`
    - 自訂指令不能覆寫原生指令
    - 衝突/重複會被跳過並記錄

    備註：

    - 自訂指令僅為選單項目；它們不會自動實作行為
    - 外掛/技能指令即使未顯示在 Telegram 選單中，輸入時仍可運作

    如果原生指令被停用，內建指令會被移除。如果已設定，自訂/外掛指令仍可能註冊。

    常見的設定失敗：

    - `setMyCommands failed` 通常表示出站 DNS/HTTPS 到 `api.telegram.org` 被封鎖。

    ### 裝置配對指令 (`device-pair` 外掛)

    安裝 `device-pair` 外掛後：

    1. `/pair` 生成設定碼
    2. 在 iOS 應用程式中貼上程式碼
    3. `/pair approve` 批准最新的待處理請求

    更多詳細資訊：[配對](/channels/pairing#pair-via-telegram-recommended-for-ios)。

  </Accordion>

  <Accordion title="內嵌按鈕">
    設定內嵌鍵盤範圍：

```json5
{
  channels: {
    telegram: {
      capabilities: {
        inlineButtons: "allowlist",
      },
    },
  },
}
```

    每個帳戶覆寫：

```json5
{
  channels: {
    telegram: {
      accounts: {
        main: {
          capabilities: {
            inlineButtons: "allowlist",
          },
        },
      },
    },
  },
}
```

    範圍：

    - `off` (關閉)
    - `dm` (私訊)
    - `group` (群組)
    - `all` (全部)
    - `allowlist` (預設)

    舊版 `capabilities: ["inlineButtons"]` 對應到 `inlineButtons: "all"`。

    訊息動作範例：

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Choose an option:",
  buttons: [
    [
      { text: "Yes", callback_data: "yes" },
      { text: "No", callback_data: "no" },
    ],
    [{ text: "Cancel", callback_data: "cancel" }],
  ],
}
```

    回呼點擊會作為文字傳遞給智慧代理：
    `callback_data: <值>`

  </Accordion>

  <Accordion title="用於智慧代理和自動化的 Telegram 訊息動作">
    Telegram 工具動作包括：

    - `sendMessage` (`to`、`content`，選用 `mediaUrl`、`replyToMessageId`、`messageThreadId`)
    - `react` (`chatId`、`messageId`、`emoji`)
    - `deleteMessage` (`chatId`、`messageId`)
    - `editMessage` (`chatId`、`messageId`、`content`)

    頻道訊息動作公開了符合人體工學的別名 (`send`、`react`、`delete`、`edit`、`sticker`、`sticker-search`)。

    閘控：

    - `channels.telegram.actions.sendMessage`
    - `channels.telegram.actions.editMessage`
    - `channels.telegram.actions.deleteMessage`
    - `channels.telegram.actions.reactions`
    - `channels.telegram.actions.sticker` (預設：已停用)

    反應移除語義：[/tools/reactions](/tools/reactions)

  </Accordion>

  <Accordion title="回覆執行緒標籤">
    Telegram 支援在生成輸出中明確的回覆執行緒標籤：

    - `[[reply_to_current]]` 回覆觸發訊息
    - `[[reply_to:<id>]]` 回覆特定的 Telegram 訊息 ID

    `channels.telegram.replyToMode` 控制處理：

    - `first` (預設)
    - `all` (全部)
    - `off` (關閉)

  </Accordion>

  <Accordion title="論壇主題與執行緒行為">
    論壇超級群組：

    - 主題工作階段鍵附加 `:topic:<threadId>`
    - 回覆和打字針對主題執行緒
    - 主題設定路徑：
      `channels.telegram.groups.<chatId>.topics.<threadId>`

    通用主題 (`threadId=1`) 特例：

    - 訊息傳送省略 `message_thread_id` (Telegram 拒絕 `sendMessage(...thread_id=1)`)
    - 打字動作仍包含 `message_thread_id`

    主題繼承：主題項目會繼承群組設定，除非被覆寫 (`requireMention`、`allowFrom`、`skills`、`systemPrompt`、`enabled`、`groupPolicy`)。

    範本上下文包括：

    - `MessageThreadId`
    - `IsForum`

    私訊執行緒行為：

    - 帶有 `message_thread_id` 的私人聊天會保留私訊路由，但使用執行緒感知的工作階段鍵/回覆目標。

  </Accordion>

  <Accordion title="音訊、影片與貼圖">
    ### 音訊訊息

    Telegram 區分語音訊息和音訊檔案。

    - 預設：音訊檔案行為
    - 在智慧代理回覆中標記 `[[audio_as_voice]]` 以強制傳送語音訊息

    訊息動作範例：

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

    ### 影片訊息

    Telegram 區分影片檔案和影片訊息。

    訊息動作範例：

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/video.mp4",
  asVideoNote: true,
}
```

    影片訊息不支援字幕；提供的訊息文字會單獨傳送。

    ### 貼圖

    入站貼圖處理：

    - 靜態 WEBP：下載並處理（預留位置 `<media:sticker>`）
    - 動態 TGS：跳過
    - 影片 WEBM：跳過

    貼圖上下文欄位：

    - `Sticker.emoji`
    - `Sticker.setName`
    - `Sticker.fileId`
    - `Sticker.fileUniqueId`
    - `Sticker.cachedDescription`

    貼圖快取檔案：

    - `~/.openclaw/telegram/sticker-cache.json`

    貼圖會被描述一次（如果可能）並快取，以減少重複的視覺呼叫。

    啟用貼圖動作：

```json5
{
  channels: {
    telegram: {
      actions: {
        sticker: true,
      },
    },
  },
}
```

    傳送貼圖動作：

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

    搜尋快取貼圖：

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

  </Accordion>

  <Accordion title="反應通知">
    Telegram 反應以 `message_reaction` 更新形式到達（與訊息酬載分開）。

    啟用後，OpenClaw 會將系統事件排入佇列，例如：

    - `Telegram reaction added: 👍 by Alice ( @alice) on msg 42`

    設定：

    - `channels.telegram.reactionNotifications`：`off | own | all` (預設：`own`)
    - `channels.telegram.reactionLevel`：`off | ack | minimal | extensive` (預設：`minimal`)

    備註：

    - `own` 表示使用者僅對機器人傳送的訊息做出反應（透過已傳送訊息快取盡力而為）。
    - Telegram 不在反應更新中提供執行緒 ID。
      - 非論壇群組路由到群組聊天工作階段
      - 論壇群組路由到群組通用主題工作階段 (`:topic:1`)，而不是確切的原始主題

    用於輪詢/webhook 的 `allowed_updates` 自動包含 `message_reaction`。

  </Accordion>

  <Accordion title="來自 Telegram 事件與指令的設定寫入">
    頻道設定寫入預設啟用 (`configWrites !== false`)。

    Telegram 觸發的寫入包括：

    - 群組遷移事件 (`migrate_to_chat_id`) 以更新 `channels.telegram.groups`
    - `/config set` 和 `/config unset` (需要啟用指令)

    停用：

```json5
{
  channels: {
    telegram: {
      configWrites: false,
    },
  },
}
```

  </Accordion>

  <Accordion title="長輪詢與 Webhook">
    預設：長輪詢。

    Webhook 模式：

    - 設定 `channels.telegram.webhookUrl`
    - 設定 `channels.telegram.webhookSecret` (設定 webhook URL 時必需)
    - 選用 `channels.telegram.webhookPath` (預設 `/telegram-webhook`)
    - 選用 `channels.telegram.webhookHost` (預設 `127.0.0.1`)

    Webhook 模式的預設本機監聽器綁定到 `127.0.0.1:8787`。

    如果您的公共端點不同，請在其前面放置一個反向代理，並將 `webhookUrl` 指向公共 URL。
    當您有意需要外部入口時，請設定 `webhookHost` (例如 `0.0.0.0`)。

  </Accordion>

  <Accordion title="限制、重試與 CLI 目標">
    - `channels.telegram.textChunkLimit` 預設為 4000。
    - `channels.telegram.chunkMode="newline"` 在長度分割之前偏好段落邊界（空白行）。
    - `channels.telegram.mediaMaxMb` (預設 5) 限制入站 Telegram 媒體下載/處理大小。
    - `channels.telegram.timeoutSeconds` 覆寫 Telegram API 用戶端逾時（如果未設定，則應用 grammY 預設值）。
    - 群組上下文歷史記錄使用 `channels.telegram.historyLimit` 或 `messages.groupChat.historyLimit` (預設 50)；`0` 停用。
    - 私訊歷史記錄控制：
      - `channels.telegram.dmHistoryLimit`
      - `channels.telegram.dms["<user_id>"].historyLimit`
    - 出站 Telegram API 重試可透過 `channels.telegram.retry` 設定。

    CLI 傳送目標可以是數字聊天 ID 或使用者名稱：

```bash
openclaw message send --channel telegram --target 123456789 --message "hi"
openclaw message send --channel telegram --target @name --message "hi"
```

  </Accordion>
</AccordionGroup>

更多幫助：[頻道疑難排解](/channels/troubleshooting)。

## Telegram 設定參考指標

主要參考：

- `channels.telegram.enabled`：啟用/停用頻道啟動。
- `channels.telegram.botToken`：機器人權杖 (BotFather)。
- `channels.telegram.tokenFile`：從檔案路徑讀取權杖。
- `channels.telegram.dmPolicy`：`pairing | allowlist | open | disabled` (預設：配對)。
- `channels.telegram.allowFrom`：私訊允許清單 (ID/使用者名稱)。`open` 需要 `"*"`。
- `channels.telegram.groupPolicy`：`open | allowlist | disabled` (預設：允許清單)。
- `channels.telegram.groupAllowFrom`：群組傳送者允許清單 (ID/使用者名稱)。
- `channels.telegram.groups`：每個群組的預設值 + 允許清單（使用 `"*"` 作為全域預設值）。
  - `channels.telegram.groups.<id>.groupPolicy`：每個群組覆寫 groupPolicy (`open | allowlist | disabled`)。
  - `channels.telegram.groups.<id>.requireMention`：提及閘控預設值。
  - `channels.telegram.groups.<id>.skills`：技能篩選（省略 = 所有技能，空白 = 無）。
  - `channels.telegram.groups.<id>.allowFrom`：每個群組傳送者允許清單覆寫。
  - `channels.telegram.groups.<id>.systemPrompt`：群組的額外系統提示。
  - `channels.telegram.groups.<id>.enabled`：當 `false` 時停用群組。
  - `channels.telegram.groups.<id>.topics.<threadId>.*`：每個主題覆寫（與群組欄位相同）。
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`：每個主題覆寫 groupPolicy (`open | allowlist | disabled`)。
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`：每個主題提及閘控覆寫。
- `channels.telegram.capabilities.inlineButtons`：`off | dm | group | all | allowlist` (預設：允許清單)。
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`：每個帳戶覆寫。
- `channels.telegram.replyToMode`：`off | first | all` (預設：`first`)。
- `channels.telegram.textChunkLimit`：出站塊大小（字元）。
- `channels.telegram.chunkMode`：`length` (預設) 或 `newline`，用於在長度分塊之前按空白行（段落邊界）分割。
- `channels.telegram.linkPreview`：切換出站訊息的連結預覽 (預設：true)。
- `channels.telegram.streamMode`：`off | partial | block` (草稿串流傳輸)。
- `channels.telegram.mediaMaxMb`：入站/出站媒體上限 (MB)。
- `channels.telegram.retry`：出站 Telegram API 呼叫的重試策略（嘗試次數、minDelayMs、maxDelayMs、抖動）。
- `channels.telegram.network.autoSelectFamily`：覆寫 Node autoSelectFamily (true=啟用，false=停用)。在 Node 22 上預設停用以避免 Happy Eyeballs 逾時。
- `channels.telegram.proxy`：Bot API 呼叫的代理 URL (SOCKS/HTTP)。
- `channels.telegram.webhookUrl`：啟用 webhook 模式 (需要 `channels.telegram.webhookSecret`)。
- `channels.telegram.webhookSecret`：webhook 密鑰 (設定 webhookUrl 時必需)。
- `channels.telegram.webhookPath`：本機 webhook 路徑 (預設 `/telegram-webhook`)。
- `channels.telegram.webhookHost`：本機 webhook 綁定主機 (預設 `127.0.0.1`)。
- `channels.telegram.actions.reactions`：閘控 Telegram 工具反應。
- `channels.telegram.actions.sendMessage`：閘控 Telegram 工具訊息傳送。
- `channels.telegram.actions.deleteMessage`：閘控 Telegram 工具訊息刪除。
- `channels.telegram.actions.sticker`：閘控 Telegram 貼圖動作 — 傳送和搜尋 (預設：false)。
- `channels.telegram.reactionNotifications`：`off | own | all` — 控制哪些反應觸發系統事件 (預設：未設定時為 `own`)。
- `channels.telegram.reactionLevel`：`off | ack | minimal | extensive` — 控制智慧代理的反應能力 (預設：未設定時為 `minimal`)。

- [設定參考 - Telegram](/gateway/configuration-reference#telegram)

Telegram 特定的高訊號欄位：

- 啟動/驗證：`enabled`、`botToken`、`tokenFile`、`accounts.*`
- 存取控制：`dmPolicy`、`allowFrom`、`groupPolicy`、`groupAllowFrom`、`groups`、`groups.*.topics.*`
- 指令/選單：`commands.native`、`customCommands`
- 執行緒/回覆：`replyToMode`
- 串流傳輸：`streamMode`、`draftChunk`、`blockStreaming`
- 格式化/傳遞：`textChunkLimit`、`chunkMode`、`linkPreview`、`responsePrefix`
- 媒體/網路：`mediaMaxMb`、`timeoutSeconds`、`retry`、`network.autoSelectFamily`、`proxy`
- Webhook：`webhookUrl`、`webhookSecret`、`webhookPath`、`webhookHost`
- 動作/功能：`capabilities.inlineButtons`、`actions.sendMessage|editMessage|deleteMessage|reactions|sticker`
- 反應：`reactionNotifications`、`reactionLevel`
- 寫入/歷史記錄：`configWrites`、`historyLimit`、`dmHistoryLimit`、`dms.*.historyLimit`

## 相關內容

- [配對](/channels/pairing)
- [頻道路由](/channels/channel-routing)
- [疑難排解](/channels/troubleshooting)
