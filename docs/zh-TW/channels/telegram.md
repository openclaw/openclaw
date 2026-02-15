---
summary: "Telegram 機器人支援狀態、功能與設定"
read_when:
  - 處理 Telegram 功能或 Webhook 時
title: "Telegram"
---

# Telegram (Bot API)

狀態：已可用於生產環境，支援透過 grammY 進行機器人私訊與群組對話。預設模式為長輪詢 (Long polling)；Webhook 模式為選用。

<CardGroup cols={3}>
  <Card title="配對" icon="link" href="/channels/pairing">
    Telegram 的預設私訊原則為配對。
  </Card>
  <Card title="頻道疑難排解" icon="wrench" href="/channels/troubleshooting">
    跨頻道的診斷與修復指南。
  </Card>
  <Card title="Gateway 設定" icon="settings" href="/gateway/configuration">
    完整的頻道設定模式與範例。
  </Card>
</CardGroup>

## 快速設定

<Steps>
  <Step title="在 BotFather 建立機器人權杖 (token)">
    開啟 Telegram 並與 **@BotFather** 對話（請確認名稱完全符合 `@BotFather`）。

    執行 `/newbot`，按照提示操作，並儲存權杖。

  </Step>

  <Step title="設定權杖與私訊原則">

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

    環境變數備援：`TELEGRAM_BOT_TOKEN=...`（僅適用於預設帳號）。

  </Step>

  <Step title="啟動 Gateway 並核准首個私訊">

