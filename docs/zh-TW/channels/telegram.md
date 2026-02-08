---
summary: 「Telegram 機器人支援狀態、功能與設定」
read_when:
  - 進行 Telegram 功能或 webhook 相關工作時
title: 「Telegram」
x-i18n:
  source_path: channels/telegram.md
  source_hash: 604e2dc12d2b776d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:24Z
---

# Telegram（Bot API）

狀態：透過 grammY 支援機器人私訊（DM）＋群組，已達可用於正式環境。預設使用長輪詢；可選 webhook。

## 快速設定（新手）

1. 使用 **@BotFather** 建立機器人（[直接連結](https://t.me/BotFather)）。確認帳號名稱完全為 `@BotFather`，然後複製權杖。
2. 設定權杖：
   - 環境變數：`TELEGRAM_BOT_TOKEN=...`
   - 或設定檔：`channels.telegram.botToken: "..."`。
   - 若同時設定，設定檔優先（環境變數僅作為預設帳號的後備）。
3. 啟動 Gateway 閘道器。
4. 私訊（DM）存取預設採用配對；首次聯繫時核准配對碼。

最小設定：

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
    },
  },
}
```

## 內容說明

- 由 Gateway 閘道器擁有的 Telegram Bot API 頻道。
- 決定性路由：回覆會送回 Telegram；模型不會選擇頻道。
- 私訊（DM）共用代理程式的主要工作階段；群組保持隔離（`agent:<agentId>:telegram:group:<chatId>`）。

## 設定（快速路徑）

### 1）建立機器人權杖（BotFather）

1. 開啟 Telegram 並與 **@BotFather** 對話（[直接連結](https://t.me/BotFather)）。確認帳號名稱完全為 `@BotFather`。
2. 執行 `/newbot`，依提示操作（名稱＋以 `bot` 結尾的使用者名稱）。
3. 複製權杖並妥善保存。

可選的 BotFather 設定：

- `/setjoingroups` — 允許／禁止將機器人加入群組。
- `/setprivacy` — 控制機器人是否能看到所有群組訊息。

### 2）設定權杖（環境變數或設定檔）

範例：

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

環境變數選項：`TELEGRAM_BOT_TOKEN=...`（適用於預設帳號）。
若同時設定環境變數與設定檔，設定檔優先。

多帳號支援：使用 `channels.telegram.accounts` 搭配每個帳號的權杖，並可選擇 `name`。共用模式請參考 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts)。

3. 啟動 Gateway 閘道器。當解析到權杖時（設定檔優先，環境變數後備）Telegram 即會啟動。
4. 私訊（DM）存取預設為配對。首次聯繫機器人時核准配對碼。
5. 群組：加入機器人，決定隱私／管理員行為（如下），然後設定 `channels.telegram.groups` 以控制提及（mention）閘控與允許清單。

## 權杖＋隱私＋權限（Telegram 端）

### 權杖建立（BotFather）

- `/newbot` 會建立機器人並回傳權杖（請保密）。
- 若權杖外洩，請透過 @BotFather 撤銷／重新產生，並更新設定。

### 群組訊息可見性（隱私模式）

Telegram 機器人預設啟用 **隱私模式**，限制其可接收的群組訊息。
若機器人需要看到「所有」群組訊息，有兩種方式：

- 使用 `/setprivacy` 停用隱私模式 **或**
- 將機器人加入為群組 **管理員**（管理員機器人可接收所有訊息）。

**注意：** 切換隱私模式後，Telegram 需要將機器人自每個群組移除並重新加入，變更才會生效。

### 群組權限（管理員權限）

管理員狀態在群組內（Telegram UI）設定。管理員機器人一律會接收所有群組訊息；若需要完整可見性，請使用管理員。

## 運作方式（行為）

- 進站訊息會正規化為共用頻道封裝，包含回覆脈絡與媒體占位符。
- 群組回覆預設需要提及（原生 @mention 或 `agents.list[].groupChat.mentionPatterns`／`messages.groupChat.mentionPatterns`）。
- 多代理程式覆寫：在 `agents.list[].groupChat.mentionPatterns` 設定各代理程式的比對模式。
- 回覆一律路由回相同的 Telegram 聊天。
- 長輪詢使用 grammY runner，依聊天進行序列化；整體並行度由 `agents.defaults.maxConcurrent` 限制。
- Telegram Bot API 不支援已讀回條；不存在 `sendReadReceipts` 選項。

## 草稿串流

OpenClaw 可在 Telegram 私訊（DM）中使用 `sendMessageDraft` 串流部分回覆。

需求：

- 在 @BotFather 為機器人啟用執行緒模式（論壇主題模式）。
- 僅限私人聊天的執行緒（Telegram 會在進站訊息包含 `message_thread_id`）。
- `channels.telegram.streamMode` 不可設為 `"off"`（預設：`"partial"`；`"block"` 會啟用分塊的草稿更新）。

草稿串流僅限私訊；Telegram 不支援在群組或頻道使用。

## 格式（Telegram HTML）

- 對外送出的 Telegram 文字使用 `parse_mode: "HTML"`（Telegram 支援的標籤子集）。
- 類 Markdown 的輸入會轉譯為 **Telegram 安全的 HTML**（粗體／斜體／刪除線／程式碼／連結）；區塊元素會被扁平化為含換行／項目符號的純文字。
- 來自模型的原始 HTML 會被跳脫，以避免 Telegram 解析錯誤。
- 若 Telegram 拒絕 HTML 負載，OpenClaw 會以純文字重試相同訊息。

## 指令（原生＋自訂）

OpenClaw 會在啟動時，將原生指令（如 `/status`、`/reset`、`/model`）註冊到 Telegram 的機器人選單。
你可以透過設定加入自訂指令至選單：

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

## 設定疑難排解（指令）

- 日誌中的 `setMyCommands failed` 通常表示對 `api.telegram.org` 的對外 HTTPS／DNS 被阻擋。
- 若看到 `sendMessage` 或 `sendChatAction` 失敗，請檢查 IPv6 路由與 DNS。

更多協助：[頻道疑難排解](/channels/troubleshooting)。

注意事項：

- 自訂指令僅是 **選單項目**；除非你在其他地方處理，否則 OpenClaw 不會實作其行為。
- 指令名稱會被正規化（移除前導 `/`、轉為小寫），且必須符合 `a-z`、`0-9`、`_`（1–32 字元）。
- 自訂指令 **不可覆寫原生指令**。衝突會被忽略並記錄。
- 若停用 `commands.native`，只會註冊自訂指令（若沒有則清空）。

## 限制

- 對外文字會分塊至 `channels.telegram.textChunkLimit`（預設 4000）。
- 可選的換行分塊：設定 `channels.telegram.chunkMode="newline"`，在長度分塊前先依空白行（段落邊界）分割。
- 媒體下載／上傳上限為 `channels.telegram.mediaMaxMb`（預設 5）。
- Telegram Bot API 請求在 `channels.telegram.timeoutSeconds` 後逾時（透過 grammY 預設 500）。可調低以避免長時間卡住。
- 群組歷史脈絡使用 `channels.telegram.historyLimit`（或 `channels.telegram.accounts.*.historyLimit`），後備為 `messages.groupChat.historyLimit`。設定 `0` 可停用（預設 50）。
- 私訊（DM）歷史可用 `channels.telegram.dmHistoryLimit`（使用者回合）限制；每位使用者可用 `channels.telegram.dms["<user_id>"].historyLimit` 覆寫。

## 群組啟用模式

預設情況下，機器人只會回應群組中的提及（`@botname` 或 `agents.list[].groupChat.mentionPatterns` 中的模式）。要變更此行為：

### 透過設定（建議）

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": { requireMention: false }, // always respond in this group
      },
    },
  },
}
```

