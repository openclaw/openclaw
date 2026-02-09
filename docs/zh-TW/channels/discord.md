---
summary: "Discord bot support status, capabilities, and configuration"
read_when:
  - 進行 Discord 頻道功能開發時
title: "Discord"
---

# Discord（Bot API）

Status: ready for DM and guild text channels via the official Discord bot gateway.

## 快速設定（新手）

1. 建立一個 Discord 機器人並複製 Bot 權杖。
2. 在 Discord 應用程式設定中，啟用 **Message Content Intent**（若你打算使用允許清單或名稱查詢，也請啟用 **Server Members Intent**）。
3. 為 OpenClaw 設定權杖：
   - Env: `DISCORD_BOT_TOKEN=...`
   - 或設定檔：`channels.discord.token: "..."`。
   - If both are set, config takes precedence (env fallback is default-account only).
4. Invite the bot to your server with message permissions (create a private server if you just want DMs).
5. 啟動 Gateway 閘道器.
6. DM access is pairing by default; approve the pairing code on first contact.

最小設定：

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

## 目標

- 透過 Discord 私訊或伺服器頻道與 OpenClaw 對話。
- 私訊會合併至代理程式的主要工作階段（預設 `agent:main:main`）；伺服器頻道則保持隔離為 `agent:<agentId>:discord:channel:<channelId>`（顯示名稱使用 `discord:<guildSlug>#<channelSlug>`）。
- 群組私訊預設會被忽略；可透過 `channels.discord.dm.groupEnabled` 啟用，並可選擇以 `channels.discord.dm.groupChannels` 進行限制。
- 保持路由的確定性：回覆一律回到訊息來源的頻道。

## How it works

1. 建立 Discord 應用程式 → Bot，啟用所需的 intents（私訊 + 伺服器訊息 + 訊息內容），並取得 Bot 權杖。
2. Invite the bot to your server with the permissions required to read/send messages where you want to use it.
3. 使用 `channels.discord.token`（或 `DISCORD_BOT_TOKEN` 作為回退）設定 OpenClaw。
4. 執行 Gateway 閘道器；當權杖可用時（設定檔優先、環境變數回退），且 `channels.discord.enabled` 不是 `false`，Discord 頻道會自動啟動。
   - If you prefer env vars, set `DISCORD_BOT_TOKEN` (a config block is optional).
5. 私訊：投遞時使用 `user:<id>`（或 `<@id>` 提及）；所有回合都會進入共用的 `main` 工作階段。單純的數字 ID 具有歧義，會被拒絕。 Bare numeric IDs are ambiguous and rejected.
6. 伺服器頻道：投遞時使用 `channel:<channelId>`。預設需要提及，可依伺服器或頻道設定。 Mentions are required by default and can be set per guild or per channel.
7. Direct chats: secure by default via `channels.discord.dm.policy` (default: `"pairing"`). 私訊：預設透過 `channels.discord.dm.policy` 強化安全性（預設：`"pairing"`）。未知寄件者會收到配對碼（1 小時後失效）；透過 `openclaw pairing approve discord <code>` 核准。
   - 若要維持舊有「對任何人開放」行為：設定 `channels.discord.dm.policy="open"` 與 `channels.discord.dm.allowFrom=["*"]`。
   - 若要嚴格允許清單：設定 `channels.discord.dm.policy="allowlist"`，並在 `channels.discord.dm.allowFrom` 列出寄件者。
   - 若要忽略所有私訊：設定 `channels.discord.dm.enabled=false` 或 `channels.discord.dm.policy="disabled"`。
8. 群組私訊預設忽略；可透過 `channels.discord.dm.groupEnabled` 啟用，並可選擇以 `channels.discord.dm.groupChannels` 限制。
9. 選用的伺服器規則：設定 `channels.discord.guilds`，以 guild id（建議）或 slug 作為鍵，並定義各頻道規則。
10. 選用的原生命令：`commands.native` 預設為 `"auto"`（Discord/Telegram 開啟，Slack 關閉）。可用 `channels.discord.commands.native: true|false|"auto"` 覆寫；`false` 會清除先前註冊的命令。文字命令由 `commands.text` 控制，且必須以獨立的 `/...` 訊息傳送。使用 `commands.useAccessGroups: false` 可略過命令的存取群組檢查。 Override with `channels.discord.commands.native: true|false|"auto"`; `false` clears previously registered commands. Text commands are controlled by `commands.text` and must be sent as standalone `/...` messages. Use `commands.useAccessGroups: false` to bypass access-group checks for commands.
    - 完整命令清單與設定：[Slash commands](/tools/slash-commands)