```bash
openclaw gateway
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

    配對代碼將於 1 小時後過期。

  </Step>

  <Step title="將機器人加入群組">
    將機器人加入您的群組，然後設定 `channels.telegram.groups` 和 `groupPolicy` 以符合您的存取模型。
  </Step>
</Steps>

<Note>
權杖解析順序具有帳號感知能力。在實務上，設定檔的值優先於環境變數備援，且 `TELEGRAM_BOT_TOKEN` 僅適用於預設帳號。
</Note>

## Telegram 側設定

<AccordionGroup>
  <Accordion title="隱私模式與群組可見性">
    Telegram 機器人預設啟用 **隱私模式 (Privacy Mode)**，這會限制其接收到的群組訊息。

    如果機器人必須接收所有群組訊息，請執行以下操作之一：

    - 透過 `/setprivacy` 停用隱私模式，或
    - 將機器人設為群組管理員。

    切換隱私模式時，請在每個群組中移除並重新加入機器人，以便 Telegram 套用變更。

  </Accordion>

  <Accordion title="群組權限">
    管理員狀態由 Telegram 群組設定控制。

    管理員權限的機器人會接收所有群組訊息，這對於需要持續運作的群組行為非常有用。

  </Accordion>

  <Accordion title="實用的 BotFather 開關">

    - `/setjoingroups` 用於允許/禁止加入群組
    - `/setprivacy` 用於群組可見性行為

  </Accordion>
</AccordionGroup>

## 存取控制與啟用

<Tabs>
  <Tab title="私訊原則">
    `channels.telegram.dmPolicy` 控制直接私訊的存取權限：

    - `pairing` (預設)
    - `allowlist` (允許清單)
    - `open` (開放，需在 `allowFrom` 中包含 `"*"` )
    - `disabled` (已停用)

    `channels.telegram.allowFrom` 接受數值 ID 與使用者名稱。支援 `telegram:` / `tg:` 前綴並會自動正規化。

    ### 尋找您的 Telegram 使用者 ID

    較安全的方法（不使用第三方機器人）：

    1. 私訊您的機器人。
    2. 執行 `openclaw logs --follow`。
    3. 查看 `from.id`。

    官方 Bot API 方法：

```bash
curl "https://api.telegram.org/bot<bot_token>/getUpdates"
```

    第三方方法（隱私性較低）：`@userinfobot` 或 `@getidsbot`。

  </Tab>

  <Tab title="群組原則與允許清單">
    有兩個獨立的控制項：

    1. **允許哪些群組** (`channels.telegram.groups`)
       - 未設定 `groups`：允許所有群組
       - 已設定 `groups`：作為允許清單運作（明確的 ID 或 `"*"`）

    2. **群組中允許哪些發送者** (`channels.telegram.groupPolicy`)
       - `open`
       - `allowlist` (預設)
       - `disabled`

    `groupAllowFrom` 用於群組發送者過濾。若未設定，Telegram 會回退使用 `allowFrom`。

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
    群組回覆預設需要提及 (mention)。

    提及可以來自：

    - 原生的 `@botusername` 提及，或
    - 以下位置的提及模式：
      - `agents.list[].groupChat.mentionPatterns`
      - `messages.groupChat.mentionPatterns`

    工作階段層級的指令切換：

    - `/activation always`
    - `/activation mention`

    這些僅會更新工作階段狀態。若要持久化，請使用設定檔。

    持久化設定範例：

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

    獲取群組聊天 ID：

    - 將群組訊息轉傳給 `@userinfobot` / `@getidsbot`
    - 或從 `openclaw logs --follow` 讀取 `chat.id`
    - 或檢查 Bot API 的 `getUpdates`

  </Tab>
</Tabs>

## 執行階段行為

- Telegram 由 Gateway 程序所擁有。
- 路由是確定性的：Telegram 的入站訊息會回覆至 Telegram（模型不會自行挑選頻道）。
- 入站訊息會正規化為共享頻道封包，包含回覆詮釋資料與媒體佔位符。
- 群組工作階段依群組 ID 隔離。論壇主題會附加 `:topic:<threadId>` 以保持主題隔離。
- 私訊訊息可以攜帶 `message_thread_id`；OpenClaw 會使用感知執行緒的工作階段金鑰進行路由，並為回覆保留執行緒 ID。
- 長輪詢使用具有各別聊天/執行緒定序功能的 grammY runner。整體 runner sink 的並行數使用 `agents.defaults.maxConcurrent`。
- Telegram Bot API 不支援已讀標記（不適用 `sendReadReceipts`）。

## 功能參考

<AccordionGroup>
  <Accordion title="Telegram 私訊中的草稿串流傳輸">
    OpenClaw 可以透過 Telegram 草稿泡泡 (`sendMessageDraft`) 串流傳輸部分回覆。

    需求：

    - `channels.telegram.streamMode` 不為 `"off"`（預設為 `"partial"`）
    - 私人對話
    - 入站更新包含 `message_thread_id`
    - 已啟用機器人主題 (`getMe().has_topics_enabled`)

    模式：

    - `off`：無草稿串流
    - `partial`：根據部分文字頻繁更新草稿
    - `block`：使用 `channels.telegram.draftChunk` 進行分塊草稿更新

    區塊模式的 `draftChunk` 預設值：

    - `minChars: 200`
    - `maxChars: 800`
    - `breakPreference: "paragraph"`

    `maxChars` 受限於 `channels.telegram.textChunkLimit`。

    草稿串流僅適用於私訊；群組/頻道不使用草稿泡泡。

    如果您想要早期的真實 Telegram 訊息而非草稿更新，請使用區塊串流傳輸 (`channels.telegram.blockStreaming: true`)。

    僅限 Telegram 的推理串流：

    - `/reasoning stream` 會在產生時將推理過程發送至草稿泡泡
    - 最終答案發送時不含推理文字

  </Accordion>

  <Accordion title="格式化與 HTML 回退">
    出站文字使用 Telegram `parse_mode: "HTML"`。

    - 類 Markdown 文字會渲染為 Telegram 安全的 HTML。
    - 原始模型 HTML 會進行轉義以減少 Telegram 解析失敗。
    - 若 Telegram 拒絕解析 HTML，OpenClaw 會以純文字重試。

    連結預覽預設啟用，可透過 `channels.telegram.linkPreview: false` 停用。

  </Accordion>

  <Accordion title="原生指令與自訂指令">
    Telegram 指令選單註冊會在啟動時透過 `setMyCommands` 處理。

    原生指令預設值：

    - `commands.native: "auto"` 為 Telegram 啟用原生指令

    加入自訂指令選單項目：

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git 備份" },
        { command: "generate", description: "建立圖片" },
      ],
    },
  },
}
```

    規則：

    - 名稱會正規化（去除前導 `/`，改為小寫）
    - 有效模式：`a-z`, `0-9`, `_`，長度 `1..32`
    - 自訂指令不能覆蓋原生指令
    - 衝突/重複項將被跳過並記錄日誌

    注意：

    - 自訂指令僅為選單項目；它們不會自動實作行為
    - 外掛程式/Skills 指令在輸入時仍可運作，即使未顯示在 Telegram 選單中

    若原生指令已停用，內建指令會被移除。自訂/外掛程式指令若有設定仍可註冊。

    常見設定失敗：

    - `setMyCommands failed` 通常表示前往 `api.telegram.org` 的出站 DNS/HTTPS 被阻擋。

    ### 裝置配對指令 (`device-pair` 外掛程式)

    安裝 `device-pair` 外掛程式後：

    1. `/pair` 產生設定碼
    2. 將代碼貼上至 iOS 應用程式
    3. `/pair approve` 核准最新的待處理請求

    更多詳情：[配對](/channels/pairing#pair-via-telegram-recommended-for-ios)。

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

    各別帳號覆蓋：

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

    - `off`
    - `dm`
    - `group`
    - `all`
    - `allowlist` (預設)

    舊版 `capabilities: ["inlineButtons"]` 會對應至 `inlineButtons: "all"`。

    訊息操作範例：

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "請選擇一個選項：",
  buttons: [
    [
      { text: "是", callback_data: "yes" },
      { text: "否", callback_data: "no" },
    ],
    [{ text: "取消", callback_data: "cancel" }],
  ],
}
```

    回呼 (Callback) 點擊會以文字形式傳遞給智慧代理：
    `callback_data: <value>`

  </Accordion>

  <Accordion title="智慧代理與自動化的 Telegram 訊息操作">
    Telegram 工具操作包括：

    - `sendMessage` (`to`, `content`, 選填 `mediaUrl`, `replyToMessageId`, `messageThreadId`)
    - `react` (`chatId`, `messageId`, `emoji`)
    - `deleteMessage` (`chatId`, `messageId`)
    - `editMessage` (`chatId`, `messageId`, `content`)

    頻道訊息操作提供了符合直覺的別名 (`send`, `react`, `delete`, `edit`, `sticker`, `sticker-search`)。

    閘控控制：

    - `channels.telegram.actions.sendMessage`
    - `channels.telegram.actions.editMessage`
    - `channels.telegram.actions.deleteMessage`
    - `channels.telegram.actions.reactions`
    - `channels.telegram.actions.sticker` (預設：已停用)

    表情符號回應移除語義：[/tools/reactions](/tools/reactions)

  </Accordion>

  <Accordion title="回覆執行緒標籤">
    Telegram 在產生的輸出中支援明確的回覆執行緒標籤：

    - `[[reply_to_current]]` 回覆引發觸發的訊息
    - `[[reply_to:<id>]]` 回覆特定的 Telegram 訊息 ID

    `channels.telegram.replyToMode` 控制處理方式：

    - `first` (預設)
    - `all`
    - `off`

  </Accordion>

  <Accordion title="論壇主題與執行緒行為">
    論壇超級群組 (Forum supergroups)：

    - 主題工作階段金鑰會附加 `:topic:<threadId>`
    - 回覆與輸入狀態會針對該主題執行緒
    - 主題設定路徑：
      `channels.telegram.groups.<chatId>.topics.<threadId>`

    一般主題 (`threadId=1`) 特殊情況：

    - 發送訊息時會省略 `message_thread_id`（Telegram 會拒絕 `sendMessage(...thread_id=1)`）
    - 輸入動作仍會包含 `message_thread_id`

    主題繼承：主題條目會繼承群組設定，除非被覆蓋 (`requireMention`, `allowFrom`, `skills`, `systemPrompt`, `enabled`, `groupPolicy`)。

    範本上下文包含：

    - `MessageThreadId`
    - `IsForum`

    私訊執行緒行為：

    - 帶有 `message_thread_id` 的私人對話會保留私訊路由，但使用感知執行緒的工作階段金鑰/回覆目標。

  </Accordion>

  <Accordion title="音訊、影片與貼圖">
    ### 音訊訊息

    Telegram 會區分語音訊息與音訊檔案。

    - 預設：音訊檔案行為
    - 在智慧代理回覆中使用標籤 `[[audio_as_voice]]` 以強制發送語音訊息

    訊息操作範例：

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

    Telegram 會區分影片檔案與影片訊息 (video notes)。

    訊息操作範例：

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/video.mp4",
  asVideoNote: true,
}
```

    影片訊息不支援說明文字 (caption)；提供的訊息文字會分開傳送。

    ### 貼圖

    入站貼圖處理：

    - 靜態 WEBP：下載並處理（佔位符 `<media:sticker>`）
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

    貼圖會被描述一次（若可行）並快取，以減少重複的視覺模型呼叫。

    啟用貼圖操作：

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

    發送貼圖操作：

