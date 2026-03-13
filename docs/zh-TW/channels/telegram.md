---
summary: "Telegram bot support status, capabilities, and configuration"
read_when:
  - Working on Telegram features or webhooks
title: Telegram
---

# Telegram (Bot API)

狀態：已準備好在 bot 的私訊和群組中使用 grammY。長輪詢是預設模式；網頁鉤子模式是可選的。

<CardGroup cols={3}>
  <Card title="配對" icon="link" href="/channels/pairing">
    Telegram 的預設 DM 政策是配對。
  </Card>
  <Card title="頻道故障排除" icon="wrench" href="/channels/troubleshooting">
    跨頻道診斷和修復手冊。
  </Card>
  <Card title="閘道設定" icon="settings" href="/gateway/configuration">
    完整的頻道設定範本和範例。
  </Card>
</CardGroup>

## 快速設定

<Steps>
  <Step title="在 BotFather 中創建機器人token">
    打開 Telegram 並與 **@BotFather** 聊天（確認該帳號的名稱完全是 `@BotFather`）。

執行 `/newbot`，按照提示操作，並保存 token。

</Step>

<Step title="設定 token 和 DM 政策">

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

Env fallback: `TELEGRAM_BOT_TOKEN=...` (僅限預設帳戶)。  
Telegram **不** 使用 `openclaw channels login telegram`；請在 config/env 中設定 token，然後啟動網關。

</Step>

<Step title="啟動閘道並批准第一個 DM">

```bash
openclaw gateway
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

配對程式碼在 1 小時後過期。

</Step>

<Step title="將機器人添加到群組">
    將機器人添加到您的群組，然後設置 `channels.telegram.groups` 和 `groupPolicy` 以符合您的訪問模型。
  </Step>
</Steps>

<Note>
Token 解決順序是根據帳戶而定的。實際上，設定值優先於環境回退，而 `TELEGRAM_BOT_TOKEN` 僅適用於預設帳戶。
</Note>

## Telegram 端設定

<AccordionGroup>
  <Accordion title="隱私模式與群組可見性">
    Telegram 機器人預設為 **隱私模式**，這限制了它們接收的群組訊息。

如果機器人必須查看所有群組訊息，則：

- 透過 `/setprivacy` 禁用隱私模式，或
  - 將機器人設為群組管理員。

當切換隱私模式時，請在每個群組中移除並重新添加機器人，以便 Telegram 應用更改。

</Accordion>

<Accordion title="群組權限">
    管理員狀態在 Telegram 群組設定中控制。

管理員機器人會接收所有群組訊息，這對於持續運作的群組行為非常有用。

</Accordion>

<Accordion title="有用的 BotFather 切換選項">

- `/setjoingroups` 以允許/拒絕群組新增
  - `/setprivacy` 用於群組可見性行為

</Accordion>
</AccordionGroup>

## 存取控制與啟用

<Tabs>
  <Tab title="DM 政策">
    `channels.telegram.dmPolicy` 控制直接訊息的存取：

- `pairing` (預設)
  - `allowlist` (需要至少一個發送者 ID 在 `allowFrom`)
  - `open` (需要 `allowFrom` 包含 `"*"`)
  - `disabled`

`channels.telegram.allowFrom` 接受數字的 Telegram 用戶 ID。`telegram:` / `tg:` 前綴被接受並進行標準化。  
`dmPolicy: "allowlist"` 具有空的 `allowFrom` 將阻止所有私訊，並會被設定驗證拒絕。  
入門精靈接受 `@username` 輸入並將其解析為數字 ID。  
如果您已升級且您的設定包含 `@username` 允許清單條目，請執行 `openclaw doctor --fix` 以解析它們（最佳努力；需要 Telegram 機器人 token）。  
如果您之前依賴配對存儲的允許清單檔案，`openclaw doctor --fix` 可以在允許清單流程中恢復條目到 `channels.telegram.allowFrom`（例如當 `dmPolicy: "allowlist"` 尚未有明確的 ID 時）。

對於單一擁有者的機器人，建議使用 `dmPolicy: "allowlist"` 並搭配明確的數字 `allowFrom` ID，以保持存取政策在設定中的持久性（而不是依賴於先前的配對批准）。

### 找到你的 Telegram 使用者 ID

Safer (無第三方機器人)：

1. 私訊你的機器人。
2. 執行 `openclaw logs --follow`。
3. 閱讀 `from.id`。

官方 Bot API 方法：

```bash
curl "https://api.telegram.org/bot<bot_token>/getUpdates"
```

第三方方法（較不私密）：`@userinfobot` 或 `@getidsbot`。

</Tab>

<Tab title="群組政策和允許清單">
    兩個控制項一起適用：

1. **哪些群組被允許** (`channels.telegram.groups`)
   - 無 `groups` 設定：
     - 使用 `groupPolicy: "open"`：任何群組都可以通過群組-ID 檢查
     - 使用 `groupPolicy: "allowlist"`（預設）：群組會被阻擋，直到您添加 `groups` 條目（或 `"*"`）
   - `groups` 已設定：作為允許清單（明確的 ID 或 `"*"`）

2. **哪些發送者在群組中是被允許的** (`channels.telegram.groupPolicy`)
   - `open`
   - `allowlist` (預設)
   - `disabled`

`groupAllowFrom` 用於群組發送者過濾。如果未設置，Telegram 將回退到 `allowFrom`。  
`groupAllowFrom` 條目應為數字 Telegram 用戶 ID (`telegram:` / `tg:` 前綴已標準化)。  
請勿在 `groupAllowFrom` 中放入 Telegram 群組或超級群組聊天 ID。負數聊天 ID 應放在 `channels.telegram.groups` 下。  
非數字條目將被忽略以進行發送者授權。  
安全邊界 (`2026.2.25+`): 群組發送者授權 **不** 繼承 DM 配對存儲的批准。  
配對僅限於 DM。對於群組，請設置 `groupAllowFrom` 或每個群組/每個主題的 `allowFrom`。  
執行時注意：如果 `channels.telegram` 完全缺失，執行時預設為失敗關閉 `groupPolicy="allowlist"`，除非明確設置 `channels.defaults.groupPolicy`。

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

範例：僅允許特定用戶進入一個特定群組：

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          requireMention: true,
          allowFrom: ["8734062810", "745123456"],
        },
      },
    },
  },
}
```

