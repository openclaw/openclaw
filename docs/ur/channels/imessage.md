---
summary: "imsg کے ذریعے لیگیسی iMessage سپورٹ (stdio پر JSON-RPC)۔ نئی سیٹ اپس کے لیے BlueBubbles استعمال کریں۔"
read_when:
  - iMessage سپورٹ سیٹ اپ کرنا
  - iMessage بھیجنے/وصول کرنے کی ڈیبگنگ
title: iMessage
x-i18n:
  source_path: channels/imessage.md
  source_hash: b418a589547d1ef0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:22Z
---

# iMessage (لیگیسی: imsg)

> **سفارش کردہ:** نئی iMessage سیٹ اپس کے لیے [BlueBubbles](/channels/bluebubbles) استعمال کریں۔
>
> `imsg` چینل ایک لیگیسی بیرونی CLI انٹیگریشن ہے اور آئندہ ریلیز میں ہٹایا جا سکتا ہے۔

حیثیت: لیگیسی بیرونی CLI انٹیگریشن۔ Gateway `imsg rpc` (stdio پر JSON-RPC) کو اسپان کرتا ہے۔

## فوری سیٹ اپ (مبتدی)

1. یقینی بنائیں کہ اس Mac پر Messages میں سائن اِن ہے۔
2. `imsg` انسٹال کریں:
   - `brew install steipete/tap/imsg`
3. OpenClaw کو `channels.imessage.cliPath` اور `channels.imessage.dbPath` کے ساتھ کنفیگر کریں۔
4. گیٹ وے شروع کریں اور macOS کے کسی بھی پرامپٹس (Automation + Full Disk Access) کی منظوری دیں۔

کم از کم کنفیگ:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## یہ کیا ہے

- macOS پر `imsg` پر مبنی iMessage چینل۔
- متعین روٹنگ: جوابات ہمیشہ iMessage پر واپس جاتے ہیں۔
- DMs ایجنٹ کے مرکزی سیشن کو شیئر کرتے ہیں؛ گروپس الگ ہوتے ہیں (`agent:<agentId>:imessage:group:<chat_id>`)۔
- اگر متعدد شرکاء والی تھریڈ `is_group=false` کے ساتھ آئے، تو آپ پھر بھی اسے `chat_id` کے ذریعے `channels.imessage.groups` استعمال کرتے ہوئے الگ کر سکتے ہیں (نیچے “Group-ish threads” دیکھیں)۔

## کنفیگ لکھائی

بطورِ طے شدہ، iMessage کو `/config set|unset` کے ذریعے متحرک ہونے والی کنفیگ اپڈیٹس لکھنے کی اجازت ہے (اس کے لیے `commands.config: true` درکار ہے)۔

غیرفعال کرنے کے لیے:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## ضروریات

- macOS جس پر Messages میں سائن اِن ہو۔
- OpenClaw + `imsg` کے لیے Full Disk Access (Messages DB تک رسائی)۔
- بھیجتے وقت Automation کی اجازت۔
- `channels.imessage.cliPath` کسی بھی ایسے کمانڈ کی طرف اشارہ کر سکتا ہے جو stdin/stdout کو پراکسی کرے (مثلاً ایک ریپر اسکرپٹ جو SSH کے ذریعے دوسرے Mac سے جڑ کر `imsg rpc` چلاتا ہے)۔

## macOS Privacy and Security TCC کی خرابیوں کا ازالہ

اگر بھیجنا/وصول کرنا ناکام ہو (مثلاً `imsg rpc` نان زیرو کے ساتھ ختم ہو جائے، ٹائم آؤٹ ہو، یا گیٹ وے ہینگ ہوتا نظر آئے)، تو ایک عام وجہ macOS کی اجازت کا پرامپٹ ہوتا ہے جسے کبھی منظور نہیں کیا گیا۔

macOS TCC اجازتیں ہر ایپ/پروسیس کنٹیکسٹ کے مطابق دیتا ہے۔ اسی کنٹیکسٹ میں پرامپٹس منظور کریں جو `imsg` چلاتا ہے (مثلاً Terminal/iTerm، LaunchAgent سیشن، یا SSH سے لانچ کیا گیا پروسیس)۔

چیک لسٹ:

- **Full Disk Access**: اس پروسیس کے لیے اجازت دیں جو OpenClaw چلا رہا ہے (اور کوئی بھی shell/SSH ریپر جو `imsg` ایکزیکیوٹ کرتا ہے)۔ یہ Messages ڈیٹابیس (`chat.db`) پڑھنے کے لیے ضروری ہے۔
- **Automation → Messages**: آؤٹ باؤنڈ بھیجنے کے لیے OpenClaw چلانے والے پروسیس (اور/یا آپ کے ٹرمینل) کو **Messages.app** کنٹرول کرنے کی اجازت دیں۔
- **`imsg` CLI صحت**: تصدیق کریں کہ `imsg` انسٹال ہے اور RPC (`imsg rpc --help`) کو سپورٹ کرتا ہے۔

مشورہ: اگر OpenClaw ہیڈ لیس (LaunchAgent/systemd/SSH) چل رہا ہو تو macOS پرامپٹ آسانی سے نظر سے اوجھل ہو سکتا ہے۔ GUI ٹرمینل میں ایک بار انٹرایکٹو کمانڈ چلائیں تاکہ پرامپٹ ظاہر ہو جائے، پھر دوبارہ کوشش کریں:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

متعلقہ macOS فولڈر اجازتیں (Desktop/Documents/Downloads): [/platforms/mac/permissions](/platforms/mac/permissions)۔

## سیٹ اپ (فاسٹ پاتھ)

1. یقینی بنائیں کہ اس Mac پر Messages میں سائن اِن ہے۔
2. iMessage کنفیگر کریں اور گیٹ وے شروع کریں۔

### مخصوص بوٹ macOS صارف (شناخت کی علیحدگی کے لیے)

اگر آپ چاہتے ہیں کہ بوٹ **علیحدہ iMessage شناخت** سے بھیجے (اور آپ کے ذاتی Messages صاف رہیں)، تو ایک مخصوص Apple ID + ایک مخصوص macOS صارف استعمال کریں۔

1. ایک مخصوص Apple ID بنائیں (مثال: `my-cool-bot@icloud.com`)۔
   - Apple توثیق / 2FA کے لیے فون نمبر مانگ سکتا ہے۔
2. ایک macOS صارف بنائیں (مثال: `openclawhome`) اور اس میں سائن اِن کریں۔
3. اسی macOS صارف میں Messages کھولیں اور بوٹ Apple ID سے iMessage میں سائن اِن کریں۔
4. Remote Login فعال کریں (System Settings → General → Sharing → Remote Login)۔
5. `imsg` انسٹال کریں:
   - `brew install steipete/tap/imsg`
6. SSH اس طرح سیٹ اپ کریں کہ `ssh <bot-macos-user>@localhost true` بغیر پاس ورڈ کے کام کرے۔
7. `channels.imessage.accounts.bot.cliPath` کو ایسے SSH ریپر کی طرف پوائنٹ کریں جو بوٹ صارف کے طور پر `imsg` چلائے۔

پہلی بار نوٹ: بھیجنے/وصول کرنے کے لیے _بوٹ macOS صارف_ میں GUI منظوریوں (Automation + Full Disk Access) کی ضرورت ہو سکتی ہے۔ اگر `imsg rpc` رکا ہوا لگے یا باہر نکل جائے، تو اس صارف میں لاگ اِن کریں (Screen Sharing مددگار ہے)، ایک بار `imsg chats --limit 1` / `imsg send ...` چلائیں، پرامپٹس منظور کریں، پھر دوبارہ کوشش کریں۔ [Troubleshooting macOS Privacy and Security TCC](#troubleshooting-macos-privacy-and-security-tcc) دیکھیں۔

مثالی ریپر (`chmod +x`)۔ `<bot-macos-user>` کو اپنے اصل macOS صارف نام سے بدلیں:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

مثالی کنفیگ:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

سنگل اکاؤنٹ سیٹ اپس کے لیے، `accounts` میپ کے بجائے فلیٹ آپشنز (`channels.imessage.cliPath`، `channels.imessage.dbPath`) استعمال کریں۔

### ریموٹ/SSH ویریئنٹ (اختیاری)

اگر آپ کسی دوسرے Mac پر iMessage چاہتے ہیں، تو `channels.imessage.cliPath` کو ایسے ریپر پر سیٹ کریں جو SSH کے ذریعے ریموٹ macOS ہوسٹ پر `imsg` چلائے۔ OpenClaw کو صرف stdio کی ضرورت ہوتی ہے۔

مثالی ریپر:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**ریموٹ اٹیچمنٹس:** جب `cliPath` SSH کے ذریعے ریموٹ ہوسٹ کی طرف اشارہ کرتا ہے، تو Messages ڈیٹابیس میں اٹیچمنٹ پاتھ ریموٹ مشین کی فائلوں کا حوالہ دیتے ہیں۔ OpenClaw انہیں SCP کے ذریعے خودکار طور پر حاصل کر سکتا ہے، اگر `channels.imessage.remoteHost` سیٹ کیا جائے:

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac
      remoteHost: "user@gateway-host", // for SCP file transfer
      includeAttachments: true,
    },
  },
}
```

اگر `remoteHost` سیٹ نہ ہو تو OpenClaw آپ کے ریپر اسکرپٹ میں SSH کمانڈ کو پارس کر کے خودکار طور پر شناخت کرنے کی کوشش کرتا ہے۔ زیادہ بھروسے کے لیے واضح کنفیگریشن سفارش کی جاتی ہے۔

#### Tailscale کے ذریعے ریموٹ Mac (مثال)

اگر Gateway لینکس ہوسٹ/VM پر چل رہا ہو لیکن iMessage کو Mac پر چلنا ضروری ہو، تو Tailscale سب سے آسان پل ہے: Gateway ٹیل نیٹ کے ذریعے Mac سے بات کرتا ہے، SSH کے ذریعے `imsg` چلاتا ہے، اور اٹیچمنٹس SCP کے ذریعے واپس لاتا ہے۔

آرکیٹیکچر:

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

ٹھوس کنفیگ مثال (Tailscale ہوسٹ نیم):

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

مثالی ریپر (`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