**重要：** 設定 `channels.telegram.groups` 會建立 **允許清單** — 僅接受列出的群組（或 `"*"`）。
論壇主題會繼承其父群組的設定（allowFrom、requireMention、skills、prompts），除非你在 `channels.telegram.groups.<groupId>.topics.<topicId>` 下新增每主題覆寫。

允許所有群組且一律回應：

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false }, // all groups, always respond
      },
    },
  },
}
```

對所有群組維持僅提及（預設行為）：

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: true }, // or omit groups entirely
      },
    },
  },
}
```

### 透過指令（工作階段層級）

在群組中傳送：

- `/activation always` — 回應所有訊息
- `/activation mention` — 需要提及（預設）

**注意：** 指令只會更新工作階段狀態。若要跨重新啟動持久化，請使用設定檔。

### 取得群組聊天 ID

將群組中的任一訊息轉傳給 Telegram 上的 `@userinfobot` 或 `@getidsbot`，即可看到聊天 ID（負數，例如 `-1001234567890`）。

**提示：** 取得你自己的使用者 ID，可私訊機器人（它會回覆你的使用者 ID／配對訊息），或在啟用指令後使用 `/whoami`。

**隱私提示：** `@userinfobot` 是第三方機器人。若你偏好，請將機器人加入群組、傳送一則訊息，並使用 `openclaw logs --follow` 讀取 `chat.id`，或使用 Bot API 的 `getUpdates`。