<Warning>
      常見錯誤：`groupAllowFrom` 不是 Telegram 群組允許清單。

- 將負面的 Telegram 群組或超級群組聊天 ID 像 `-1001234567890` 放在 `channels.telegram.groups` 之下。- 當你想限制哪些人在允許的群組內可以觸發機器人時，將 Telegram 使用者 ID 像 `8734062810` 放在 `groupAllowFrom` 之下。- 只有在你希望允許的群組中的任何成員都能與機器人對話時，才使用 `groupAllowFrom: ["*"]`。

</Tab>

<Tab title="提及行為">
    群組回覆預設需要提及。

提及可以來自：

- 原生 `@botusername` 提及，或
  - 在以下模式中提及：
    - `agents.list[].groupChat.mentionPatterns`
    - `messages.groupChat.mentionPatterns`

Session-level command toggles:

- `/activation always`
  - `/activation mention`

這些僅更新會話狀態。請使用設定進行持久化。

[[BLOCK_1]]  
持久化設定範例：  
[[BLOCK_1]]

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

- 將群組訊息轉發至 `@userinfobot` / `@getidsbot`
  - 或從 `chat.id` 讀取 `openclaw logs --follow`
  - 或檢查 Bot API `getUpdates`

</Tab>
</Tabs>

## 執行時行為

- Telegram 由網關過程擁有。
- 路由是確定性的：Telegram 的入站回覆會回到 Telegram（模型不會選擇頻道）。
- 入站消息會標準化為共享頻道信封，並包含回覆元數據和媒體佔位符。
- 群組會話由群組 ID 隔離。論壇主題附加 `:topic:<threadId>` 以保持主題的隔離。
- DM 消息可以攜帶 `message_thread_id`；OpenClaw 使用線程感知的會話金鑰進行路由，並保留回覆的線程 ID。
- 長輪詢使用 grammY runner，並根據每個聊天/每個線程進行排序。整體 runner sink 的併發使用 `agents.defaults.maxConcurrent`。
- Telegram Bot API 不支援已讀回執 (`sendReadReceipts` 不適用)。

## 功能參考

<AccordionGroup>
  <Accordion title="即時串流預覽（訊息編輯）">
    OpenClaw 可以即時串流部分回覆：

- 直接聊天：預覽訊息 + `editMessageText`
  - 群組/主題：預覽訊息 + `editMessageText`

[[BLOCK_1]]

- `channels.telegram.streaming` 是 `off | partial | block | progress`（預設值：`partial`）
  - `progress` 對應到 Telegram 上的 `partial`（與跨通道命名相容）
  - 過去的 `channels.telegram.streamMode` 和布林值 `streaming` 會自動映射

[[BLOCK_1]]

