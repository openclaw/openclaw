---
summary: "Discord بوٹ کی سپورٹ کی حیثیت، صلاحیتیں، اور کنفیگریشن"
read_when:
  - Discord چینل کی خصوصیات پر کام کرتے وقت
title: "Discord"
---

# Discord (Bot API)

حیثیت: سرکاری Discord بوٹ گیٹ وے کے ذریعے DMs اور guild ٹیکسٹ چینلز کے لیے تیار۔

## Quick setup (beginner)

1. ایک Discord بوٹ بنائیں اور بوٹ ٹوکن کاپی کریں۔
2. Discord ایپ کی سیٹنگز میں **Message Content Intent** فعال کریں (اور **Server Members Intent** بھی، اگر آپ allowlists یا نام کی تلاش استعمال کرنے کا ارادہ رکھتے ہیں)۔
3. OpenClaw کے لیے ٹوکن سیٹ کریں:
   - Env: `DISCORD_BOT_TOKEN=...`
   - یا کنفیگ: `channels.discord.token: "..."`۔
   - اگر دونوں سیٹ ہوں تو کنفیگ کو ترجیح حاصل ہوتی ہے (env فالبیک صرف default-account کے لیے ہے)۔
4. بوٹ کو اپنے سرور میں پیغام کی اجازتوں کے ساتھ مدعو کریں (اگر آپ صرف DMs چاہتے ہیں تو نجی سرور بنائیں)۔
5. gateway شروع کریں۔
6. DM رسائی بطورِ طے شدہ pairing ہوتی ہے؛ پہلی بار رابطے پر pairing کوڈ منظور کریں۔

کم از کم کنفیگ:

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

## Goals

- Discord DMs یا guild چینلز کے ذریعے OpenClaw سے بات چیت۔
- براہِ راست چیٹس ایجنٹ کے مرکزی سیشن میں ضم ہو جاتی ہیں (بطورِ طے شدہ `agent:main:main`)؛ guild چینلز `agent:<agentId>:discord:channel:<channelId>` کے طور پر الگ رہتے ہیں (ڈسپلے نام `discord:<guildSlug>#<channelSlug>` استعمال کرتے ہیں)۔
- Group DMs بطورِ طے شدہ نظرانداز ہوتے ہیں؛ `channels.discord.dm.groupEnabled` کے ذریعے فعال کریں اور اختیاری طور پر `channels.discord.dm.groupChannels` سے محدود کریں۔
- روٹنگ کو متعین رکھیں: جوابات ہمیشہ اسی چینل میں واپس جاتے ہیں جہاں سے آئے تھے۔

## How it works

1. Discord ایپلیکیشن → Bot بنائیں، مطلوبہ intents فعال کریں (DMs + guild پیغامات + message content)، اور بوٹ ٹوکن حاصل کریں۔
2. بوٹ کو اپنے سرور میں اُن اجازتوں کے ساتھ مدعو کریں جو وہاں پیغامات پڑھنے/بھیجنے کے لیے درکار ہیں۔
3. OpenClaw کو `channels.discord.token` کے ساتھ کنفیگر کریں (یا فالبیک کے طور پر `DISCORD_BOT_TOKEN`)۔
4. gateway چلائیں؛ جب ٹوکن دستیاب ہو تو یہ Discord چینل خودکار طور پر شروع کرتا ہے (کنفیگ پہلے، env فالبیک) اور `channels.discord.enabled`، `false` نہ ہو۔
   - اگر آپ env vars کو ترجیح دیتے ہیں تو `DISCORD_BOT_TOKEN` سیٹ کریں (کنفیگ بلاک اختیاری ہے)۔
