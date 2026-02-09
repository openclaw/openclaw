---
summary: "مختلف پلیٹ فارمز پر گروپ چیٹ کا رویہ (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - گروپ چیٹ کے رویے یا منشن گیٹنگ میں تبدیلی کرتے وقت
title: "گروپس"
---

# گروپس

OpenClaw مختلف پلیٹ فارمز پر گروپ چیٹس کو یکساں طور پر سنبھالتا ہے: WhatsApp، Telegram، Discord، Slack، Signal، iMessage، Microsoft Teams۔

## مبتدی تعارف (2 منٹ)

OpenClaw “lives” on your own messaging accounts. There is no separate WhatsApp bot user.
If **you** are in a group, OpenClaw can see that group and respond there.

بطورِ طے شدہ رویہ:

- گروپس محدود ہوتے ہیں (`groupPolicy: "allowlist"`)۔
- جوابات کے لیے منشن درکار ہوتی ہے، جب تک کہ آپ واضح طور پر منشن گیٹنگ کو غیر فعال نہ کریں۔

ترجمہ: اجازت فہرست میں شامل ارسال کنندگان، منشن کے ذریعے OpenClaw کو متحرک کر سکتے ہیں۔

> TL;DR
>
> - **DM رسائی** `*.allowFrom` کے ذریعے کنٹرول ہوتی ہے۔
> - **گروپ رسائی** `*.groupPolicy` + اجازت فہرستیں (`*.groups`، `*.groupAllowFrom`) کے ذریعے کنٹرول ہوتی ہے۔
> - **جواب کی ٹرگرنگ** منشن گیٹنگ (`requireMention`، `/activation`) کے ذریعے کنٹرول ہوتی ہے۔

فوری بہاؤ (گروپ پیغام کے ساتھ کیا ہوتا ہے):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Group message flow](/images/groups-flow.svg)

اگر آپ چاہتے ہیں...

| مقصد                                                                | کیا سیٹ کریں                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| تمام گروپس کی اجازت دیں لیکن صرف @mentions پر جواب دیں | `groups: { "*": { requireMention: true } }`                           |
| تمام گروپ جوابات غیر فعال کریں                                      | `groupPolicy: "disabled"`                                             |
| صرف مخصوص گروپس                                                     | `groups: { "<group-id>": { ... } }` (no `"*"` key) |
| گروپس میں صرف آپ ہی ٹرگر کر سکیں                                    | `groupPolicy: "allowlist"`، `groupAllowFrom: ["+1555..."]`            |

## سیشن کیز

- گروپ سیشنز `agent:<agentId>:<channel>:group:<id>` سیشن کیز استعمال کرتے ہیں (رومز/چینلز `agent:<agentId>:<channel>:channel:<id>` استعمال کرتے ہیں)۔
- Telegram فورم موضوعات گروپ آئی ڈی میں `:topic:<threadId>` شامل کرتے ہیں تاکہ ہر موضوع کا الگ سیشن ہو۔
- براہِ راست چیٹس مرکزی سیشن استعمال کرتی ہیں (یا اگر کنفیگر ہو تو فی ارسال کنندہ)۔
- گروپ سیشنز کے لیے ہارٹ بیٹس چھوڑ دیے جاتے ہیں۔

## پیٹرن: ذاتی DMs + عوامی گروپس (سنگل ایجنٹ)

ہاں — یہ اچھی طرح کام کرتا ہے اگر آپ کی “ذاتی” ٹریفک **DMs** اور “عوامی” ٹریفک **گروپس** ہوں۔

Why: in single-agent mode, DMs typically land in the **main** session key (`agent:main:main`), while groups always use **non-main** session keys (`agent:main:<channel>:group:<id>`). If you enable sandboxing with `mode: "non-main"`, those group sessions run in Docker while your main DM session stays on-host.

اس طرح آپ کے پاس ایک ایجنٹ “دماغ” (مشترکہ ورک اسپیس + میموری) ہوتا ہے، مگر دو ایکزیکیوشن انداز:

- **DMs**: مکمل ٹولز (ہوسٹ)
- **گروپس**: sandbox + محدود ٹولز (Docker)