- DM: OpenClaw 保持相同的預覽訊息並在原地進行最終編輯（不會發送第二條訊息）
  - group/topic: OpenClaw 保持相同的預覽訊息並在原地進行最終編輯（不會發送第二條訊息）

對於複雜的回覆（例如媒體有效載荷），OpenClaw 會回退到正常的最終交付，然後清理預覽訊息。

預覽串流與區塊串流是分開的。當區塊串流在 Telegram 中被明確啟用時，OpenClaw 會跳過預覽串流以避免雙重串流。

如果本機草稿傳輸不可用或被拒絕，OpenClaw 會自動回退到 `sendMessage` + `editMessageText`。

[[BLOCK_1]]

- `/reasoning stream` 在生成時將推理發送到即時預覽
  - 最終答案在不包含推理文本的情況下發送

</Accordion>

<Accordion title="格式化與 HTML 回退">
    外發文本使用 Telegram `parse_mode: "HTML"`。

- Markdown 類似的文本會被轉換為 Telegram 安全的 HTML。
  - 原始模型 HTML 會被轉義以減少 Telegram 解析失敗的情況。
  - 如果 Telegram 拒絕解析的 HTML，OpenClaw 會以純文本重新嘗試。

連結預覽預設為啟用狀態，可以透過 `channels.telegram.linkPreview: false` 來禁用。

</Accordion>

<Accordion title="原生指令與自訂指令">
    Telegram 指令選單的註冊在啟動時透過 `setMyCommands` 處理。

原生命令預設值：

- `commands.native: "auto"` 啟用 Telegram 的原生指令

新增自訂命令選單專案：

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

[[BLOCK_1]]

- 名稱已正規化（去除前導 `/`，轉為小寫）
  - 有效模式：`a-z`、`0-9`、`_`，長度 `1..32`
  - 自訂命令無法覆蓋原生命令
  - 衝突/重複項將被跳過並記錄

[[BLOCK_1]]

- 自訂指令僅為選單專案；它們不會自動實現行為
  - 即使未顯示在 Telegram 選單中，插件/技能指令仍然可以正常運作。

如果原生命令被禁用，內建命令將被移除。自訂/插件命令仍然可以在設定的情況下註冊。

常見的設置失敗：

- `setMyCommands failed` 與 `BOT_COMMANDS_TOO_MUCH` 意味著 Telegram 選單在修剪後仍然溢出；請減少插件/技能/自訂命令或禁用 `channels.telegram.commands.native`。
  - `setMyCommands failed` 與網路/擷取錯誤通常意味著對 `api.telegram.org` 的出站 DNS/HTTPS 被阻擋。

### 設備配對指令 (`device-pair` 插件)

當 `device-pair` 外掛安裝完成後：

1. `/pair` 生成設置程式碼
2. 將程式碼粘貼到 iOS 應用程式中
3. `/pair approve` 批准最新的待處理請求