## 設定寫入

預設允許 Telegram 寫入由頻道事件或 `/config set|unset` 觸發的設定更新。

發生於：

- 群組升級為超級群組，Telegram 發出 `migrate_to_chat_id`（聊天 ID 變更）。OpenClaw 可自動遷移 `channels.telegram.groups`。
- 你在 Telegram 聊天中執行 `/config set` 或 `/config unset`（需要 `commands.config: true`）。

停用方式：

```json5
{
  channels: { telegram: { configWrites: false } },
}
```

## 主題（論壇超級群組）

Telegram 論壇主題在每則訊息中包含 `message_thread_id`。OpenClaw：

- 將 `:topic:<threadId>` 附加到 Telegram 群組的工作階段金鑰，使每個主題相互隔離。
- 傳送輸入中指示與回覆時包含 `message_thread_id`，確保回覆留在主題內。
- 一般主題（thread id 為 `1`）較為特殊：送出訊息時會省略 `message_thread_id`（Telegram 會拒絕），但輸入中指示仍會包含。
- 在樣板脈絡中提供 `MessageThreadId`＋`IsForum` 以供路由／樣板使用。
- 可在 `channels.telegram.groups.<chatId>.topics.<threadId>` 下進行主題專屬設定（skills、允許清單、自動回覆、系統提示、停用）。
- 主題設定會繼承群組設定（requireMention、允許清單、skills、prompts、enabled），除非在主題層級覆寫。

私人聊天在某些邊緣情況下也可能包含 `message_thread_id`。OpenClaw 會保持 DM 工作階段金鑰不變，但若存在，回覆／草稿串流仍會使用該 thread id。

## 內嵌按鈕

Telegram 支援含回呼按鈕的內嵌鍵盤。

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

每帳號設定：

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

- `off` — 停用內嵌按鈕
- `dm` — 僅私訊（封鎖群組目標）
- `group` — 僅群組（封鎖私訊目標）
- `all` — 私訊＋群組
- `allowlist` — 私訊＋群組，但僅允許符合 `allowFrom`/`groupAllowFrom` 的寄件者（與控制指令相同規則）

預設：`allowlist`。
舊版：`capabilities: ["inlineButtons"]` = `inlineButtons: "all"`。

### 傳送按鈕

使用訊息工具並帶上 `buttons` 參數：

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

當使用者點擊按鈕時，回呼資料會以以下格式作為訊息傳回代理程式：
`callback_data: value`

### 設定選項

Telegram 功能可在兩個層級設定（以上為物件形式；仍支援舊版字串陣列）：