11. 選用的伺服器情境歷史：設定 `channels.discord.historyLimit`（預設 20，回退至 `messages.groupChat.historyLimit`），在回覆提及時包含最近 N 則伺服器訊息作為情境。設定 `0` 可停用。 Set `0` to disable.
12. 反應：代理程式可透過 `discord` 工具觸發反應（受 `channels.discord.actions.*` 管控）。
    - 反應移除語意：請見 [/tools/reactions](/tools/reactions)。
    - `discord` 工具僅在目前頻道為 Discord 時才會暴露。
13. 原生命令使用隔離的工作階段鍵（`agent:<agentId>:discord:slash:<userId>`），而非共用的 `main` 工作階段。

Note: Name → id resolution uses guild member search and requires Server Members Intent; if the bot can’t search members, use ids or `<@id>` mentions.
Note: Slugs are lowercase with spaces replaced by `-`. Channel names are slugged without the leading `#`.
Note: Guild context `[from:]` lines include `author.tag` + `id` to make ping-ready replies easy.

## 設定寫入

預設情況下，Discord 允許由 `/config set|unset` 觸發的設定更新寫入（需要 `commands.config: true`）。

停用方式：

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## How to create your own bot

以下是「Discord Developer Portal」的設定流程，用於在像 `#help` 這樣的伺服器（guild）頻道中執行 OpenClaw。

### 1）建立 Discord 應用程式與機器人使用者

1. Discord Developer Portal → **Applications** → **New Application**
2. 在你的應用程式中：
   - **Bot** → **Add Bot**
   - 複製 **Bot Token**（填入 `DISCORD_BOT_TOKEN` 的值）

### 2）啟用 OpenClaw 所需的 Gateway Intents

Discord 會封鎖「特權 intents」，除非你明確啟用。

在 **Bot** → **Privileged Gateway Intents** 中啟用：

- **Message Content Intent**（在多數伺服器中讀取訊息內容所必需；未啟用時會看到「Used disallowed intents」，或機器人能連線但不回應訊息）
- **Server Members Intent**（建議啟用；在伺服器中進行部分成員/使用者查詢與允許清單比對時必需）

You usually do **not** need **Presence Intent**. 通常**不需要** **Presence Intent**。設定機器人自身狀態（`setPresence` 動作）使用 Gateway OP3，無需此 intent；只有在你想接收其他成員的狀態更新時才需要。

### 3）產生邀請連結（OAuth2 URL Generator）

在你的應用程式中：**OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands`（原生命令必需）

**Bot Permissions**（最小基準）

- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions（選用但建議）
- ✅ Use External Emojis / Stickers（選用；僅在需要時）

除非在除錯且完全信任機器人，否則避免使用 **Administrator**。

Copy the generated URL, open it, pick your server, and install the bot.

### 4）取得各種 id（guild/user/channel）

Discord 到處都使用數字 id；OpenClaw 設定偏好使用 id。

1. Discord（桌面/網頁）→ **User Settings** → **Advanced** → 啟用 **Developer Mode**
2. 右鍵：
   - 伺服器名稱 → **Copy Server ID**（guild id）
   - 頻道（例如 `#help`）→ **Copy Channel ID**
   - 你的使用者 → **Copy User ID**

### 5）設定 OpenClaw

#### Token

Set the bot token via env var (recommended on servers):

- `DISCORD_BOT_TOKEN=...`

或透過設定檔：

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

多帳號支援：使用 `channels.discord.accounts`，為每個帳號設定權杖，並可選擇 `name`。共享模式請見 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts)。 See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern.

#### 允許清單與頻道路由

範例：「單一伺服器、只允許我、只允許 #help」：

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
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

注意事項：