更多細節：[Pairing](/channels/pairing#pair-via-telegram-recommended-for-ios)。

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

每個帳戶的覆蓋：

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

Scopes:

- `off`
  - `dm`
  - `group`
  - `all`
  - `allowlist` (default)

Legacy `capabilities: ["inlineButtons"]` 對應到 `inlineButtons: "all"`。

[[BLOCK_1]]  
訊息動作範例：  
[[BLOCK_1]]

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

回調點擊作為文本傳遞給代理：
`callback_data: <value>`

</Accordion>

<Accordion title="Telegram 訊息操作供代理人和自動化使用">
    Telegram 工具操作包括：

- `sendMessage` (`to`, `content`, optional `mediaUrl`, `replyToMessageId`, `messageThreadId`)
  - `react` (`chatId`, `messageId`, `emoji`)
  - `deleteMessage` (`chatId`, `messageId`)
  - `editMessage` (`chatId`, `messageId`, `content`)
  - `createForumTopic` (`chatId`, `name`, optional `iconColor`, `iconCustomEmojiId`)

Channel message actions 提供了方便的別名 (`send`, `react`, `delete`, `edit`, `sticker`, `sticker-search`, `topic-create`)。

[[BLOCK_1]]

- `channels.telegram.actions.sendMessage`
  - `channels.telegram.actions.deleteMessage`
  - `channels.telegram.actions.reactions`
  - `channels.telegram.actions.sticker` (預設：已禁用)

注意：`edit` 和 `topic-create` 目前預設為啟用，並且沒有單獨的 `channels.telegram.actions.*` 切換開關。  
執行時會使用活動的設定/密鑰快照（啟動/重新加載），因此動作路徑不會在每次發送時進行臨時的 SecretRef 重新解析。

Reaction removal semantics: [/tools/reactions](/tools/reactions)

</Accordion>

<Accordion title="回覆串接標籤">
    Telegram 支援在生成的輸出中使用明確的回覆串接標籤：

- `[[reply_to_current]]` 回覆觸發的訊息
  - `[[reply_to:<id>]]` 回覆特定的 Telegram 訊息 ID

`channels.telegram.replyToMode` 控制處理：

- `off` (預設)
  - `first`
  - `all`

注意：`off` 禁用隱式回覆串接。明確的 `[[reply_to_*]]` 標籤仍然會被遵循。

</Accordion>

<Accordion title="論壇主題與線程行為">
    論壇超級群組：

- 主題會話金鑰附加 `:topic:<threadId>`
  - 回覆和輸入針對主題線程
  - 主題設定路徑：
    `channels.telegram.groups.<chatId>.topics.<threadId>`

General topic (`threadId=1`) special-case:

- 訊息發送省略 `message_thread_id`（Telegram 拒絕 `sendMessage(...thread_id=1)`）
  - 輸入動作仍然包含 `message_thread_id`

主題繼承：主題條目繼承群組設定，除非被覆蓋 (`requireMention`, `allowFrom`, `skills`, `systemPrompt`, `enabled`, `groupPolicy`)。  
`agentId` 是僅限主題的，並不繼承群組的預設設定。

**每個主題的代理路由**：每個主題可以通過在主題設定中設置 `agentId` 來路由到不同的代理。這為每個主題提供了獨立的工作區、記憶體和會話。範例：

````json5
    {
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "1": { agentId: "main" },      // General topic → main agent
                "3": { agentId: "zu" },        // Dev topic → zu agent
                "5": { agentId: "coder" }      // Code review → coder agent
              }
            }
          }
        }
      }
    }
    ```

每個主題都有其自己的會話金鑰：`agent:zu:telegram:group:-1001234567890:topic:3`

**持久性 ACP 主題綁定**：論壇主題可以透過頂層類型的 ACP 綁定來固定 ACP 駕馭會話：

- `bindings[]` 與 `type: "acp"` 以及 `match.channel: "telegram"`

[[BLOCK_1]]
範例：
[[INLINE_1]]

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
            channel: "telegram",
            accountId: "default",
            peer: { kind: "group", id: "-1001234567890:topic:42" },
          },
        },
      ],
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "42": {
                  requireMention: false,
                },
              },
            },
          },
        },
      },
    }
    ```

目前這個範圍限於群組和超級群組中的論壇主題。

**Thread-bound ACP 從聊天中產生**:

- `/acp spawn <agent> --thread here|auto` 可以將當前的 Telegram 主題綁定到新的 ACP 會話。
    - 後續的主題消息將直接路由到綁定的 ACP 會話（不需要 `/acp steer`）。
    - OpenClaw 在成功綁定後會將生成確認消息固定在主題中。
    - 需要 `channels.telegram.threadBindings.spawnAcpSessions=true`。

模板上下文包括：

- `MessageThreadId`
    - `IsForum`

[[BLOCK_1]]
DM 线程行为：
[[BLOCK_1]]

- 與 `message_thread_id` 的私人聊天保持 DM 路由，但使用線程感知的會話金鑰/回覆目標。

</Accordion>

<Accordion title="音訊、影片和貼圖">
    ### 音訊訊息

Telegram 區分語音備忘錄與音訊檔案。

- 預設：音訊檔案行為
    - 標籤 `[[audio_as_voice]]` 在代理回覆中強制發送語音備忘錄

[[BLOCK_1]]
訊息動作範例：
[[BLOCK_1]]

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
````

### Video messages

Telegram 區分影片檔案與影片備忘錄。

[[BLOCK_1]]  
訊息動作範例：  
[[BLOCK_1]]

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/video.mp4",
  asVideoNote: true,
}
```

影片註解不支援字幕；提供的訊息文字將單獨發送。

### Stickers

[[BLOCK_1]]  
進口貼紙處理：  
[[BLOCK_1]]

- 靜態 WEBP: 已下載並處理 (佔位符 `<media:sticker>`)
  - 動畫 TGS: 已跳過
  - 影片 WEBM: 已跳過

Sticker context fields:

- `Sticker.emoji`
  - `Sticker.setName`
  - `Sticker.fileId`
  - `Sticker.fileUniqueId`
  - `Sticker.cachedDescription`

Sticker cache file:

`~/.openclaw/telegram/sticker-cache.json`

貼紙會在可能的情況下被描述一次並快取，以減少重複的視覺調用。

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

發送貼圖動作：

```json5
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