5. Direct chats: use `user:<id>` (or a `<@id>` mention) when delivering; all turns land in the shared `main` session. Bare numeric IDs are ambiguous and rejected.
6. Guild channels: use `channel:<channelId>` for delivery. Mentions are required by default and can be set per guild or per channel.
7. Direct chats: secure by default via `channels.discord.dm.policy` (default: `"pairing"`). Unknown senders get a pairing code (expires after 1 hour); approve via `openclaw pairing approve discord <code>`.
   - پرانا “کسی کے لیے بھی کھلا” رویہ برقرار رکھنے کے لیے: `channels.discord.dm.policy="open"` اور `channels.discord.dm.allowFrom=["*"]` سیٹ کریں۔
   - سخت allowlist کے لیے: `channels.discord.dm.policy="allowlist"` سیٹ کریں اور بھیجنے والوں کو `channels.discord.dm.allowFrom` میں درج کریں۔
   - تمام DMs نظرانداز کرنے کے لیے: `channels.discord.dm.enabled=false` یا `channels.discord.dm.policy="disabled"` سیٹ کریں۔
8. Group DMs بطورِ طے شدہ نظرانداز؛ `channels.discord.dm.groupEnabled` سے فعال کریں اور اختیاری طور پر `channels.discord.dm.groupChannels` سے محدود کریں۔
9. اختیاری guild قواعد: `channels.discord.guilds` سیٹ کریں، guild id (ترجیحی) یا slug کے ساتھ، اور فی چینل قواعد۔
10. Optional native commands: `commands.native` defaults to `"auto"` (on for Discord/Telegram, off for Slack). Override with `channels.discord.commands.native: true|false|"auto"`; `false` clears previously registered commands. Text commands are controlled by `commands.text` and must be sent as standalone `/...` messages. Use `commands.useAccessGroups: false` to bypass access-group checks for commands.
    - مکمل کمانڈ فہرست + کنفیگ: [Slash commands](/tools/slash-commands)
11. Optional guild context history: set `channels.discord.historyLimit` (default 20, falls back to `messages.groupChat.historyLimit`) to include the last N guild messages as context when replying to a mention. Set `0` to disable.
12. Reactions: ایجنٹ `discord` ٹول کے ذریعے reactions ٹرگر کر سکتا ہے (گِیٹ `channels.discord.actions.*`)۔
    - Reaction ہٹانے کے semantics: [/tools/reactions](/tools/reactions) دیکھیں۔
    - `discord` ٹول صرف اس وقت ظاہر ہوتا ہے جب موجودہ چینل Discord ہو۔
13. Native کمانڈز مشترکہ `main` سیشن کے بجائے الگ تھلگ سیشن کیز (`agent:<agentId>:discord:slash:<userId>`) استعمال کرتی ہیں۔

Note: Name → id resolution uses guild member search and requires Server Members Intent; if the bot can’t search members, use ids or `<@id>` mentions.
Note: Slugs are lowercase with spaces replaced by `-`. Channel names are slugged without the leading `#`.
Note: Guild context `[from:]` lines include `author.tag` + `id` to make ping-ready replies easy.

## Config writes

بطورِ طے شدہ، Discord کو `/config set|unset` سے متحرک ہونے والی کنفیگ اپ ڈیٹس لکھنے کی اجازت ہوتی ہے (اس کے لیے `commands.config: true` درکار ہے)۔

غیر فعال کریں:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## How to create your own bot

یہ “Discord Developer Portal” سیٹ اپ ہے جس کے ذریعے OpenClaw کو سرور (guild) چینل جیسے `#help` میں چلایا جاتا ہے۔

### 1. Discord ایپ + بوٹ یوزر بنائیں

1. Discord Developer Portal → **Applications** → **New Application**
2. اپنی ایپ میں:
   - **Bot** → **Add Bot**
   - **Bot Token** کاپی کریں (یہی `DISCORD_BOT_TOKEN` میں ڈالا جاتا ہے)

### 2) وہ gateway intents فعال کریں جن کی OpenClaw کو ضرورت ہے

Discord “privileged intents” کو بلاک کرتا ہے جب تک آپ انہیں واضح طور پر فعال نہ کریں۔

**Bot** → **Privileged Gateway Intents** میں فعال کریں:

- **Message Content Intent** (زیادہ تر guilds میں پیغام متن پڑھنے کے لیے لازمی؛ اس کے بغیر “Used disallowed intents” نظر آئے گا یا بوٹ کنیکٹ ہو جائے گا مگر پیغامات پر ردِعمل نہیں دے گا)
- **Server Members Intent** (سفارش کردہ؛ کچھ ممبر/یوزر تلاشوں اور guilds میں allowlist میچنگ کے لیے درکار)