- `requireMention: true` 表示機器人僅在被提及時回覆（共享頻道建議）。
- `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）在伺服器訊息中也會視為提及。
- 多代理程式覆寫：在 `agents.list[].groupChat.mentionPatterns` 上設定每個代理程式的模式。
- 若存在 `channels`，未列出的任何頻道預設會被拒絕。
- Use a `"*"` channel entry to apply defaults across all channels; explicit channel entries override the wildcard.
- 討論串會繼承父頻道的設定（允許清單、`requireMention`、Skills、提示等），除非你明確加入討論串的頻道 id。 unless you add the thread channel id explicitly.
- 擁有者提示：當每個伺服器或頻道的 `users` 允許清單符合寄件者時，OpenClaw 會在系統提示中將該寄件者視為擁有者。若要跨頻道的全域擁有者，請設定 `commands.ownerAllowFrom`。 For a global owner across channels, set `commands.ownerAllowFrom`.
- 機器人自身發送的訊息預設會被忽略；設定 `channels.discord.allowBots=true` 可允許（仍會過濾自己的訊息）。
- 警告：若允許回覆其他機器人（`channels.discord.allowBots=true`），請使用 `requireMention`、`channels.discord.guilds.*.channels.<id>.users` 允許清單，或在 `AGENTS.md` 與 `SOUL.md` 中清除護欄，以避免機器人對機器人的回覆循環。

### 6）驗證是否正常運作

1. 啟動 Gateway 閘道器.
2. 在你的伺服器頻道中傳送：`@Krill hello`（或你的機器人名稱）。
3. If nothing happens: check **Troubleshooting** below.

### Troubleshooting

- 首先：執行 `openclaw doctor` 與 `openclaw channels status --probe`（可採取行動的警告 + 快速稽核）。
- **「Used disallowed intents」**：在 Developer Portal 中啟用 **Message Content Intent**（以及很可能的 **Server Members Intent**），然後重新啟動 Gateway 閘道器。
- **機器人已連線但在伺服器頻道中從不回覆**：
  - 缺少 **Message Content Intent**，或
  - 機器人缺乏頻道權限（View/Send/Read History），或
  - 你的設定要求提及但你未提及它，或
  - 你的伺服器/頻道允許清單拒絕了該頻道/使用者。
- **`requireMention: false` 但仍無回覆**：
- `channels.discord.groupPolicy` 預設為 **allowlist**；請將其設為 `"open"`，或在 `channels.discord.guilds` 下新增一個伺服器項目（可選擇在 `channels.discord.guilds.<id>.channels` 列出頻道以限制）。
  - 若你只設定了 `DISCORD_BOT_TOKEN`，卻從未建立 `channels.discord` 區段，執行時
    會將 `groupPolicy` 預設為 `open`。請加入 `channels.discord.groupPolicy`、
    `channels.defaults.groupPolicy`，或伺服器/頻道允許清單以鎖定行為。 1. 新增 `channels.discord.groupPolicy`、
    `channels.defaults.groupPolicy`，或伺服器/頻道允許清單來加以限制。
- `requireMention` 必須位於 `channels.discord.guilds`（或特定頻道）之下。最上層的 `channels.discord.requireMention` 會被忽略。 2. 頂層的 `channels.discord.requireMention` 會被忽略。
- 3. **權限稽核**（`channels status --probe`）只會檢查數字型頻道 ID。 **權限稽核**（`channels status --probe`）只會檢查數字頻道 ID。若你使用 slug/名稱作為 `channels.discord.guilds.*.channels` 的鍵，稽核將無法驗證權限。
- **私訊無法運作**：`channels.discord.dm.enabled=false`、`channels.discord.dm.policy="disabled"`，或你尚未被核准（`channels.discord.dm.policy="pairing"`）。
- **Discord 中的 Exec 核准**：Discord 在私訊中支援 **按鈕 UI** 進行 exec 核准（Allow once / Always allow / Deny）。`/approve <id> ...` 僅用於轉送的核准，無法解決 Discord 的按鈕提示。若你看到 `❌ Failed to submit approval: Error: unknown approval id` 或 UI 從未出現，請檢查： 4. `/approve <id> ...` 僅用於轉送的核准，無法處理 Discord 的按鈕提示。 5. 若你看到 `❌ Failed to submit approval: Error: unknown approval id` 或 UI 一直未出現，請檢查：
  - 設定中的 `channels.discord.execApprovals.enabled: true`。
  - 你的 Discord 使用者 ID 是否列於 `channels.discord.execApprovals.approvers`（UI 只會傳送給核准者）。
  - 請使用私訊提示中的按鈕（**Allow once**、**Always allow**、**Deny**）。
  - 參考 [Exec approvals](/tools/exec-approvals) 與 [Slash commands](/tools/slash-commands) 以了解更完整的核准與命令流程。

## 功能與限制

- 6. 私訊（DM）與伺服器文字頻道（討論串視為獨立頻道；不支援語音）。
- 正在輸入指示為盡力而為；訊息分段使用 `channels.discord.textChunkLimit`（預設 2000），並依行數分割較長回覆（`channels.discord.maxLinesPerMessage`，預設 17）。
- 選用的換行分段：設定 `channels.discord.chunkMode="newline"`，在長度分段前先依空白行（段落邊界）分割。
- 支援檔案上傳，大小上限為設定的 `channels.discord.mediaMaxMb`（預設 8 MB）。
- 7. 預設以提及（mention）作為門檻的伺服器回覆，以避免吵雜的機器人。
- 8. 當訊息引用另一則訊息時，會注入回覆上下文（引用內容 + ID）。
- 原生回覆串接預設為 **關閉**；使用 `channels.discord.replyToMode` 與回覆標籤啟用。

## 重試策略

對外的 Discord API 呼叫在遇到速率限制（429）時，會在可用時使用 Discord 的 `retry_after`，並搭配指數退避與抖動重試。可透過 `channels.discord.retry` 設定。請見 [Retry policy](/concepts/retry)。 9. 透過 `channels.discord.retry` 設定。 10. 請參閱 [重試政策](/concepts/retry)。

## 設定

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
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
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

Ack 反應由全域設定 `messages.ackReaction` +
`messages.ackReactionScope` 控制。使用 `messages.removeAckAfterReply` 可在機器人回覆後清除
ack 反應。 11. 使用 `messages.removeAckAfterReply` 在機器人回覆後清除
確認反應。

- `dm.enabled`：設定 `false` 以忽略所有私訊（預設 `true`）。
- 12. `dm.policy`：私訊存取控制（建議使用 `pairing`）。 `dm.policy`：私訊存取控制（建議 `pairing`）。`"open"` 需要 `dm.allowFrom=["*"]`。
- 13. `dm.allowFrom`：私訊允許清單（使用者 ID 或名稱）。 `dm.allowFrom`：私訊允許清單（使用者 id 或名稱）。供 `dm.policy="allowlist"` 與 `dm.policy="open"` 驗證使用。精靈接受使用者名稱，並在機器人可搜尋成員時解析為 id。 14. 精靈接受使用者名稱，並在機器人可搜尋成員時將其解析為 ID。
- `dm.groupEnabled`：啟用群組私訊（預設 `false`）。
- `dm.groupChannels`：群組私訊頻道 id 或 slug 的選用允許清單。
- `groupPolicy`：控制伺服器頻道處理（`open|disabled|allowlist`）；`allowlist` 需要頻道允許清單。
- `guilds`：以 guild id（建議）或 slug 為鍵的每伺服器規則。
- `guilds."*"`：當不存在明確項目時套用的每伺服器預設設定。
- `guilds.<id>.slug`：用於顯示名稱的選用友善 slug。
- `guilds.<id>.users`：選用的每伺服器使用者允許清單（id 或名稱）。
- `guilds.<id>.tools`：選用的每伺服器工具政策覆寫（`allow`/`deny`/`alsoAllow`），在缺少頻道覆寫時使用。
- `guilds.<id>.toolsBySender`：選用的每寄件者工具政策覆寫（伺服器層級；在缺少頻道覆寫時套用；支援 `"*"` 萬用字元）。
- `guilds.<id>.channels.<channel>.allow`：當 `groupPolicy="allowlist"` 時允許/拒絕頻道。
- `guilds.<id>.channels.<channel>.requireMention`：頻道的提及門檻。
- `guilds.<id>.channels.<channel>.tools`：選用的每頻道工具政策覆寫（`allow`/`deny`/`alsoAllow`）。
- `guilds.<id>.channels.<channel>.toolsBySender`：頻道內選用的每寄件者工具政策覆寫（支援 `"*"` 萬用字元）。
- `guilds.<id>.channels.<channel>.users`：選用的每頻道使用者允許清單。
- `guilds.<id>.channels.<channel>.skills`：Skill 篩選（省略 = 全部 Skills，空值 = 無）。
- `guilds.<id>.channels.<channel>15. `.systemPrompt`：該頻道的額外系統提示。 .systemPrompt`：頻道的額外系統提示。Discord 頻道主題會以 **不可信** 情境注入（非系統提示）。
- `guilds.<id>.channels.<channel>.enabled`：設定 `false` 以停用頻道。
- `guilds.<id>.channels`：頻道規則（鍵為頻道 slug 或 id）。
- `guilds.<id>.requireMention`：每伺服器的提及需求（可在每頻道覆寫）。
- `guilds.<id>.reactionNotifications`：反應系統事件模式（`off`、`own`、`all`、`allowlist`）。
- `textChunkLimit`：對外文字分段大小（字元）。預設：2000。 16. 預設值：2000。
- `chunkMode`：`length`（預設）僅在超過 `textChunkLimit` 時分割；`newline` 會在長度分段前先依空白行（段落邊界）分割。
- `maxLinesPerMessage`：每則訊息的軟性最大行數。預設：17。 17. 預設值：17。
- `mediaMaxMb`：限制儲存至磁碟的入站媒體。
- `historyLimit`：在回覆提及時，納入作為情境的最近伺服器訊息數量（預設 20；回退至 `messages.groupChat.historyLimit`；`0` 停用）。
- 18. `dmHistoryLimit`：以使用者回合數計的私訊歷史上限。 `dmHistoryLimit`：私訊歷史上限（以使用者回合計）。每使用者覆寫：`dms["<user_id>"].historyLimit`。
- `retry`：對外 Discord API 呼叫的重試策略（嘗試次數、minDelayMs、maxDelayMs、jitter）。
- `pluralkit`：解析 PluralKit 代理訊息，使系統成員顯示為不同寄件者。
- `actions`：每動作工具閘控；省略表示允許全部（設定 `false` 以停用）。
  - `reactions`（涵蓋反應 + 讀取反應）
  - `stickers`、`emojiUploads`、`stickerUploads`、`polls`、`permissions`、`messages`、`threads`、`pins`、`search`
  - `memberInfo`、`roleInfo`、`channelInfo`、`voiceStatus`、`events`
  - `channels`（建立/編輯/刪除頻道 + 類別 + 權限）
  - `roles`（角色新增/移除，預設 `false`）
  - `moderation`（禁言/踢出/封鎖，預設 `false`）
  - `presence`（機器人狀態/活動，預設 `false`）
- `execApprovals`：僅限 Discord 的 exec 核准私訊（按鈕 UI）。支援 `enabled`、`approvers`、`agentFilter`、`sessionFilter`。 19. 支援 `enabled`、`approvers`、`agentFilter`、`sessionFilter`。

反應通知使用 `guilds.<id>.reactionNotifications`：

- `off`：無反應事件。
- 20. `own`：對機器人自身訊息的反應（預設）。
- `all`：所有訊息上的所有反應。
- `allowlist`：來自 `guilds.<id>.users` 的反應（套用於所有訊息；空清單表示停用）。

### PluralKit（PK）支援

21. 啟用 PK 查詢，讓代理訊息可解析為底層系統 + 成員。
22. 啟用後，OpenClaw 會使用成員身分進行允許清單比對，並將
    發送者標示為 `Member (PK:System)`，以避免誤觸 Discord 提及。

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

允許清單注意事項（啟用 PK）：

- 在 `dm.allowFrom`、`guilds.<id>.users` 或每頻道的 `users` 中使用 `pk:<memberId>`。
- 23. 也會以名稱/slug 比對成員顯示名稱。
- 查詢使用 **原始** Discord 訊息 ID（代理前的訊息），因此 PK API 僅能在其 30 分鐘視窗內解析。
- 若 PK 查詢失敗（例如私人系統未提供權杖），代理訊息會被視為機器人訊息，並在未設定 `channels.discord.allowBots=true` 時被捨棄。

### 工具動作預設值

| 動作群組           | Default | 注意事項                                             |
| -------------- | ------- | ------------------------------------------------ |
| reactions      | 啟用      | 反應 + 列出反應 + emojiList                            |
| stickers       | 啟用      | 24. 傳送貼圖                  |
| emojiUploads   | 啟用      | 上傳表情符號                                           |
| stickerUploads | 啟用      | 25. 上傳貼圖                  |
| polls          | 啟用      | 建立投票                                             |
| permissions    | 啟用      | 頻道權限快照                                           |
| messages       | 啟用      | 讀取/傳送/編輯/刪除                                      |
| threads        | 啟用      | 建立/列出/回覆                                         |
| pins           | 啟用      | 釘選/取消釘選/列出                                       |
| search         | 啟用      | 訊息搜尋（預覽功能）                                       |
| memberInfo     | 啟用      | 成員資訊                                             |
| roleInfo       | 啟用      | 角色清單                                             |
| channelInfo    | 啟用      | 頻道資訊 + 清單                                        |
| channels       | 啟用      | 頻道/類別管理                                          |
| voiceStatus    | 啟用      | 語音狀態查詢                                           |
| events         | 啟用      | 列出/建立排程活動                                        |
| roles          | 停用      | 角色新增/移除                                          |
| moderation     | 停用      | 禁言/踢出/封鎖                                         |
| presence       | 停用      | 26. 機器人狀態/活動（setPresence） |

- `replyToMode`：`off`（預設）、`first` 或 `all`。僅在模型包含回覆標籤時套用。 27. 僅在模型包含回覆標籤時套用。

## 回覆標籤

若要請求串接回覆，模型可在輸出中包含一個標籤：

- `[[reply_to_current]]` — 回覆觸發的 Discord 訊息。
- `[[reply_to:<id>]]` — 回覆情境/歷史中的特定訊息 id。
  目前的訊息 id 會以 `[message_id: …]` 附加至提示；歷史項目已包含 id。
  28. 目前的訊息 ID 會以 `[message_id: …]` 附加到提示中；歷史項目已包含 ID。

行為由 `channels.discord.replyToMode` 控制：

- `off`：忽略標籤。
- `first`：僅第一個對外分段/附件為回覆。
- `all`：每個對外分段/附件皆為回覆。

允許清單比對注意事項：

- `allowFrom`/`users`/`groupChannels` 接受 id、名稱、標籤，或如 `<@id>` 的提及。
- 支援如 `discord:`/`user:`（使用者）與 `channel:`（群組私訊）的前綴。
- 使用 `*` 以允許任何寄件者/頻道。
- 當存在 `guilds.<id>.channels` 時，未列出的頻道預設會被拒絕。
- 當省略 `guilds.<id>.channels` 時，允許清單伺服器中的所有頻道皆被允許。
- 若要**不允許任何頻道**，請設定 `channels.discord.groupPolicy: "disabled"`（或保持允許清單為空）。
- 設定精靈接受 `Guild/Channel` 名稱（公開 + 私有），並在可能時解析為 ID。
- 啟動時，OpenClaw 會將允許清單中的頻道/使用者名稱解析為 ID（當機器人可搜尋成員時），並記錄對應關係；無法解析的項目會保留原樣。

原生命令注意事項：

- 已註冊的命令會對應 OpenClaw 的聊天命令。
- 原生命令遵循與私訊/伺服器訊息相同的允許清單（`channels.discord.dm.allowFrom`、`channels.discord.guilds`、每頻道規則）。
- Slash 命令仍可能在 Discord UI 中對未列入允許清單的使用者可見；OpenClaw 會在執行時強制檢查允許清單，並回覆「未授權」。

## 工具動作

代理程式可呼叫 `discord`，其動作包含：

- `react` / `reactions`（新增或列出反應）
- `sticker`、`poll`、`permissions`
- `readMessages`、`sendMessage`、`editMessage`、`deleteMessage`
- 讀取/搜尋/釘選工具的負載包含正規化的 `timestampMs`（UTC epoch 毫秒）與 `timestampUtc`，以及原始 Discord 的 `timestamp`。
- `threadCreate`、`threadList`、`threadReply`
- `pinMessage`、`unpinMessage`、`listPins`
- `searchMessages`、`memberInfo`、`roleInfo`、`roleAdd`、`roleRemove`、`emojiList`
- `channelInfo`、`channelList`、`voiceStatus`、`eventList`、`eventCreate`
- `timeout`、`kick`、`ban`
- `setPresence`（機器人活動與線上狀態）

29. Discord 訊息 ID 會在注入的上下文中呈現（`[discord message id: …]` 與歷史行），以便代理能鎖定它們。
30. 表情符號可為 Unicode（例如 `✅`）或自訂表情語法，如 `<:party_blob:1234567890>`。

## 安全性與營運

- 將 Bot 權杖視為密碼；在受監督的主機上優先使用 `DISCORD_BOT_TOKEN` 環境變數，或鎖定設定檔權限。
- 31. 僅授予機器人所需的權限（通常為讀取/傳送訊息）。
- 若機器人卡住或遭到速率限制，請在確認沒有其他程序佔用 Discord 工作階段後，重新啟動 Gateway 閘道器（`openclaw gateway --force`）。