<Accordion title="反應通知">
    Telegram 反應作為 `message_reaction` 更新到達（與訊息有效載荷分開）。

當啟用時，OpenClaw 會排入系統事件，例如：

`Telegram reaction added: 👍 by Alice (@alice) on msg 42`

Config:

- `channels.telegram.reactionNotifications`: `off | own | all` (預設: `own`)
  - `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` (預設: `minimal`)

[[BLOCK_1]]

- `own` 僅指用戶對機器人發送的消息的反應（透過發送消息快取的最佳努力）。
  - 反應事件仍然遵循 Telegram 的存取控制 (`dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`)；未經授權的發送者將被排除。
  - Telegram 在反應更新中不提供主題 ID。
    - 非論壇群組路由至群組聊天會話
    - 論壇群組路由至群組一般主題會話 (`:topic:1`), 而不是確切的來源主題

`allowed_updates` 用於輪詢/webhook 自動包含 `message_reaction`。

</Accordion>

<Accordion title="Ack reactions">
    `ackReaction` 在 OpenClaw 處理進來的訊息時發送一個確認表情符號。

[[BLOCK_1]]  
解析順序：  
[[BLOCK_1]]

- `channels.telegram.accounts.<accountId>.ackReaction`
  - `channels.telegram.ackReaction`
  - `messages.ackReaction`
  - 代理人身份表情符號後備 (`agents.list[].identity.emoji`, 否則 "👀")

[[BLOCK_1]]

- Telegram 期望使用 Unicode 表情符號（例如 "👀"）。
  - 使用 `""` 來禁用頻道或帳戶的反應。

</Accordion>

<Accordion title="來自 Telegram 事件和指令的設定寫入">
    頻道設定寫入預設為啟用 (`configWrites !== false`)。

Telegram 觸發的寫入包括：

- 群組遷移事件 (`migrate_to_chat_id`) 以更新 `channels.telegram.groups`
  - `/config set` 和 `/config unset` （需要啟用命令）

[[BLOCK_1]]

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

<Accordion title="長輪詢與網路鉤子">
    預設：長輪詢。

Webhook 模式:

- 設定 `channels.telegram.webhookUrl`
  - 設定 `channels.telegram.webhookSecret`（當 webhook URL 設定時為必填）
  - 可選 `channels.telegram.webhookPath`（預設值 `/telegram-webhook`）
  - 可選 `channels.telegram.webhookHost`（預設值 `127.0.0.1`）
  - 可選 `channels.telegram.webhookPort`（預設值 `8787`）

預設的本地監聽器在 webhook 模式下綁定到 `127.0.0.1:8787`。

如果您的公共端點不同，請在前面放置一個反向代理，並將 `webhookUrl` 指向公共 URL。當您需要外部進入時，請設置 `webhookHost`（例如 `0.0.0.0`）。

</Accordion>

<Accordion title="限制、重試與 CLI 目標">
    - `channels.telegram.textChunkLimit` 預設為 4000。
    - `channels.telegram.chunkMode="newline"` 在長度拆分之前偏好段落邊界（空行）。
    - `channels.telegram.mediaMaxMb` （預設 100）限制進出 Telegram 媒體大小。
    - `channels.telegram.timeoutSeconds` 覆蓋 Telegram API 用戶端超時（如果未設置，則適用 grammY 預設值）。
    - 群組上下文歷史使用 `channels.telegram.historyLimit` 或 `messages.groupChat.historyLimit` （預設 50）；`0` 禁用。
    - DM 歷史控制：
      - `channels.telegram.dmHistoryLimit`
      - `channels.telegram.dms["<user_id>"].historyLimit`
    - `channels.telegram.retry` 設定適用於 Telegram 發送輔助工具（CLI/工具/動作）以處理可恢復的外發 API 錯誤。

CLI 發送目標可以是數字聊天 ID 或用戶名：

```bash
openclaw message send --channel telegram --target 123456789 --message "hi"
openclaw message send --channel telegram --target @name --message "hi"
```

Telegram 投票使用 `openclaw message poll` 並支援論壇主題：

```bash
openclaw message poll --channel telegram --target 123456789 \
  --poll-question "Ship it?" --poll-option "Yes" --poll-option "No"
openclaw message poll --channel telegram --target -1001234567890:topic:42 \
  --poll-question "Pick a time" --poll-option "10am" --poll-option "2pm" \
  --poll-duration-seconds 300 --poll-public
```

Telegram-only poll flags:

- `--poll-duration-seconds` (5-600)
  - `--poll-anonymous`
  - `--poll-public`
  - `--thread-id` 用於論壇主題（或使用 `:topic:` 目標）