You usually do **not** need **Presence Intent**. Setting the bot's own presence (`setPresence` action) uses gateway OP3 and does not require this intent; it is only needed if you want to receive presence updates about other guild members.

### 3. دعوتی URL بنائیں (OAuth2 URL Generator)

اپنی ایپ میں: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (native کمانڈز کے لیے درکار)

**Bot Permissions** (کم از کم بنیاد)

- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions (اختیاری مگر سفارش کردہ)
- ✅ Use External Emojis / Stickers (اختیاری؛ صرف اگر آپ چاہتے ہوں)

**Administrator** سے پرہیز کریں جب تک آپ ڈیبگ نہ کر رہے ہوں اور بوٹ پر مکمل اعتماد نہ ہو۔

تیار شدہ URL کاپی کریں، کھولیں، اپنا سرور منتخب کریں، اور بوٹ انسٹال کریں۔

### 4. ids حاصل کریں (guild/user/channel)

Discord ہر جگہ عددی ids استعمال کرتا ہے؛ OpenClaw کنفیگ ids کو ترجیح دیتا ہے۔

1. Discord (ڈیسک ٹاپ/ویب) → **User Settings** → **Advanced** → **Developer Mode** فعال کریں
2. رائٹ کلک کریں:
   - سرور نام → **Copy Server ID** (guild id)
   - چینل (مثلاً `#help`) → **Copy Channel ID**
   - اپنا یوزر → **Copy User ID**

### 5) OpenClaw کنفیگر کریں

#### Token

env var کے ذریعے بوٹ ٹوکن سیٹ کریں (سرورز پر سفارش کردہ):

- `DISCORD_BOT_TOKEN=...`

یا کنفیگ کے ذریعے:

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

ملٹی اکاؤنٹ سپورٹ: ہر اکاؤنٹ کے ٹوکنز کے ساتھ `channels.discord.accounts` استعمال کریں اور اختیاری `name` شامل کریں۔ See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern.

#### Allowlist + چینل روٹنگ

مثال “ایک سرور، صرف مجھے اجازت، صرف #help کی اجازت”:

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

نوٹس:

- `requireMention: true` کا مطلب ہے کہ بوٹ صرف mention ہونے پر جواب دیتا ہے (مشترکہ چینلز کے لیے سفارش کردہ)۔
- `agents.list[].groupChat.mentionPatterns` (یا `messages.groupChat.mentionPatterns`) بھی guild پیغامات کے لیے mention شمار ہوتے ہیں۔
- ملٹی ایجنٹ اووررائیڈ: `agents.list[].groupChat.mentionPatterns` پر فی ایجنٹ پیٹرنز سیٹ کریں۔
- اگر `channels` موجود ہو تو فہرست میں شامل نہ ہونے والا کوئی بھی چینل بطورِ طے شدہ مسترد ہو جاتا ہے۔
- تمام چینلز پر ڈیفالٹس لاگو کرنے کے لیے `"*"` چینل انٹری استعمال کریں؛ واضح چینل انٹریز وائلڈکارڈ پر غالب آتی ہیں۔
- Threads inherit parent channel config (allowlist, `requireMention`, skills, prompts, etc.) unless you add the thread channel id explicitly.
- Owner hint: when a per-guild or per-channel `users` allowlist matches the sender, OpenClaw treats that sender as the owner in the system prompt. For a global owner across channels, set `commands.ownerAllowFrom`.
- بوٹ کی اپنی تحریر کردہ پیغامات بطورِ طے شدہ نظرانداز ہوتے ہیں؛ اجازت دینے کے لیے `channels.discord.allowBots=true` سیٹ کریں (اپنے پیغامات فلٹر رہتے ہیں)۔
- Warning: If you allow replies to other bots (`channels.discord.allowBots=true`), prevent bot-to-bot reply loops with `requireMention`, `channels.discord.guilds.*.channels.<id>.users` allowlists, and/or clear guardrails in `AGENTS.md` and `SOUL.md`.

### 6. تصدیق کریں کہ یہ کام کر رہا ہے

