---
summary: "مختلف پلیٹ فارمز پر گروپ چیٹ کا رویہ (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - گروپ چیٹ کے رویے یا منشن گیٹنگ میں تبدیلی کرتے وقت
title: "گروپس"
x-i18n:
  source_path: channels/groups.md
  source_hash: 5380e07ea01f4a8f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:18Z
---

# گروپس

OpenClaw مختلف پلیٹ فارمز پر گروپ چیٹس کو یکساں طور پر سنبھالتا ہے: WhatsApp، Telegram، Discord، Slack، Signal، iMessage، Microsoft Teams۔

## مبتدی تعارف (2 منٹ)

OpenClaw آپ کے اپنے میسجنگ اکاؤنٹس پر “رہتا” ہے۔ کوئی الگ WhatsApp بوٹ صارف موجود نہیں ہوتا۔
اگر **آپ** کسی گروپ میں ہیں تو OpenClaw اس گروپ کو دیکھ سکتا ہے اور وہیں جواب دے سکتا ہے۔

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

| مقصد                                                   | کیا سیٹ کریں                                               |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| تمام گروپس کی اجازت دیں لیکن صرف @mentions پر جواب دیں | `groups: { "*": { requireMention: true } }`                |
| تمام گروپ جوابات غیر فعال کریں                         | `groupPolicy: "disabled"`                                  |
| صرف مخصوص گروپس                                        | `groups: { "<group-id>": { ... } }` (کوئی `"*"` کلید نہیں) |
| گروپس میں صرف آپ ہی ٹرگر کر سکیں                       | `groupPolicy: "allowlist"`، `groupAllowFrom: ["+1555..."]` |

## سیشن کیز

- گروپ سیشنز `agent:<agentId>:<channel>:group:<id>` سیشن کیز استعمال کرتے ہیں (رومز/چینلز `agent:<agentId>:<channel>:channel:<id>` استعمال کرتے ہیں)۔
- Telegram فورم موضوعات گروپ آئی ڈی میں `:topic:<threadId>` شامل کرتے ہیں تاکہ ہر موضوع کا الگ سیشن ہو۔
- براہِ راست چیٹس مرکزی سیشن استعمال کرتی ہیں (یا اگر کنفیگر ہو تو فی ارسال کنندہ)۔
- گروپ سیشنز کے لیے ہارٹ بیٹس چھوڑ دیے جاتے ہیں۔

## پیٹرن: ذاتی DMs + عوامی گروپس (سنگل ایجنٹ)

ہاں — یہ اچھی طرح کام کرتا ہے اگر آپ کی “ذاتی” ٹریفک **DMs** اور “عوامی” ٹریفک **گروپس** ہوں۔

وجہ: سنگل ایجنٹ موڈ میں، DMs عموماً **مرکزی** سیشن کی (`agent:main:main`) میں آتی ہیں، جبکہ گروپس ہمیشہ **غیر مرکزی** سیشن کیز (`agent:main:<channel>:group:<id>`) استعمال کرتے ہیں۔ اگر آپ `mode: "non-main"` کے ساتھ sandboxing فعال کریں تو وہ گروپ سیشنز Docker میں چلتے ہیں جبکہ آپ کا مرکزی DM سیشن ہوسٹ پر ہی رہتا ہے۔

اس طرح آپ کے پاس ایک ایجنٹ “دماغ” (مشترکہ ورک اسپیس + میموری) ہوتا ہے، مگر دو ایکزیکیوشن انداز:

- **DMs**: مکمل ٹولز (ہوسٹ)
- **گروپس**: sandbox + محدود ٹولز (Docker)

> اگر آپ کو واقعی الگ ورک اسپیس/شخصیات درکار ہوں (“ذاتی” اور “عوامی” کبھی مکس نہ ہوں)، تو دوسرا ایجنٹ + bindings استعمال کریں۔ دیکھیں [Multi-Agent Routing](/concepts/multi-agent)۔

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

“گروپس صرف فولڈر X دیکھ سکیں” (بجائے “کوئی ہوسٹ رسائی نہیں”) چاہتے ہیں؟ `workspaceAccess: "none"` برقرار رکھیں اور صرف اجازت فہرست میں شامل راستے sandbox میں ماؤنٹ کریں:

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
- Discord: اجازت فہرست `channels.discord.guilds.<id>.channels` استعمال کرتی ہے۔
- Slack: اجازت فہرست `channels.slack.channels` استعمال کرتی ہے۔
- Matrix: اجازت فہرست `channels.matrix.groups` استعمال کرتی ہے (روم آئی ڈیز، عرفیات، یا نام)۔ ارسال کنندگان کو محدود کرنے کے لیے `channels.matrix.groupAllowFrom` استعمال کریں؛ فی روم `users` اجازت فہرستیں بھی سپورٹڈ ہیں۔
- گروپ DMs علیحدہ طور پر کنٹرول ہوتی ہیں (`channels.discord.dm.*`، `channels.slack.dm.*`)۔
- Telegram اجازت فہرست یوزر آئی ڈیز (`"123456789"`، `"telegram:123456789"`، `"tg:123456789"`) یا یوزرنیمز (`"@alice"` یا `"alice"`) سے میچ کر سکتی ہے؛ پری فکس کیس اِن سنسِٹو ہوتے ہیں۔
- ڈیفالٹ `groupPolicy: "allowlist"` ہے؛ اگر آپ کی گروپ اجازت فہرست خالی ہو تو گروپ پیغامات بلاک ہو جاتے ہیں۔