نوٹس:

- یقینی بنائیں کہ Mac پر Messages میں سائن اِن ہے، اور Remote Login فعال ہے۔
- SSH کیز استعمال کریں تاکہ `ssh bot@mac-mini.tailnet-1234.ts.net` بغیر پرامپٹس کے کام کرے۔
- `remoteHost` کو SSH ٹارگٹ سے میل کھانا چاہیے تاکہ SCP اٹیچمنٹس حاصل کر سکے۔

ملٹی اکاؤنٹ سپورٹ: `channels.imessage.accounts` کو فی اکاؤنٹ کنفیگ اور اختیاری `name` کے ساتھ استعمال کریں۔ مشترکہ پیٹرن کے لیے [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) دیکھیں۔ `~/.openclaw/openclaw.json` کو کمٹ نہ کریں (اس میں اکثر ٹوکنز ہوتے ہیں)۔

## رسائی کا کنٹرول (DMs + گروپس)

DMs:

- ڈیفالٹ: `channels.imessage.dmPolicy = "pairing"`۔
- نامعلوم بھیجنے والوں کو جوڑی بنانے کا کوڈ ملتا ہے؛ منظوری تک پیغامات نظرانداز کیے جاتے ہیں (کوڈز 1 گھنٹے بعد ختم ہو جاتے ہیں)۔
- منظوری دیں بذریعہ:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- iMessage DMs کے لیے جوڑی بنانا ڈیفالٹ ٹوکن ایکسچینج ہے۔ تفصیل: [Pairing](/channels/pairing)

گروپس:

- `channels.imessage.groupPolicy = open | allowlist | disabled`۔
- `channels.imessage.groupAllowFrom` کنٹرول کرتا ہے کہ جب `allowlist` سیٹ ہو تو گروپس میں کون ٹرگر کر سکتا ہے۔
- میشن گیٹنگ `agents.list[].groupChat.mentionPatterns` (یا `messages.groupChat.mentionPatterns`) استعمال کرتی ہے کیونکہ iMessage میں نیٹو میشن میٹاڈیٹا نہیں ہوتا۔
- ملٹی ایجنٹ اووررائیڈ: `agents.list[].groupChat.mentionPatterns` پر فی ایجنٹ پیٹرنز سیٹ کریں۔

## یہ کیسے کام کرتا ہے (رویّہ)

- `imsg` پیغام کے واقعات کو اسٹریم کرتا ہے؛ گیٹ وے انہیں مشترکہ چینل اینویلپ میں نارملائز کرتا ہے۔
- جوابات ہمیشہ اسی چیٹ آئی ڈی یا ہینڈل پر واپس جاتے ہیں۔

## Group-ish تھریڈز (`is_group=false`)

کچھ iMessage تھریڈز میں متعدد شرکاء ہو سکتے ہیں لیکن Messages کے چیٹ شناخت کنندہ کو محفوظ کرنے کے طریقے کے مطابق وہ `is_group=false` کے ساتھ آ سکتے ہیں۔

اگر آپ `channels.imessage.groups` کے تحت واضح طور پر `chat_id` کنفیگر کریں، تو OpenClaw اس تھریڈ کو درج ذیل کے لیے “گروپ” سمجھتا ہے:

- سیشن آئسولیشن (علیحدہ `agent:<agentId>:imessage:group:<chat_id>` سیشن کلید)
- گروپ اجازت فہرست / میشن گیٹنگ رویّہ

مثال:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

یہ اس وقت مفید ہے جب آپ کسی مخصوص تھریڈ کے لیے الگ شخصیت/ماڈل چاہتے ہوں (دیکھیں [Multi-agent routing](/concepts/multi-agent))۔ فائل سسٹم آئسولیشن کے لیے [Sandboxing](/gateway/sandboxing) دیکھیں۔

## میڈیا + حدود

- اختیاری اٹیچمنٹ انجیسشن بذریعہ `channels.imessage.includeAttachments`۔
- میڈیا حد بذریعہ `channels.imessage.mediaMaxMb`۔

## حدود

- آؤٹ باؤنڈ متن کو `channels.imessage.textChunkLimit` (ڈیفالٹ 4000) پر چنکس میں تقسیم کیا جاتا ہے۔
- اختیاری نئی لائن چنکنگ: `channels.imessage.chunkMode="newline"` سیٹ کریں تاکہ لمبائی کے مطابق چنکنگ سے پہلے خالی لائنوں (پیراگراف حدود) پر تقسیم ہو۔
- میڈیا اپ لوڈز `channels.imessage.mediaMaxMb` (ڈیفالٹ 16) سے محدود ہیں۔

## ایڈریسنگ / ڈیلیوری ٹارگٹس

مستحکم روٹنگ کے لیے `chat_id` کو ترجیح دیں:

- `chat_id:123` (ترجیحی)
- `chat_guid:...`
- `chat_identifier:...`
- براہِ راست ہینڈلز: `imessage:+1555` / `sms:+1555` / `user@example.com`

چیٹس کی فہرست:

```
imsg chats --limit 20
```

## کنفیگریشن ریفرنس (iMessage)

مکمل کنفیگریشن: [Configuration](/gateway/configuration)

فراہم کنندہ کے اختیارات:

- `channels.imessage.enabled`: چینل اسٹارٹ اپ کو فعال/غیرفعال کریں۔
- `channels.imessage.cliPath`: `imsg` کا پاتھ۔
- `channels.imessage.dbPath`: Messages DB کا پاتھ۔
- `channels.imessage.remoteHost`: SCP اٹیچمنٹ ٹرانسفر کے لیے SSH ہوسٹ، جب `cliPath` ریموٹ Mac کی طرف اشارہ کرے (مثلاً `user@gateway-host`)۔ اگر سیٹ نہ ہو تو SSH ریپر سے خودکار شناخت۔
- `channels.imessage.service`: `imessage | sms | auto`۔
- `channels.imessage.region`: SMS ریجن۔
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (ڈیفالٹ: pairing)۔
- `channels.imessage.allowFrom`: DM اجازت فہرست (ہینڈلز، ای میلز، E.164 نمبرز، یا `chat_id:*`)۔ `open` کے لیے `"*"` درکار ہے۔ iMessage میں یوزرنیمز نہیں ہوتے؛ ہینڈلز یا چیٹ ٹارگٹس استعمال کریں۔
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (ڈیفالٹ: allowlist)۔
- `channels.imessage.groupAllowFrom`: گروپ بھیجنے والوں کی اجازت فہرست۔
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: سیاق میں شامل کرنے کے لیے زیادہ سے زیادہ گروپ پیغامات (0 غیرفعال کرتا ہے)۔
- `channels.imessage.dmHistoryLimit`: صارف کے موڑوں میں DM ہسٹری حد۔ فی صارف اووررائیڈز: `channels.imessage.dms["<handle>"].historyLimit`۔
- `channels.imessage.groups`: فی گروپ ڈیفالٹس + اجازت فہرست (عالمی ڈیفالٹس کے لیے `"*"` استعمال کریں)۔
- `channels.imessage.includeAttachments`: اٹیچمنٹس کو سیاق میں شامل کریں۔
- `channels.imessage.mediaMaxMb`: اِن باؤنڈ/آؤٹ باؤنڈ میڈیا حد (MB)۔
- `channels.imessage.textChunkLimit`: آؤٹ باؤنڈ چنک سائز (حروف)۔
- `channels.imessage.chunkMode`: `length` (ڈیفالٹ) یا `newline` تاکہ لمبائی کے مطابق چنکنگ سے پہلے خالی لائنوں (پیراگراف حدود) پر تقسیم ہو۔

متعلقہ عالمی اختیارات:

- `agents.list[].groupChat.mentionPatterns` (یا `messages.groupChat.mentionPatterns`)۔
- `messages.responsePrefix`۔