1. gateway شروع کریں۔
2. اپنے سرور چینل میں بھیجیں: `@Krill hello` (یا جو بھی آپ کے بوٹ کا نام ہو)۔
3. اگر کچھ نہ ہو: نیچے **Troubleshooting** چیک کریں۔

### Troubleshooting

- سب سے پہلے: `openclaw doctor` اور `openclaw channels status --probe` چلائیں (قابلِ عمل وارننگز + فوری آڈٹس)۔
- **“Used disallowed intents”**: Developer Portal میں **Message Content Intent** (اور غالباً **Server Members Intent**) فعال کریں، پھر gateway ری اسٹارٹ کریں۔
- **بوٹ کنیکٹ ہوتا ہے مگر guild چینل میں کبھی جواب نہیں دیتا**:
  - **Message Content Intent** غائب ہے، یا
  - بوٹ کے پاس چینل اجازتیں نہیں (View/Send/Read History)، یا
  - آپ کی کنفیگ mentions لازمی کرتی ہے اور آپ نے mention نہیں کیا، یا
  - آپ کی guild/چینل allowlist چینل/یوزر کو مسترد کرتی ہے۔
- **`requireMention: false` مگر پھر بھی کوئی جواب نہیں**:
- `channels.discord.groupPolicy` defaults to **allowlist**; set it to `"open"` or add a guild entry under `channels.discord.guilds` (optionally list channels under `channels.discord.guilds.<id>.channels` to restrict).
  - If you only set `DISCORD_BOT_TOKEN` and never create a `channels.discord` section, the runtime
    defaults `groupPolicy` to `open`. Add `channels.discord.groupPolicy`,
    `channels.defaults.groupPolicy`, or a guild/channel allowlist to lock it down.
- `requireMention` must live under `channels.discord.guilds` (or a specific channel). `channels.discord.requireMention` at the top level is ignored.
- **Permission audits** (`channels status --probe`) only check numeric channel IDs. If you use slugs/names as `channels.discord.guilds.*.channels` keys, the audit can’t verify permissions.
- **DMs کام نہیں کرتیں**: `channels.discord.dm.enabled=false`، `channels.discord.dm.policy="disabled"`، یا ابھی تک منظوری نہیں ملی (`channels.discord.dm.policy="pairing"`)۔
- **Exec approvals in Discord**: Discord supports a **button UI** for exec approvals in DMs (Allow once / Always allow / Deny). `/approve <id> ...` is only for forwarded approvals and won’t resolve Discord’s button prompts. If you see `❌ Failed to submit approval: Error: unknown approval id` or the UI never shows up, check:
  - اپنی کنفیگ میں `channels.discord.execApprovals.enabled: true`۔
  - آپ کا Discord user ID `channels.discord.execApprovals.approvers` میں درج ہو (UI صرف approvers کو بھیجی جاتی ہے)۔
  - DM پرامپٹ میں بٹن استعمال کریں (**Allow once**، **Always allow**، **Deny**)۔
  - مزید کے لیے [Exec approvals](/tools/exec-approvals) اور [Slash commands](/tools/slash-commands) دیکھیں۔

## Capabilities & limits

- DMs اور guild ٹیکسٹ چینلز (threads کو الگ چینلز سمجھا جاتا ہے؛ voice سپورٹ نہیں)۔
- Typing indicators بہترین کوشش کے ساتھ بھیجے جاتے ہیں؛ پیغام chunking `channels.discord.textChunkLimit` (default 2000) استعمال کرتی ہے اور لمبے جوابات لائن کاؤنٹ کے مطابق تقسیم کرتی ہے (`channels.discord.maxLinesPerMessage`, default 17)۔
- اختیاری newline chunking: لمبائی کے مطابق chunking سے پہلے خالی لائنوں (پیراگراف حدود) پر تقسیم کے لیے `channels.discord.chunkMode="newline"` سیٹ کریں۔
- فائل اپ لوڈز کنفیگر شدہ `channels.discord.mediaMaxMb` تک سپورٹ (default 8 MB)۔
- شور سے بچنے کے لیے بطورِ طے شدہ mention-gated guild جوابات۔
- جب کوئی پیغام کسی دوسرے پیغام کا حوالہ دیتا ہے تو reply context شامل کیا جاتا ہے (quoted مواد + ids)۔
- Native reply threading بطورِ طے شدہ **بند** ہے؛ `channels.discord.replyToMode` اور reply tags کے ساتھ فعال کریں۔