[[BLOCK_1]]

- `channels.telegram.actions.sendMessage=false` 禁用外發的 Telegram 訊息，包括投票
  - `channels.telegram.actions.poll=false` 禁用 Telegram 投票的創建，同時保留常規發送功能

</Accordion>

<Accordion title="Telegram 中的執行批准">
    Telegram 支援在批准者的私訊中進行執行批准，並可以選擇在發起的聊天或主題中發佈批准提示。

Config path:

- `channels.telegram.execApprovals.enabled`
  - `channels.telegram.execApprovals.approvers`
  - `channels.telegram.execApprovals.target` (`dm` | `channel` | `both`, 預設: `dm`)
  - `agentFilter`, `sessionFilter`

核准者必須是數字型的 Telegram 使用者 ID。當 `enabled` 為 false 或 `approvers` 為空時，Telegram 不會作為執行核准用戶端。核准請求將回退到其他已設定的核准路徑或執行核准回退政策。

[[BLOCK_1]]

- `target: "dm"` 僅將批准提示發送給已設定的批准者 DM
  - `target: "channel"` 將提示發送回原始的 Telegram 聊天/主題
  - `target: "both"` 同時發送給批准者 DM 和原始聊天/主題

只有已設定的批准者才能批准或拒絕。非批准者無法使用 `/approve` 並且無法使用 Telegram 批准按鈕。

Channel delivery 在聊天中顯示命令文字，因此僅在受信任的群組/主題中啟用 `channel` 或 `both`。當提示進入論壇主題時，OpenClaw 會保留該主題以便於批准提示和批准後的後續跟進。

內嵌批准按鈕也依賴於 `channels.telegram.capabilities.inlineButtons` 允許目標表面 (`dm`、`group` 或 `all`)。

相關文件：[執行批准](/tools/exec-approvals)

</Accordion>
</AccordionGroup>

## 故障排除

<AccordionGroup>
  <Accordion title="機器人不回應未提及的群組訊息">

- 如果 `requireMention=false`，Telegram 隱私模式必須允許完全可見性。- BotFather: `/setprivacy` -> 禁用 - 然後移除並重新添加機器人到群組
  - `openclaw channels status` 在設定預期未提及的群組消息時會發出警告。
  - `openclaw channels status --probe` 可以檢查明確的數字群組 ID；通配符 `"*"` 不能進行成員資格探測。
  - 快速會話測試: `/activation always`。

</Accordion>

<Accordion title="機器人完全無法看到群組訊息">

- 當 `channels.telegram.groups` 存在時，必須列出群組（或包含 `"*"`）
  - 驗證機器人是否為群組成員
  - 檢查日誌：`openclaw logs --follow` 以了解跳過的原因

</Accordion>

<Accordion title="指令部分運作或根本無法運作">

- 授權您的發件人身份（配對和/或數字 `allowFrom`）
  - 即使群組政策為 `open`，命令授權仍然適用
  - `setMyCommands failed` 與 `BOT_COMMANDS_TOO_MUCH` 意味著原生選單的專案過多；請減少插件/技能/自訂命令或禁用原生選單
  - `setMyCommands failed` 與網路/獲取錯誤通常表示對 `api.telegram.org` 的 DNS/HTTPS 可達性問題

</Accordion>

<Accordion title="輪詢或網路不穩定">

- Node 22+ 及自訂的 fetch/proxy 可能會因為 AbortSignal 類型不匹配而觸發立即中止行為。
  - 某些主機會優先解析 `api.telegram.org` 為 IPv6；損壞的 IPv6 外發可能會導致間歇性的 Telegram API 失敗。
  - 如果日誌中包含 `TypeError: fetch failed` 或 `Network request for 'getUpdates' failed!`，OpenClaw 現在會將這些視為可恢復的網路錯誤並重新嘗試。
  - 在具有不穩定直接外發/TLS 的 VPS 主機上，將 Telegram API 呼叫路由通過 `channels.telegram.proxy`：

```yaml
channels:
  telegram:
    proxy: socks5://<user>:<password>@proxy-host:1080
```

- Node 22+ 預設為 `autoSelectFamily=true`（除了 WSL2）和 `dnsResultOrder=ipv4first`。
  - 如果您的主機是 WSL2 或明確需要更好的 IPv4 專用行為，請強制選擇網路協定族：

```yaml
channels:
  telegram:
    network:
      autoSelectFamily: false
```

- 環境覆蓋（臨時）: - `OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY=1` - `OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY=1` - `OPENCLAW_TELEGRAM_DNS_RESULT_ORDER=ipv4first`
  - 驗證 DNS 回應:

```bash
dig +short api.telegram.org A
dig +short api.telegram.org AAAA
```

</Accordion>
</AccordionGroup>

更多幫助：[[INLINE_1]] [頻道故障排除](/channels/troubleshooting)。

## Telegram 設定參考指標

[[BLOCK_1]]

- `channels.telegram.enabled`: 啟用/禁用頻道啟動。
- `channels.telegram.botToken`: 機器人 token（BotFather）。
- `channels.telegram.tokenFile`: 從常規檔案路徑讀取 token。符號連結會被拒絕。
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled`（預設：配對）。
- `channels.telegram.allowFrom`: DM 允許清單（數字 Telegram 用戶 ID）。`allowlist` 至少需要一個發送者 ID。`open` 需要 `"*"`。`openclaw doctor --fix` 可以將舊版 `@username` 條目解析為 ID，並可以從允許清單遷移流程中的配對存儲檔案中恢復允許清單條目。
- `channels.telegram.actions.poll`: 啟用或禁用 Telegram 投票創建（預設：啟用；仍然需要 `sendMessage`）。
- `channels.telegram.defaultTo`: CLI `--deliver` 使用的預設 Telegram 目標，當未提供明確的 `--reply-to` 時。
- `channels.telegram.groupPolicy`: `open | allowlist | disabled`（預設：允許清單）。
- `channels.telegram.groupAllowFrom`: 群組發送者允許清單（數字 Telegram 用戶 ID）。`openclaw doctor --fix` 可以將舊版 `@username` 條目解析為 ID。非數字條目在身份驗證時會被忽略。群組身份驗證不使用 DM 配對存儲回退 (`2026.2.25+`)。
- 多帳戶優先順序：
  - 當設定兩個或更多帳戶 ID 時，設置 `channels.telegram.defaultAccount`（或包含 `channels.telegram.accounts.default`）以明確指定預設路由。
  - 如果兩者都未設置，OpenClaw 將回退到第一個標準化的帳戶 ID，並且 `openclaw doctor` 會發出警告。
  - `channels.telegram.accounts.default.allowFrom` 和 `channels.telegram.accounts.default.groupAllowFrom` 僅適用於 `default` 帳戶。
  - 命名帳戶在帳戶級別值未設置時繼承 `channels.telegram.allowFrom` 和 `channels.telegram.groupAllowFrom`。
  - 命名帳戶不繼承 `channels.telegram.accounts.default.allowFrom` / `groupAllowFrom`。
- `channels.telegram.groups`: 每群組預設 + 允許清單（使用 `"*"` 作為全域預設）。
  - `channels.telegram.groups.<id>.groupPolicy`: 每群組覆蓋群組政策 (`open | allowlist | disabled`)。
  - `channels.telegram.groups.<id>.requireMention`: 提及閘道預設。
  - `channels.telegram.groups.<id>.skills`: 技能過濾器（省略 = 所有技能，空 = 無）。
  - `channels.telegram.groups.<id>.allowFrom`: 每群組發送者允許清單覆蓋。
  - `channels.telegram.groups.<id>.systemPrompt`: 群組的額外系統提示。
  - `channels.telegram.groups.<id>.enabled`: 當 `false` 時禁用該群組。
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: 每主題覆蓋（群組欄位 + 僅主題 `agentId`）。
  - `channels.telegram.groups.<id>.topics.<threadId>.agentId`: 將此主題路由到特定代理（覆蓋群組級別和綁定路由）。
- `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: 每主題覆蓋群組政策 (`open | allowlist | disabled`)。
- `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: 每主題提及閘道覆蓋。
- 頂層 `bindings[]` 具有 `type: "acp"` 和標準主題 ID `chatId:topic:topicId` 在 `match.peer.id`：持久的 ACP 主題綁定欄位（請參見 [ACP Agents](/tools/acp-agents#channel-specific-settings)）。
- `channels.telegram.direct.<id>.topics.<threadId>.agentId`: 將 DM 主題路由到特定代理（與論壇主題相同的行為）。
- `channels.telegram.execApprovals.enabled`: 啟用 Telegram 作為此帳戶的基於聊天的執行批准用戶端。
- `channels.telegram.execApprovals.approvers`: 允許批准或拒絕執行請求的 Telegram 用戶 ID。當執行批准啟用時必需。
- `channels.telegram.execApprovals.target`: `dm | channel | both`（預設：`dm`）。`channel` 和 `both` 在存在時保留原始 Telegram 主題。
- `channels.telegram.execApprovals.agentFilter`: 轉發批准提示的可選代理 ID 過濾器。
- `channels.telegram.execApprovals.sessionFilter`: 轉發批准提示的可選會話金鑰過濾器（子字串或正則表達式）。
- `channels.telegram.accounts.<account>.execApprovals`: 每帳戶覆蓋 Telegram 執行批准路由和批准者授權。
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist`（預設：允許清單）。
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: 每帳戶覆蓋。
- `channels.telegram.commands.nativeSkills`: 啟用/禁用 Telegram 原生技能命令。
- `channels.telegram.replyToMode`: `off | first | all`（預設：`off`）。
- `channels.telegram.textChunkLimit`: 出站區塊大小（字元）。
- `channels.telegram.chunkMode`: `length`（預設）或 `newline` 在空白行（段落邊界）之前進行分割。
- `channels.telegram.linkPreview`: 切換出站消息的連結預覽（預設：真）。
- `channels.telegram.streaming`: `off | partial | block | progress`（即時串流預覽；預設：`partial`；`progress` 對應於 `partial`；`block` 是舊版預覽模式相容性）。Telegram 預覽串流使用單一預覽消息並在原地編輯。
- `channels.telegram.mediaMaxMb`: 入站/出站 Telegram 媒體上限（MB，預設：100）。
- `channels.telegram.retry`: 對於可恢復的出站 API 錯誤的 Telegram 發送助手（CLI/工具/行動）的重試策略（嘗試次數、最小延遲毫秒、最大延遲毫秒、抖動）。
- `channels.telegram.network.autoSelectFamily`: 覆蓋 Node 自動選擇家庭（true=啟用，false=禁用）。在 Node 22+ 上預設為啟用，WSL2 預設為禁用。
- `channels.telegram.network.dnsResultOrder`: 覆蓋 DNS 結果順序 (`ipv4first` 或 `verbatim`)。在 Node 22+ 上預設為 `ipv4first`。
- `channels.telegram.proxy`: Bot API 調用的代理 URL（SOCKS/HTTP）。
- `channels.telegram.webhookUrl`: 啟用 webhook 模式（需要 `channels.telegram.webhookSecret`）。
- `channels.telegram.webhookSecret`: webhook 密鑰（當 webhookUrl 設置時必需）。
- `channels.telegram.webhookPath`: 本地 webhook 路徑（預設 `/telegram-webhook`）。
- `channels.telegram.webhookHost`: 本地 webhook 綁定主機（預設 `127.0.0.1`）。
- `channels.telegram.webhookPort`: 本地 webhook 綁定端口（預設 `8787`）。
- `channels.telegram.actions.reactions`: 閘道 Telegram 工具反應。
- `channels.telegram.actions.sendMessage`: 閘道 Telegram 工具消息發送。
- `channels.telegram.actions.deleteMessage`: 閘道 Telegram 工具消息刪除。
- `channels.telegram.actions.sticker`: 閘道 Telegram 貼圖操作 — 發送和搜尋（預設：假）。
- `channels.telegram.reactionNotifications`: `off | own | all` — 控制哪些反應觸發系統事件（預設：`own` 當未設置時）。
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` — 控制代理的反應能力（預設：`minimal` 當未設置時）。

- [設定參考 - Telegram](/gateway/configuration-reference#telegram)

Telegram 特定的高信號欄位：

- 啟動/驗證: `enabled`, `botToken`, `tokenFile`, `accounts.*` (`tokenFile` 必須指向一個常規檔案；不接受符號連結)
- 存取控制: `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`, `groups.*.topics.*`, 頂層 `bindings[]` (`type: "acp"`)
- 執行批准: `execApprovals`, `accounts.*.execApprovals`
- 命令/選單: `commands.native`, `commands.nativeSkills`, `customCommands`
- 執行緒/回覆: `replyToMode`
- 串流: `streaming` (預覽), `blockStreaming`
- 格式化/交付: `textChunkLimit`, `chunkMode`, `linkPreview`, `responsePrefix`
- 媒體/網路: `mediaMaxMb`, `timeoutSeconds`, `retry`, `network.autoSelectFamily`, `proxy`
- 網路鉤子: `webhookUrl`, `webhookSecret`, `webhookPath`, `webhookHost`
- 行動/能力: `capabilities.inlineButtons`, `actions.sendMessage|editMessage|deleteMessage|reactions|sticker`
- 反應: `reactionNotifications`, `reactionLevel`
- 寫入/歷史: `configWrites`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`

## Related

- [配對](/channels/pairing)
- [頻道路由](/channels/channel-routing)
- [多代理路由](/concepts/multi-agent)
- [故障排除](/channels/troubleshooting)