فوری ذہنی ماڈل (گروپ پیغامات کے لیے جانچ کی ترتیب):

1. `groupPolicy` (اوپن/غیرفعال/اجازت فہرست)
2. گروپ اجازت فہرستیں (`*.groups`، `*.groupAllowFrom`، چینل مخصوص اجازت فہرست)
3. منشن گیٹنگ (`requireMention`، `/activation`)

## منشن گیٹنگ (ڈیفالٹ)

گروپ پیغامات کے لیے منشن درکار ہوتی ہے، جب تک کہ فی گروپ اووررائیڈ نہ کیا جائے۔ ڈیفالٹس ہر سب سسٹم کے تحت `*.groups."*"` میں موجود ہیں۔

بوٹ کے پیغام کا جواب دینا ضمنی منشن شمار ہوتا ہے (جب چینل ریپلائی میٹاڈیٹا سپورٹ کرتا ہو)۔ یہ Telegram، WhatsApp، Slack، Discord، اور Microsoft Teams پر لاگو ہوتا ہے۔

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
- گروپ ہسٹری کانٹیکسٹ تمام چینلز میں یکساں طور پر لپٹا ہوتا ہے اور **صرف زیرِ التواء** (منشن گیٹنگ کی وجہ سے چھوڑے گئے پیغامات) پر مشتمل ہوتا ہے؛ عالمی ڈیفالٹ کے لیے `messages.groupChat.historyLimit` اور اووررائیڈز کے لیے `channels.<channel>.historyLimit` (یا `channels.<channel>.accounts.*.historyLimit`) استعمال کریں۔ غیر فعال کرنے کے لیے `0` سیٹ کریں۔

## گروپ/چینل ٹول پابندیاں (اختیاری)

کچھ چینل کنفیگز اس بات کی اجازت دیتے ہیں کہ **کسی مخصوص گروپ/روم/چینل کے اندر** کون سے ٹولز دستیاب ہوں۔

- `tools`: پورے گروپ کے لیے ٹولز کی اجازت/ممانعت۔
- `toolsBySender`: گروپ کے اندر فی ارسال کنندہ اووررائیڈز (کلیدیں چینل کے مطابق sender IDs/یوزرنیمز/ای میلز/فون نمبرز ہوتی ہیں)۔ وائلڈ کارڈ کے طور پر `"*"` استعمال کریں۔

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

جب `channels.whatsapp.groups`، `channels.telegram.groups`، یا `channels.imessage.groups` کنفیگر ہوں تو یہ کیز گروپ اجازت فہرست کے طور پر کام کرتی ہیں۔ تمام گروپس کی اجازت دیتے ہوئے بھی ڈیفالٹ منشن رویہ سیٹ رکھنے کے لیے `"*"` استعمال کریں۔

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

مالک کا تعین `channels.whatsapp.allowFrom` کے ذریعے ہوتا ہے (یا اگر سیٹ نہ ہو تو بوٹ کے خود کے E.164 کے ذریعے)۔ کمانڈ کو بطور الگ پیغام بھیجیں۔ دیگر پلیٹ فارمز فی الحال `/activation` کو نظرانداز کرتے ہیں۔

## کانٹیکسٹ فیلڈز

گروپ ان باؤنڈ پے لوڈز سیٹ کرتے ہیں:

- `ChatType=group`
- `GroupSubject` (اگر معلوم ہو)
- `GroupMembers` (اگر معلوم ہو)
- `WasMentioned` (منشن گیٹنگ کا نتیجہ)
- Telegram فورم موضوعات میں اضافی طور پر `MessageThreadId` اور `IsForum` شامل ہوتے ہیں۔

ایجنٹ سسٹم پرامپٹ میں نئے گروپ سیشن کے پہلے ٹرن پر گروپ تعارف شامل ہوتا ہے۔ یہ ماڈل کو انسان کی طرح جواب دینے، Markdown ٹیبلز سے گریز کرنے، اور لفظی `\n` تسلسل ٹائپ کرنے سے بچنے کی یاددہانی کراتا ہے۔

## iMessage کی مخصوص باتیں

- روٹنگ یا اجازت فہرست کے لیے `chat_id:<id>` کو ترجیح دیں۔
- چیٹس کی فہرست: `imsg chats --limit 20`۔
- گروپ جوابات ہمیشہ اسی `chat_id` پر واپس جاتے ہیں۔

## WhatsApp کی مخصوص باتیں

WhatsApp سے متعلق مخصوص رویے (ہسٹری انجیکشن، منشن ہینڈلنگ کی تفصیلات) کے لیے [Group messages](/channels/group-messages) دیکھیں۔