## Retry policy

Outbound Discord API calls retry on rate limits (429) using Discord `retry_after` when available, with exponential backoff and jitter. Configure via `channels.discord.retry`. See [Retry policy](/concepts/retry).

## Config

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

Ack reactions are controlled globally via `messages.ackReaction` +
`messages.ackReactionScope`. Use `messages.removeAckAfterReply` to clear the
ack reaction after the bot replies.

- `dm.enabled`: تمام DMs نظرانداز کرنے کے لیے `false` سیٹ کریں (default `true`)۔
- `dm.policy`: DM access control (`pairing` recommended). `"open"` requires `dm.allowFrom=["*"]`.
- `dm.allowFrom`: DM allowlist (user ids or names). Used by `dm.policy="allowlist"` and for `dm.policy="open"` validation. The wizard accepts usernames and resolves them to ids when the bot can search members.
- `dm.groupEnabled`: group DMs فعال کریں (default `false`)۔
- `dm.groupChannels`: group DM چینل ids یا slugs کے لیے اختیاری allowlist۔
- `groupPolicy`: guild چینل ہینڈلنگ کنٹرول (`open|disabled|allowlist`)؛ `allowlist` کے لیے چینل allowlists درکار ہیں۔
- `guilds`: فی-guild قواعد، guild id (ترجیحی) یا slug کے ساتھ۔
- `guilds."*"`: جب کوئی واضح انٹری نہ ہو تو لاگو ہونے والی فی-guild ڈیفالٹ سیٹنگز۔
- `guilds.<id>.slug`: optional friendly slug used for display names.
- `guilds.<id>.users`: optional per-guild user allowlist (ids or names).
- `guilds.<id>.tools`: optional per-guild tool policy overrides (`allow`/`deny`/`alsoAllow`) used when the channel override is missing.
- `guilds.<id>.toolsBySender`: optional per-sender tool policy overrides at the guild level (applies when the channel override is missing; `"*"` wildcard supported).
- `guilds.<id>.channels.<channel>.allow`: allow/deny the channel when `groupPolicy="allowlist"`.
- `guilds.<id>.channels.<channel>.requireMention`: mention gating for the channel.
- `guilds.<id>.channels.<channel>.tools`: optional per-channel tool policy overrides (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender`: optional per-sender tool policy overrides within the channel (`"*"` wildcard supported).
- `guilds.<id>.channels.<channel>.users`: optional per-channel user allowlist.
- `guilds.<id>.channels.<channel>.skills`: skill filter (omit = all skills, empty = none).
- `guilds.<id>.channels.<channel>.systemPrompt`: extra system prompt for the channel. Discord channel topics are injected as **untrusted** context (not system prompt).
- `guilds.<id>.channels.<channel>.enabled`: set `false` to disable the channel.
- `guilds.<id>.channels`: channel rules (keys are channel slugs or ids).
- `guilds.<id>.requireMention`: per-guild mention requirement (overridable per channel).
- `guilds.<id>.reactionNotifications`: reaction system event mode (`off`, `own`, `all`, `allowlist`).
- `textChunkLimit`: outbound text chunk size (chars). Default: 2000.
- `chunkMode`: `length` (default) صرف `textChunkLimit` سے تجاوز پر تقسیم کرتا ہے؛ `newline` لمبائی سے پہلے خالی لائنوں پر تقسیم کرتا ہے۔
- `maxLinesPerMessage`: soft max line count per message. Default: 17.
- `mediaMaxMb`: ڈسک پر محفوظ ہونے والی inbound میڈیا کو clamp کریں۔
- `historyLimit`: mention پر جواب دیتے وقت شامل کیے جانے والے حالیہ guild پیغامات کی تعداد (default 20؛ فالبیک `messages.groupChat.historyLimit`; `0` غیر فعال کرتا ہے)۔
- `dmHistoryLimit`: DM history limit in user turns. Per-user overrides: `dms["<user_id>"].historyLimit`.
- `retry`: بیرونی Discord API کالز کے لیے retry پالیسی (attempts, minDelayMs, maxDelayMs, jitter)۔
- `pluralkit`: PluralKit proxied پیغامات حل کریں تاکہ سسٹم ممبرز الگ بھیجنے والوں کے طور پر نظر آئیں۔
- `actions`: فی-ایکشن ٹول گیٹس؛ سب کی اجازت کے لیے خالی چھوڑیں (غیر فعال کرنے کے لیے `false` سیٹ کریں)۔
  - `reactions` (react + read reactions کا احاطہ)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (چینلز/کیٹیگریز/اجازتیں بنانا/ترمیم/حذف)
  - `roles` (رول شامل/ہٹانا، default `false`)
  - `moderation` (timeout/kick/ban، default `false`)
  - `presence` (بوٹ اسٹیٹس/ایکٹیویٹی، default `false`)
- `execApprovals`: Discord-only exec approval DMs (button UI). Supports `enabled`, `approvers`, `agentFilter`, `sessionFilter`.

Reaction notifications use `guilds.<id>.reactionNotifications`:

- `off`: کوئی reaction events نہیں۔
- `own`: بوٹ کے اپنے پیغامات پر reactions (default)۔
- `all`: تمام پیغامات پر تمام reactions۔
- `allowlist`: reactions from `guilds.<id>.users` on all messages (empty list disables).

### PluralKit (PK) سپورٹ

Enable PK lookups so proxied messages resolve to the underlying system + member.
When enabled, OpenClaw uses the member identity for allowlists and labels the
sender as `Member (PK:System)` to avoid accidental Discord pings.

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

Allowlist نوٹس (PK فعال):

- Use `pk:<memberId>` in `dm.allowFrom`, `guilds.<id>.users`, or per-channel `users`.
- ممبر ڈسپلے نام بھی نام/slug کے ذریعے میچ ہوتے ہیں۔
- Lookups **اصل** Discord message ID استعمال کرتے ہیں (pre-proxy پیغام)، اس لیے
  PK API اسے صرف اپنی 30 منٹ کی ونڈو کے اندر حل کرتی ہے۔
- اگر PK lookups ناکام ہوں (مثلاً ٹوکن کے بغیر نجی سسٹم)، تو proxied پیغامات
  بوٹ پیغامات سمجھے جاتے ہیں اور `channels.discord.allowBots=true` نہ ہو تو ڈراپ ہو جاتے ہیں۔

### Tool action defaults

| Action group   | Default  | Notes                                                 |
| -------------- | -------- | ----------------------------------------------------- |
| reactions      | enabled  | React + list reactions + emojiList                    |
| stickers       | enabled  | اسٹیکرز بھیجیں                                        |
| emojiUploads   | enabled  | ایموجیز اپ لوڈ کریں                                   |
| stickerUploads | enabled  | اسٹیکرز اپ لوڈ کریں                                   |
| polls          | enabled  | پولز بنائیں                                           |
| permissions    | enabled  | چینل اجازتوں کا اسنیپ شاٹ                             |
| messages       | enabled  | پڑھیں/بھیجیں/ترمیم/حذف                                |
| threads        | enabled  | بنائیں/فہرست/جواب                                     |
| pins           | enabled  | پن/ان پن/فہرست                                        |
| search         | enabled  | پیغام تلاش (پری ویو فیچر)          |
| memberInfo     | enabled  | ممبر معلومات                                          |
| roleInfo       | enabled  | رول فہرست                                             |
| channelInfo    | enabled  | چینل معلومات + فہرست                                  |
| channels       | enabled  | چینل/کیٹیگری مینجمنٹ                                  |
| voiceStatus    | enabled  | وائس اسٹیٹ تلاش                                       |
| events         | enabled  | شیڈولڈ ایونٹس فہرست/بنائیں                            |
| roles          | disabled | رول شامل/ہٹائیں                                       |
| moderation     | disabled | Timeout/kick/ban                                      |
| presence       | disabled | بوٹ اسٹیٹس/ایکٹیویٹی (setPresence) |

- `replyToMode`: `off` (default), `first`, or `all`. Applies only when the model includes a reply tag.

## Reply tags

تھریڈڈ جواب کی درخواست کے لیے، ماڈل اپنی آؤٹ پٹ میں ایک ٹیگ شامل کر سکتا ہے:

- `[[reply_to_current]]` — ٹرگر کرنے والے Discord پیغام کو جواب۔
- `[[reply_to:<id>]]` — reply to a specific message id from context/history.
  Current message ids are appended to prompts as `[message_id: …]`; history entries already include ids.

رویّہ `channels.discord.replyToMode` کے ذریعے کنٹرول ہوتا ہے:

- `off`: ٹیگز نظرانداز کریں۔
- `first`: صرف پہلا outbound chunk/attachment جواب ہوتا ہے۔
- `all`: ہر outbound chunk/attachment جواب ہوتا ہے۔

Allowlist میچنگ نوٹس:

- `allowFrom`/`users`/`groupChannels` ids، نام، tags، یا `<@id>` جیسے mentions قبول کرتے ہیں۔
- `discord:`/`user:` (یوزرز) اور `channel:` (group DMs) جیسے prefixes سپورٹڈ ہیں۔
- کسی بھی بھیجنے والے/چینل کی اجازت کے لیے `*` استعمال کریں۔
- When `guilds.<id>.channels` is present, channels not listed are denied by default.
- When `guilds.<id>.channels` is omitted, all channels in the allowlisted guild are allowed.
- **کوئی چینل اجازت نہ دینے** کے لیے `channels.discord.groupPolicy: "disabled"` سیٹ کریں (یا خالی allowlist رکھیں)۔
- کنفیگر وزارڈ `Guild/Channel` نام (عوامی + نجی) قبول کرتا ہے اور ممکن ہو تو انہیں IDs میں حل کرتا ہے۔
- اسٹارٹ اپ پر، OpenClaw allowlists میں چینل/یوزر نام IDs میں حل کرتا ہے (جب بوٹ ممبرز تلاش کر سکے)
  اور میپنگ لاگ کرتا ہے؛ غیر حل شدہ انٹریز جیسی کی تیسی رہتی ہیں۔

Native کمانڈ نوٹس:

- رجسٹرڈ کمانڈز OpenClaw کی چیٹ کمانڈز کی عکاسی کرتی ہیں۔
- Native کمانڈز DMs/guild پیغامات جیسی ہی allowlists کی پابندی کرتی ہیں (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, فی-چینل قواعد)۔
- Slash کمانڈز Discord UI میں اُن یوزرز کو بھی نظر آ سکتی ہیں جو allowlisted نہ ہوں؛ OpenClaw عمل درآمد پر allowlists نافذ کرتا ہے اور “not authorized” کے ساتھ جواب دیتا ہے۔

## Tool actions

ایجنٹ `discord` کو درج ذیل ایکشنز کے ساتھ کال کر سکتا ہے:

- `react` / `reactions` (reactions شامل یا فہرست)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- Read/search/pin ٹول payloads میں نارملائزڈ `timestampMs` (UTC epoch ms) اور `timestampUtc` کے ساتھ خام Discord `timestamp` شامل ہوتا ہے۔
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (بوٹ ایکٹیویٹی اور آن لائن اسٹیٹس)

Discord message ids are surfaced in the injected context (`[discord message id: …]` and history lines) so the agent can target them.
Emoji can be unicode (e.g., `✅`) or custom emoji syntax like `<:party_blob:1234567890>`.

## Safety & ops

- بوٹ ٹوکن کو پاس ورڈ کی طرح محفوظ رکھیں؛ نگرانی شدہ ہوسٹس پر `DISCORD_BOT_TOKEN` env var کو ترجیح دیں یا کنفیگ فائل کی اجازتیں محدود کریں۔
- بوٹ کو صرف اتنی ہی اجازتیں دیں جتنی درکار ہوں (عموماً Read/Send Messages)۔
- اگر بوٹ اٹک جائے یا rate limited ہو تو Discord سیشن پر کسی اور پروسیس کی ملکیت کی تصدیق کے بعد gateway (`openclaw gateway --force`) ری اسٹارٹ کریں۔