> If you need truly separate workspaces/personas (“personal” and “public” must never mix), use a second agent + bindings. See [Multi-Agent Routing](/concepts/multi-agent).

مثال (DMs ہوسٹ پر، گروپس sandboxed + صرف میسجنگ ٹولز):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

Want “groups can only see folder X” instead of “no host access”? Keep `workspaceAccess: "none"` and mount only allowlisted paths into the sandbox:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "~/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

متعلقہ:

- کنفیگریشن کیز اور ڈیفالٹس: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)
- یہ جانچنا کہ کوئی ٹول کیوں بلاک ہوا: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- بائنڈ ماؤنٹس کی تفصیلات: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## ڈسپلے لیبلز

- UI لیبلز دستیاب ہونے پر `displayName` استعمال کرتے ہیں، اور `<channel>:<token>` کی شکل میں فارمیٹ ہوتے ہیں۔
- `#room` رومز/چینلز کے لیے مخصوص ہے؛ گروپ چیٹس `g-<slug>` استعمال کرتی ہیں (لوئرکیس، اسپیسز -> `-`، `#@+._-` برقرار رکھیں)۔

## گروپ پالیسی

ہر چینل کے لیے گروپ/روم پیغامات کے ہینڈلنگ کو کنٹرول کریں:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", "@username"],
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| پالیسی        | رویہ                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| `"open"`      | گروپس اجازت فہرستوں کو بائی پاس کرتے ہیں؛ منشن گیٹنگ بدستور لاگو رہتی ہے۔ |
| `"disabled"`  | تمام گروپ پیغامات مکمل طور پر بلاک کریں۔                                  |
| `"allowlist"` | صرف وہی گروپس/رومز اجازت دیں جو کنفیگر کردہ اجازت فہرست سے میچ ہوں۔       |

نوٹس:

- `groupPolicy` منشن گیٹنگ سے الگ ہے (جس کے لیے @mentions درکار ہوتی ہیں)۔
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: `groupAllowFrom` استعمال کریں (فال بیک: واضح `allowFrom`)۔
- Discord: allowlist uses `channels.discord.guilds.<id>.channels`.
- Slack: اجازت فہرست `channels.slack.channels` استعمال کرتی ہے۔
- Matrix: allowlist uses `channels.matrix.groups` (room IDs, aliases, or names). Use `channels.matrix.groupAllowFrom` to restrict senders; per-room `users` allowlists are also supported.
- گروپ DMs علیحدہ طور پر کنٹرول ہوتی ہیں (`channels.discord.dm.*`، `channels.slack.dm.*`)۔
- Telegram اجازت فہرست یوزر آئی ڈیز (`"123456789"`، `"telegram:123456789"`، `"tg:123456789"`) یا یوزرنیمز (`"@alice"` یا `"alice"`) سے میچ کر سکتی ہے؛ پری فکس کیس اِن سنسِٹو ہوتے ہیں۔
- ڈیفالٹ `groupPolicy: "allowlist"` ہے؛ اگر آپ کی گروپ اجازت فہرست خالی ہو تو گروپ پیغامات بلاک ہو جاتے ہیں۔

فوری ذہنی ماڈل (گروپ پیغامات کے لیے جانچ کی ترتیب):

1. `groupPolicy` (اوپن/غیرفعال/اجازت فہرست)
2. گروپ اجازت فہرستیں (`*.groups`، `*.groupAllowFrom`، چینل مخصوص اجازت فہرست)
3. منشن گیٹنگ (`requireMention`، `/activation`)

## منشن گیٹنگ (ڈیفالٹ)

Group messages require a mention unless overridden per group. Defaults live per subsystem under `*.groups."*"`.

Replying to a bot message counts as an implicit mention (when the channel supports reply metadata). This applies to Telegram, WhatsApp, Slack, Discord, and Microsoft Teams.

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

نوٹس:

- `mentionPatterns` کیس اِن سنسِٹو ریجیکس ہیں۔
- جن پلیٹ فارمز میں واضح منشنز موجود ہوں وہ پھر بھی پاس ہو جاتے ہیں؛ پیٹرنز فال بیک ہیں۔
- فی ایجنٹ اووررائیڈ: `agents.list[].groupChat.mentionPatterns` (جب متعدد ایجنٹس ایک ہی گروپ شیئر کریں تو مفید)۔
- منشن گیٹنگ صرف تب نافذ ہوتی ہے جب منشن ڈیٹیکشن ممکن ہو (نیٹو منشنز یا `mentionPatterns` کنفیگر ہوں)۔
- Discord کے ڈیفالٹس `channels.discord.guilds."*"` میں ہیں (فی گلڈ/چینل اووررائیڈ ممکن)۔
- Group history context is wrapped uniformly across channels and is **pending-only** (messages skipped due to mention gating); use `messages.groupChat.historyLimit` for the global default and `channels.<channel>.historyLimit` (or `channels.<channel>.accounts.*.historyLimit`) for overrides. Set `0` to disable.

## گروپ/چینل ٹول پابندیاں (اختیاری)

کچھ چینل کنفیگز اس بات کی اجازت دیتے ہیں کہ **کسی مخصوص گروپ/روم/چینل کے اندر** کون سے ٹولز دستیاب ہوں۔

- `tools`: پورے گروپ کے لیے ٹولز کی اجازت/ممانعت۔
- `toolsBySender`: per-sender overrides within the group (keys are sender IDs/usernames/emails/phone numbers depending on the channel). Use `"*"` as a wildcard.

حل کی ترتیب (سب سے مخصوص کو ترجیح):

1. گروپ/چینل `toolsBySender` میچ
2. گروپ/چینل `tools`
3. ڈیفالٹ (`"*"`) `toolsBySender` میچ
4. ڈیفالٹ (`"*"`) `tools`

مثال (Telegram):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

نوٹس:

- گروپ/چینل ٹول پابندیاں عالمی/ایجنٹ ٹول پالیسی کے علاوہ لاگو ہوتی ہیں (ممانعت کو فوقیت حاصل رہتی ہے)۔
- کچھ چینلز رومز/چینلز کے لیے مختلف نیسٹنگ استعمال کرتے ہیں (مثلاً Discord `guilds.*.channels.*`، Slack `channels.*`، MS Teams `teams.*.channels.*`)۔

## گروپ اجازت فہرستیں

When `channels.whatsapp.groups`, `channels.telegram.groups`, or `channels.imessage.groups` is configured, the keys act as a group allowlist. Use `"*"` to allow all groups while still setting default mention behavior.

عام مقاصد (کاپی/پیسٹ):

1. تمام گروپ جوابات غیر فعال کریں

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. صرف مخصوص گروپس کی اجازت دیں (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. تمام گروپس کی اجازت دیں لیکن منشن لازمی رکھیں (واضح)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. گروپس میں صرف مالک ہی ٹرگر کر سکے (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## ایکٹیویشن (صرف مالک)

گروپ مالکان فی گروپ ایکٹیویشن ٹوگل کر سکتے ہیں:

- `/activation mention`
- `/activation always`

Owner is determined by `channels.whatsapp.allowFrom` (or the bot’s self E.164 when unset). Send the command as a standalone message. Other surfaces currently ignore `/activation`.

## کانٹیکسٹ فیلڈز

گروپ ان باؤنڈ پے لوڈز سیٹ کرتے ہیں:

- `ChatType=group`
- `GroupSubject` (اگر معلوم ہو)
- `GroupMembers` (اگر معلوم ہو)
- `WasMentioned` (منشن گیٹنگ کا نتیجہ)
- Telegram فورم موضوعات میں اضافی طور پر `MessageThreadId` اور `IsForum` شامل ہوتے ہیں۔

The agent system prompt includes a group intro on the first turn of a new group session. It reminds the model to respond like a human, avoid Markdown tables, and avoid typing literal `\n` sequences.

## iMessage کی مخصوص باتیں

- روٹنگ یا اجازت فہرست کے لیے `chat_id:<id>` کو ترجیح دیں۔
- چیٹس کی فہرست: `imsg chats --limit 20`۔
- گروپ جوابات ہمیشہ اسی `chat_id` پر واپس جاتے ہیں۔

## WhatsApp کی مخصوص باتیں

WhatsApp سے متعلق مخصوص رویے (ہسٹری انجیکشن، منشن ہینڈلنگ کی تفصیلات) کے لیے [Group messages](/channels/group-messages) دیکھیں۔