- `channels.telegram.capabilities`：全域預設功能設定，套用至所有 Telegram 帳號，除非被覆寫。
- `channels.telegram.accounts.<account>.capabilities`：每帳號功能設定，覆寫該帳號的全域預設。

當所有 Telegram 機器人／帳號需要相同行為時，使用全域設定。當不同機器人需要不同行為（例如一個僅處理私訊、另一個允許群組）時，使用每帳號設定。

## 存取控制（私訊＋群組）

### 私訊（DM）存取

- 預設：`channels.telegram.dmPolicy = "pairing"`。未知寄件者會收到配對碼；在核准前訊息會被忽略（配對碼 1 小時後過期）。
- 核准方式：
  - `openclaw pairing list telegram`
  - `openclaw pairing approve telegram <CODE>`
- 配對是 Telegram 私訊的預設權杖交換機制。詳情：[配對](/channels/pairing)
- `channels.telegram.allowFrom` 接受數字使用者 ID（建議）或 `@username` 項目。**不是** 機器人使用者名稱；請使用人類寄件者的 ID。精靈可接受 `@username`，並在可能時解析為數字 ID。

#### 尋找你的 Telegram 使用者 ID

較安全（無第三方機器人）：

1. 啟動 Gateway 閘道器並私訊你的機器人。
2. 執行 `openclaw logs --follow`，並尋找 `from.id`。

替代方案（官方 Bot API）：

1. 私訊你的機器人。
2. 使用你的機器人權杖擷取更新，讀取 `message.from.id`：

   ```bash
   curl "https://api.telegram.org/bot<bot_token>/getUpdates"
   ```

第三方（隱私較低）：

- 私訊 `@userinfobot` 或 `@getidsbot`，使用回傳的使用者 ID。

### 群組存取

兩個彼此獨立的控制：

**1. 允許哪些群組**（透過 `channels.telegram.groups` 的群組允許清單）：

- 沒有 `groups` 設定＝允許所有群組
- 有 `groups` 設定＝僅允許列出的群組或 `"*"`
- 範例：`"groups": { "-1001234567890": {}, "*": {} }` 允許所有群組

**2. 允許哪些寄件者**（透過 `channels.telegram.groupPolicy` 的寄件者過濾）：

- `"open"`＝允許群組內所有寄件者
- `"allowlist"`＝僅允許 `channels.telegram.groupAllowFrom` 中的寄件者
- `"disabled"`＝完全不接受群組訊息
  預設為 `groupPolicy: "allowlist"`（除非你加入 `groupAllowFrom`，否則封鎖）。

多數使用者想要：`groupPolicy: "allowlist"` ＋ `groupAllowFrom` ＋ 在 `channels.telegram.groups` 中列出特定群組

要在特定群組中允許 **任何群組成員** 發言（同時仍限制控制指令只允許已授權寄件者），請設定每群組覆寫：

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

## 長輪詢 vs webhook

- 預設：長輪詢（不需要公開 URL）。
- Webhook 模式：設定 `channels.telegram.webhookUrl` 與 `channels.telegram.webhookSecret`（可選 `channels.telegram.webhookPath`）。
  - 本地監聽器會綁定至 `0.0.0.0:8787`，預設提供 `POST /telegram-webhook`。
  - 若你的公開 URL 不同，請使用反向代理並將 `channels.telegram.webhookUrl` 指向公開端點。

## 回覆串接

Telegram 支援透過標籤進行選擇性的回覆串接：

- `[[reply_to_current]]` —— 回覆觸發的訊息。
- `[[reply_to:<id>]]` —— 回覆指定的訊息 ID。

由 `channels.telegram.replyToMode` 控制：

- `first`（預設）、`all`、`off`。

## 音訊訊息（語音 vs 檔案）

Telegram 會區分 **語音便條**（圓形氣泡）與 **音訊檔案**（中繼資料卡）。
OpenClaw 為了相容性，預設使用音訊檔案。

若要在代理程式回覆中強制使用語音便條氣泡，請在回覆任意位置加入此標籤：