```json55
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

    搜尋快取的貼圖：

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

  </Accordion>

  <Accordion title="表情符號回應通知">
    Telegram 表情符號回應會以 `message_reaction` 更新的形式送達（與訊息負載分開）。

    啟用時，OpenClaw 會將系統事件加入佇列，例如：

    - `Telegram reaction added: 👍 by Alice (@alice) on msg 42`

    設定：

    - `channels.telegram.reactionNotifications`: `off | own | all` (預設：`own`)
    - `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` (預設：`minimal`)

    注意：

    - `own` 表示僅通知使用者對機器人發送之訊息的回應（透過發送訊息快取盡力達成）。
    - Telegram 在表情符號回應更新中不提供執行緒 ID。
      - 非論壇群組會路由至群組對話工作階段
      - 論壇群組會路由至群組的一般主題工作階段 (`:topic:1`)，而非確切的出發主題

    輪詢/Webhook 的 `allowed_updates` 會自動包含 `message_reaction`。

  </Accordion>

  <Accordion title="從 Telegram 事件與指令進行設定寫入">
    頻道設定寫入預設為啟用 (`configWrites !== false`)。

    由 Telegram 觸發的寫入包括：

    - 群組遷移事件 (`migrate_to_chat_id`) 用於更新 `channels.telegram.groups`
    - `/config set` 與 `/config unset`（需要啟用指令功能）

    停用方式：

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

  <Accordion title="長輪詢 vs Webhook">
    預設值：長輪詢 (Long polling)。

    Webhook 模式：

    - 設定 `channels.telegram.webhookUrl`
    - 設定 `channels.telegram.webhookSecret`（設定 Webhook URL 時必填）
    - 選填 `channels.telegram.webhookPath`（預設為 `/telegram-webhook`）
    - 選填 `channels.telegram.webhookHost`（預設為 `127.0.0.1`）

    Webhook 模式的預設本地監聽器會綁定至 `127.0.0.1:8787`。

    若您的公開端點不同，請在其前方放置反向代理，並將 `webhookUrl` 指向公開 URL。
    當您確定需要外部進入時，請設定 `webhookHost`（例如 `0.0.0.0`）。

  </Accordion>

  <Accordion title="限制、重試與 CLI 目標">
    - `channels.telegram.textChunkLimit` 預設值為 4000。
    - `channels.telegram.chunkMode="newline"` 在長度分割前偏好段落邊界（空白行）。
    - `channels.telegram.mediaMaxMb`（預設為 5）限制入站 Telegram 媒體下載/處理的大小。
    - `channels.telegram.timeoutSeconds` 覆蓋 Telegram API 客戶端超時（若未設定，則套用 grammY 預設值）。
    - 群組上下文歷史紀錄使用 `channels.telegram.historyLimit` 或 `messages.groupChat.historyLimit`（預設為 50）；`0` 表示停用。
    - 私訊歷史紀錄控制：
      - `channels.telegram.dmHistoryLimit`
      - `channels.telegram.dms["<user_id>"].historyLimit`
    - 出站 Telegram API 重試可透過 `channels.telegram.retry` 設定。

    CLI 發送目標可以是數值聊天 ID 或使用者名稱：

```bash
openclaw message send --channel telegram --target 123456789 --message "hi"
openclaw message send --channel telegram --target @name --message "hi"
```

  </Accordion>
</AccordionGroup>

## 疑難排解

<AccordionGroup>
  <Accordion title="機器人未回應非提及的群組訊息">

    - 若 `requireMention=false`，Telegram 隱私模式必須允許完整可見性。
      - BotFather: `/setprivacy` -> Disable
      - 然後在群組中移除並重新加入機器人
    - 當設定預期接收未提及的群組訊息時，`openclaw channels status` 會發出警告。
    - `openclaw channels status --probe` 可以檢查明確的數值群組 ID；萬用字元 `"*"` 無法進行成員探測。
    - 快速工作階段測試：`/activation always`。

  </Accordion>

  <Accordion title="機器人完全看不到群組訊息">

    - 當 `channels.telegram.groups` 存在時，群組必須列在其中（或包含 `"*"`）
    - 確認機器人在群組中的成員身份
    - 檢視日誌：`openclaw logs --follow` 以了解跳過原因

  </Accordion>

  <Accordion title="指令部分運作或完全不運作">

    - 授權您的發送者身份（配對及/或 `allowFrom`）
    - 指令授權即使在群組原則為 `open` 時仍然適用
    - `setMyCommands failed` 通常表示前往 `api.telegram.org` 的 DNS/HTTPS 連線問題

  </Accordion>

  <Accordion title="輪詢或網路不穩定">

    - Node 22+ 搭配自訂 fetch/proxy 可能會在 AbortSignal 類型不匹配時觸發立即中止行為。
    - 部分主機會優先解析 `api.telegram.org` 為 IPv6；損壞的 IPv6 出站連線可能導致間歇性的 Telegram API 失敗。
    - 驗證 DNS 回應：

```bash
dig +short api.telegram.org A
dig +short api.telegram.org AAAA
```

  </Accordion>
</AccordionGroup>

更多說明：[頻道疑難排解](/channels/troubleshooting)。

## Telegram 設定參考指引

主要參考：

- `channels.telegram.enabled`: 啟用/停用頻道啟動。
- `channels.telegram.botToken`: 機器人權杖 (BotFather)。
- `channels.telegram.tokenFile`: 從檔案路徑讀取權杖。
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled` (預設：pairing)。
- `channels.telegram.allowFrom`: 私訊允許清單 (ID/使用者名稱)。`open` 需要包含 `"*"`。
- `channels.telegram.groupPolicy`: `open | allowlist | disabled` (預設：allowlist)。
- `channels.telegram.groupAllowFrom`: 群組發送者允許清單 (ID/使用者名稱)。
- `channels.telegram.groups`: 各別群組預設值 + 允許清單（使用 `"*"` 作為全域預設值）。
  - `channels.telegram.groups.<id>.groupPolicy`: 群組原則的各別覆蓋 (`open | allowlist | disabled`)。
  - `channels.telegram.groups.<id>.requireMention`: 提及閘控預設值。
  - `channels.telegram.groups.<id>.skills`: Skills 過濾（省略 = 所有 Skills，空白 = 無）。
  - `channels.telegram.groups.<id>.allowFrom`: 各別群組發送者允許清單覆蓋。
  - `channels.telegram.groups.<id>.systemPrompt`: 群組的額外系統提示詞。
  - `channels.telegram.groups.<id>.enabled`: 為 `false` 時停用該群組。
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: 各別主題覆蓋（與群組欄位相同）。
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: 各別主題的群組原則覆蓋 (`open | allowlist | disabled`)。
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: 各別主題提及閘控覆蓋。
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist` (預設：allowlist)。
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: 各別帳號覆蓋。
- `channels.telegram.replyToMode`: `off | first | all` (預設：`first`)。
- `channels.telegram.textChunkLimit`: 出站分塊大小（字元數）。
- `channels.telegram.chunkMode`: `length` (預設) 或 `newline`（在長度分塊前依空白行/段落邊界拆分）。
- `channels.telegram.linkPreview`: 切換出站訊息的連結預覽（預設：true）。
- `channels.telegram.streamMode`: `off | partial | block` (草稿串流傳輸)。
- `channels.telegram.mediaMaxMb`: 入站/出站媒體大小上限 (MB)。
- `channels.telegram.retry`: 出站 Telegram API 呼叫的重試原則 (attempts, minDelayMs, maxDelayMs, jitter)。
- `channels.telegram.network.autoSelectFamily`: 覆蓋 Node 的 autoSelectFamily (true=啟用, false=停用)。在 Node 22 上預設為停用以避免 Happy Eyeballs 超時。
- `channels.telegram.proxy`: Bot API 呼叫的代理 URL (SOCKS/HTTP)。
- `channels.telegram.webhookUrl`: 啟用 Webhook 模式（需要 `channels.telegram.webhookSecret`）。
- `channels.telegram.webhookSecret`: Webhook 密鑰（設定 webhookUrl 時必填）。
- `channels.telegram.webhookPath`: 本地 Webhook 路徑（預設為 `/telegram-webhook`）。
- `channels.telegram.webhookHost`: 本地 Webhook 綁定主機（預設為 `127.0.0.1`）。
- `channels.telegram.actions.reactions`: 閘控 Telegram 工具表情符號回應。
- `channels.telegram.actions.sendMessage`: 閘控 Telegram 工具訊息發送。
- `channels.telegram.actions.deleteMessage`: 閘控 Telegram 工具訊息刪除。
- `channels.telegram.actions.sticker`: 閘控 Telegram 貼圖操作 — 發送與搜尋（預設：false）。
- `channels.telegram.reactionNotifications`: `off | own | all` — 控制哪些表情符號回應會觸發系統事件（未設定時預設為：`own`）。
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` — 控制智慧代理的表情符號回應能力（未設定時預設為：`minimal`）。

- [設定參考 - Telegram](/gateway/configuration-reference#telegram)

Telegram 特有的高關注欄位：

- 啟動/驗證：`enabled`, `botToken`, `tokenFile`, `accounts.*`
- 存取控制：`dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`, `groups.*.topics.*`
- 指令/選單：`commands.native`, `customCommands`
- 執行緒/回覆：`replyToMode`
- 串流傳輸：`streamMode`, `draftChunk`, `blockStreaming`
- 格式化/傳送：`textChunkLimit`, `chunkMode`, `linkPreview`, `responsePrefix`
- 媒體/網路：`mediaMaxMb`, `timeoutSeconds`, `retry`, `network.autoSelectFamily`, `proxy`
- Webhook: `webhookUrl`, `webhookSecret`, `webhookPath`, `webhookHost`
- 操作/能力：`capabilities.inlineButtons`, `actions.sendMessage|editMessage|deleteMessage|reactions|sticker`
- 表情符號回應：`reactionNotifications`, `reactionLevel`
- 寫入/歷史紀錄：`configWrites`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`

## 相關連結

- [配對](/channels/pairing)
- [頻道路由](/channels/channel-routing)
- [疑難排解](/channels/troubleshooting)