- `[[audio_as_voice]]` — 以語音便條而非檔案傳送音訊。

該標籤會自實際送出的文字中移除。其他頻道會忽略此標籤。

使用訊息工具傳送時，請設定 `asVoice: true`，並提供相容語音的音訊 `media` URL
（存在媒體時，`message` 為可選）：

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

## 貼圖

OpenClaw 支援接收與傳送 Telegram 貼圖，並具備智慧快取。

### 接收貼圖

當使用者傳送貼圖時，OpenClaw 會依貼圖類型處理：

- **靜態貼圖（WEBP）：** 下載並透過視覺能力處理。貼圖會以 `<media:sticker>` 占位符呈現在訊息內容中。
- **動態貼圖（TGS）：** 略過（不支援處理 Lottie 格式）。
- **影片貼圖（WEBM）：** 略過（不支援處理影片格式）。

接收貼圖時可用的樣板脈絡欄位：

- `Sticker` — 物件，包含：
  - `emoji` — 與貼圖關聯的表情符號
  - `setName` — 貼圖集名稱
  - `fileId` — Telegram 檔案 ID（可送回相同貼圖）
  - `fileUniqueId` — 用於快取查詢的穩定 ID
  - `cachedDescription` — 可用時的快取視覺描述

### 貼圖快取

貼圖會透過 AI 的視覺能力產生描述。由於相同貼圖常被重複傳送，OpenClaw 會快取這些描述以避免重複的 API 呼叫。

**運作方式：**

1. **首次遇到：** 將貼圖影像送至 AI 進行視覺分析，產生描述（例如：「一隻熱情揮手的卡通貓」）。
2. **快取儲存：** 將描述與貼圖的檔案 ID、表情符號與貼圖集名稱一併保存。
3. **再次遇到：** 再次看到相同貼圖時，直接使用快取描述，不再將影像送至 AI。

**快取位置：** `~/.openclaw/telegram/sticker-cache.json`

**快取項目格式：**

```json
{
  "fileId": "CAACAgIAAxkBAAI...",
  "fileUniqueId": "AgADBAADb6cxG2Y",
  "emoji": "👋",
  "setName": "CoolCats",
  "description": "A cartoon cat waving enthusiastically",
  "cachedAt": "2026-01-15T10:30:00.000Z"
}
```

**效益：**

- 避免對相同貼圖重複呼叫視覺 API，降低成本
- 快取貼圖回應更快（無視覺處理延遲）
- 可依快取描述進行貼圖搜尋

快取會在接收貼圖時自動填充，無需手動管理。

### 傳送貼圖

代理程式可使用 `sticker` 與 `sticker-search` 動作來傳送與搜尋貼圖。這些功能預設停用，需在設定中啟用：

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

**傳送貼圖：**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

參數：

- `fileId`（必填）— 貼圖的 Telegram 檔案 ID。可在接收貼圖時從 `Sticker.fileId` 取得，或來自 `sticker-search` 的搜尋結果。
- `replyTo`（選填）— 要回覆的訊息 ID。
- `threadId`（選填）— 論壇主題的訊息執行緒 ID。

**搜尋貼圖：**

代理程式可依描述、表情符號或貼圖集名稱搜尋快取貼圖：

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

回傳快取中符合的貼圖：

```json5
{
  ok: true,
  count: 2,
  stickers: [
    {
      fileId: "CAACAgIAAxkBAAI...",
      emoji: "👋",
      description: "A cartoon cat waving enthusiastically",
      setName: "CoolCats",
    },
  ],
}
```

搜尋會在描述文字、表情符號字元與貼圖集名稱上進行模糊比對。

**含執行緒的範例：**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "-1001234567890",
  fileId: "CAACAgIAAxkBAAI...",
  replyTo: 42,
  threadId: 123,
}
```

## 串流（草稿）

Telegram 可在代理程式產生回覆時串流 **草稿氣泡**。
OpenClaw 使用 Bot API 的 `sendMessageDraft`（非實際訊息），並在完成後以一般訊息送出最終回覆。

需求（Telegram Bot API 9.3+）：

- **啟用主題的私人聊天**（為機器人啟用論壇主題模式）。
- 進站訊息必須包含 `message_thread_id`（私人主題執行緒）。
- 群組／超級群組／頻道會忽略串流。

設定：

- `channels.telegram.streamMode: "off" | "partial" | "block"`（預設：`partial`）
  - `partial`：以最新串流文字更新草稿氣泡。
  - `block`：以較大區塊（分塊）更新草稿氣泡。
  - `off`：停用草稿串流。
- 可選（僅適用於 `streamMode: "block"`）：
  - `channels.telegram.draftChunk: { minChars?, maxChars?, breakPreference? }`
    - 預設：`minChars: 200`、`maxChars: 800`、`breakPreference: "paragraph"`（限制至 `channels.telegram.textChunkLimit`）。

注意：草稿串流與 **區塊串流**（頻道訊息）是不同機制。
區塊串流預設關閉；若你想要提早送出 Telegram 訊息而非草稿更新，需設定 `channels.telegram.blockStreaming: true`。

推理串流（僅 Telegram）：

- `/reasoning stream` 會在產生回覆期間，將推理內容串流至草稿氣泡，完成後再送出不含推理的最終答案。
- 若 `channels.telegram.streamMode` 為 `off`，則停用推理串流。
  更多背景：[串流＋分塊](/concepts/streaming)。

## 重試策略

對外的 Telegram API 呼叫在暫時性網路／429 錯誤時，會以指數退避與抖動重試。透過 `channels.telegram.retry` 設定。請參閱 [重試策略](/concepts/retry)。

## 代理程式工具（訊息＋反應）

- 工具：`telegram`，包含 `sendMessage` 動作（`to`、`content`，選填 `mediaUrl`、`replyToMessageId`、`messageThreadId`）。
- 工具：`telegram`，包含 `react` 動作（`chatId`、`messageId`、`emoji`）。
- 工具：`telegram`，包含 `deleteMessage` 動作（`chatId`、`messageId`）。
- 反應移除語意：請參閱 [/tools/reactions](/tools/reactions)。
- 工具閘控：`channels.telegram.actions.reactions`、`channels.telegram.actions.sendMessage`、`channels.telegram.actions.deleteMessage`（預設：啟用），以及 `channels.telegram.actions.sticker`（預設：停用）。

## 反應通知

**反應的運作方式：**
Telegram 的反應會以 **獨立的 `message_reaction` 事件** 到達，而非訊息負載中的屬性。當使用者加入反應時，OpenClaw 會：

1. 從 Telegram API 接收 `message_reaction` 更新
2. 轉換為 **系統事件**，格式為：`"Telegram reaction added: {emoji} by {user} on msg {id}"`
3. 使用與一般訊息 **相同的工作階段金鑰** 將系統事件入列
4. 當該對話的下一則訊息到達時，系統事件會被清空並前置到代理程式的脈絡中

代理程式會在對話歷史中以 **系統通知** 看到反應，而非訊息中繼資料。

**設定：**

- `channels.telegram.reactionNotifications`：控制哪些反應會觸發通知
  - `"off"` — 忽略所有反應
  - `"own"` — 使用者對機器人訊息反應時通知（盡力而為；僅記憶體）（預設）
  - `"all"` — 對所有反應通知

- `channels.telegram.reactionLevel`：控制代理程式的反應能力
  - `"off"` — 代理程式不可對訊息反應
  - `"ack"` — 機器人傳送確認反應（處理中顯示 👀）（預設）
  - `"minimal"` — 代理程式可節制地反應（建議：每 5–10 次交流 1 次）
  - `"extensive"` — 代理程式可在適當時機較為頻繁地反應

**論壇群組：** 論壇群組中的反應會包含 `message_thread_id`，並使用如 `agent:main:telegram:group:{chatId}:topic:{threadId}` 的工作階段金鑰，確保同一主題內的反應與訊息保持一致。

**設定範例：**

```json5
{
  channels: {
    telegram: {
      reactionNotifications: "all", // See all reactions
      reactionLevel: "minimal", // Agent can react sparingly
    },
  },
}
```

**需求：**

- Telegram 機器人必須在 `allowed_updates` 中明確請求 `message_reaction`（OpenClaw 會自動設定）
- Webhook 模式下，反應包含於 webhook 的 `allowed_updates`
- 輪詢模式下，反應包含於 `getUpdates` 的 `allowed_updates`

## 傳送目標（CLI／排程）

- 使用聊天 ID（`123456789`）或使用者名稱（`@name`）作為目標。
- 範例：`openclaw message send --channel telegram --target 123456789 --message "hi"`。

## 疑難排解

**機器人在群組中對非提及訊息沒有回應：**

- 若你設定了 `channels.telegram.groups.*.requireMention=false`，必須停用 Telegram Bot API 的 **隱私模式**。
  - BotFather：`/setprivacy` → **Disable**（之後將機器人移除並重新加入群組）
- 當設定預期接收未提及的群組訊息時，`openclaw channels status` 會顯示警告。
- `openclaw channels status --probe` 可額外檢查明確的數字群組 ID 成員資格（無法稽核萬用字元 `"*"` 規則）。
- 快速測試：`/activation always`（僅限工作階段；持久化請用設定檔）

**機器人完全看不到群組訊息：**

- 若設定了 `channels.telegram.groups`，群組必須被列出或使用 `"*"`
- 檢查 @BotFather 的隱私設定 →「Group Privacy」應為 **OFF**
- 確認機器人確實是成員（而非僅為沒有讀取權限的管理員）
- 檢查 Gateway 閘道器日誌：`openclaw logs --follow`（尋找「skipping group message」）

**機器人會回應提及，但不回應 `/activation always`：**

- `/activation` 指令只更新工作階段狀態，並不寫回設定
- 若要持久化，請將群組加入 `channels.telegram.groups`，並設定 `requireMention: false`

**像 `/status` 的指令無法運作：**

- 確認你的 Telegram 使用者 ID 已被授權（透過配對或 `channels.telegram.allowFrom`）
- 即使群組設定了 `groupPolicy: "open"`，指令仍需要授權

**在 Node 22+ 上長輪詢立即中止（常見於代理／自訂 fetch）：**

- Node 22+ 對 `AbortSignal` 實例更為嚴格；外來的 signal 可能會立即中止 `fetch` 呼叫。
- 升級至會正規化 abort signals 的 OpenClaw 版本，或在可升級前改用 Node 20 執行 Gateway 閘道器。

**機器人啟動後靜默停止回應（或記錄 `HttpError: Network request ... failed`）：**

- 某些主機會優先將 `api.telegram.org` 解析為 IPv6。若你的伺服器沒有可用的 IPv6 對外連線，grammY 可能卡在僅 IPv6 的請求。
- 解法：啟用 IPv6 對外連線 **或** 強制 `api.telegram.org` 走 IPv4（例如加入使用 IPv4 A 記錄的 `/etc/hosts`，或在作業系統 DNS 堆疊中偏好 IPv4），然後重新啟動 Gateway 閘道器。
- 快速檢查：`dig +short api.telegram.org A` 與 `dig +short api.telegram.org AAAA`，確認 DNS 回傳內容。

## 設定參考（Telegram）

完整設定：[設定](/gateway/configuration)

提供者選項：

- `channels.telegram.enabled`：啟用／停用頻道啟動。
- `channels.telegram.botToken`：機器人權杖（BotFather）。
- `channels.telegram.tokenFile`：從檔案路徑讀取權杖。
- `channels.telegram.dmPolicy`：`pairing | allowlist | open | disabled`（預設：配對）。
- `channels.telegram.allowFrom`：私訊允許清單（ID／使用者名稱）。`open` 需要 `"*"`。
- `channels.telegram.groupPolicy`：`open | allowlist | disabled`（預設：允許清單）。
- `channels.telegram.groupAllowFrom`：群組寄件者允許清單（ID／使用者名稱）。
- `channels.telegram.groups`：每群組預設值＋允許清單（全域預設請用 `"*"`）。
  - `channels.telegram.groups.<id>.groupPolicy`：群組層級覆寫 groupPolicy（`open | allowlist | disabled`）。
  - `channels.telegram.groups.<id>.requireMention`：提及閘控預設。
  - `channels.telegram.groups.<id>.skills`：skill 篩選（省略＝所有 skills，空白＝無）。
  - `channels.telegram.groups.<id>.allowFrom`：每群組寄件者允許清單覆寫。
  - `channels.telegram.groups.<id>.systemPrompt`：群組的額外系統提示。
  - `channels.telegram.groups.<id>.enabled`：當 `false` 時停用群組。
  - `channels.telegram.groups.<id>.topics.<threadId>.*`：每主題覆寫（欄位與群組相同）。
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`：每主題覆寫 groupPolicy（`open | allowlist | disabled`）。
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`：每主題提及閘控覆寫。
- `channels.telegram.capabilities.inlineButtons`：`off | dm | group | all | allowlist`（預設：允許清單）。
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`：每帳號覆寫。
- `channels.telegram.replyToMode`：`off | first | all`（預設：`first`）。
- `channels.telegram.textChunkLimit`：對外分塊大小（字元）。
- `channels.telegram.chunkMode`：`length`（預設）或 `newline`，在長度分塊前先依空白行（段落邊界）分割。
- `channels.telegram.linkPreview`：切換對外訊息的連結預覽（預設：true）。
- `channels.telegram.streamMode`：`off | partial | block`（草稿串流）。
- `channels.telegram.mediaMaxMb`：進站／對外媒體上限（MB）。
- `channels.telegram.retry`：對外 Telegram API 呼叫的重試策略（次數、minDelayMs、maxDelayMs、jitter）。
- `channels.telegram.network.autoSelectFamily`：覆寫 Node 的 autoSelectFamily（true＝啟用，false＝停用）。Node 22 預設停用以避免 Happy Eyeballs 逾時。
- `channels.telegram.proxy`：Bot API 呼叫的代理 URL（SOCKS／HTTP）。
- `channels.telegram.webhookUrl`：啟用 webhook 模式（需要 `channels.telegram.webhookSecret`）。
- `channels.telegram.webhookSecret`：webhook 密鑰（設定 webhookUrl 時必填）。
- `channels.telegram.webhookPath`：本地 webhook 路徑（預設 `/telegram-webhook`）。
- `channels.telegram.actions.reactions`：閘控 Telegram 工具反應。
- `channels.telegram.actions.sendMessage`：閘控 Telegram 工具訊息傳送。
- `channels.telegram.actions.deleteMessage`：閘控 Telegram 工具訊息刪除。
- `channels.telegram.actions.sticker`：閘控 Telegram 貼圖動作 — 傳送與搜尋（預設：false）。
- `channels.telegram.reactionNotifications`：`off | own | all` — 控制哪些反應會觸發系統事件（未設定時預設：`own`）。
- `channels.telegram.reactionLevel`：`off | ack | minimal | extensive` — 控制代理程式的反應能力（未設定時預設：`minimal`）。

相關的全域選項：

- `agents.list[].groupChat.mentionPatterns`（提及閘控模式）。
- `messages.groupChat.mentionPatterns`（全域後備）。
- `commands.native`（預設為 `"auto"` → Telegram／Discord 開啟、Slack 關閉）、`commands.text`、`commands.useAccessGroups`（指令行為）。可用 `channels.telegram.commands.native` 覆寫。
- `messages.responsePrefix`、`messages.ackReaction`、`messages.ackReactionScope`、`messages.removeAckAfterReply`。
