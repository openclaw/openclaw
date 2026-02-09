---
summary: "گیٹ وے، چینلز، آٹومیشن، نوڈز، اور براؤزر کے لیے تفصیلی خرابیوں کے ازالے کا رن بُک"
read_when:
  - خرابیوں کے ازالے کے ہب نے گہری تشخیص کے لیے آپ کو یہاں بھیجا ہو
  - آپ کو علامات پر مبنی مستحکم رن بُک حصے اور عین کمانڈز درکار ہوں
title: "خرابیوں کا ازالہ"
---

# Gateway کی خرابیوں کا ازالہ

This page is the deep runbook.
Start at [/help/troubleshooting](/help/troubleshooting) if you want the fast triage flow first.

## کمانڈ سیڑھی

انہیں پہلے، اسی ترتیب میں چلائیں:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

متوقع صحت مند اشارے:

- `openclaw gateway status` میں `Runtime: running` اور `RPC probe: ok` دکھائی دیں۔
- `openclaw doctor` کسی بلاک کرنے والی کنفیگ/سروس مسئلے کی اطلاع نہ دے۔
- `openclaw channels status --probe` منسلک/تیار چینلز دکھائے۔

## کوئی جوابات نہیں

اگر چینلز اپ ہیں لیکن کوئی جواب نہیں آ رہا، تو کسی بھی چیز کو دوبارہ کنیکٹ کرنے سے پہلے روٹنگ اور پالیسی چیک کریں۔

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

درج ذیل دیکھیں:

- DMs بھیجنے والوں کے لیے pairing زیرِ التواء۔
- گروپ مینشن گیٹنگ (`requireMention`, `mentionPatterns`)۔
- چینل/گروپ اجازت فہرست میں عدم مطابقت۔

عام نشانیاں:

- `drop guild message (mention required` → مینشن تک گروپ پیغام نظرانداز۔
- `pairing request` → بھیجنے والے کو منظوری درکار۔
- `blocked` / `allowlist` → بھیجنے والا/چینل پالیسی کے تحت فلٹر ہوا۔

متعلقہ:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## ڈیش بورڈ کنٹرول UI کنیکٹیوٹی

جب ڈیش بورڈ/کنٹرول UI کنیکٹ نہ ہو، تو URL، auth موڈ، اور محفوظ سیاق کے مفروضات کی توثیق کریں۔

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

درج ذیل دیکھیں:

- درست پروب URL اور ڈیش بورڈ URL۔
- کلائنٹ اور گیٹ وے کے درمیان auth موڈ/ٹوکن کی عدم مطابقت۔
- جہاں ڈیوائس شناخت درکار ہو وہاں HTTP کا استعمال۔

عام نشانیاں:

- `device identity required` → غیر محفوظ سیاق یا ڈیوائس auth کی کمی۔
- `unauthorized` / ری کنیکٹ لوپ → ٹوکن/پاس ورڈ کی عدم مطابقت۔
- `gateway connect failed:` → غلط ہوسٹ/پورٹ/URL ہدف۔

متعلقہ:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Gateway سروس نہیں چل رہی

جب سروس انسٹال ہو مگر پروسیس چلتا نہ رہے تو یہ استعمال کریں۔

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

درج ذیل دیکھیں:

- `Runtime: stopped` خروجی اشاروں کے ساتھ۔
- سروس کنفیگ میں عدم مطابقت (`Config (cli)` بمقابلہ `Config (service)`)۔
- پورٹ/لسٹنر تنازعات۔

عام نشانیاں:

- `Gateway start blocked: set gateway.mode=local` → لوکل گیٹ وے موڈ فعال نہیں۔
- `refusing to bind gateway ... without auth` → non-loopback bind without token/password.
- `another gateway instance is already listening` / `EADDRINUSE` → پورٹ تنازع۔

متعلقہ:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## چینل منسلک مگر پیغامات نہیں جا رہے

اگر چینل اسٹیٹ کنیکٹڈ ہے مگر پیغام رسانی بند ہے، تو پالیسی، اجازتوں، اور چینل مخصوص ترسیلی قواعد پر توجہ دیں۔

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

درج ذیل دیکھیں:

- DMs پالیسی (`pairing`, `allowlist`, `open`, `disabled`)۔
- گروپ اجازت فہرست اور مینشن کی ضروریات۔
- چینل API کی غائب اجازتیں/اسکوپس۔

عام نشانیاں:

- `mention required` → گروپ مینشن پالیسی کے باعث پیغام نظرانداز۔
- `pairing` / منظوری زیرِ التواء کے آثار → بھیجنے والا منظور شدہ نہیں۔
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → چینل auth/اجازت کا مسئلہ۔

متعلقہ:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## کرون اور ہارٹ بیٹ ترسیل

اگر کرون یا ہارٹ بیٹ نہ چلا یا ترسیل نہ ہو سکی، تو پہلے شیڈیولر کی حالت اور پھر ترسیلی ہدف کی تصدیق کریں۔

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

درج ذیل دیکھیں:

- کرون فعال ہو اور اگلا ویک موجود ہو۔
- جاب رن ہسٹری کی حالت (`ok`, `skipped`, `error`)۔
- ہارٹ بیٹ اسکیپ کی وجوہات (`quiet-hours`, `requests-in-flight`, `alerts-disabled`)۔

عام نشانیاں:

- `cron: scheduler disabled; jobs will not run automatically` → کرون غیرفعال۔
- `cron: timer tick failed` → شیڈیولر ٹِک ناکام؛ فائل/لاگ/رن ٹائم غلطیاں چیک کریں۔
- `heartbeat skipped` بمع `reason=quiet-hours` → فعال اوقات کی حد سے باہر۔
- `heartbeat: unknown accountId` → ہارٹ بیٹ ترسیلی ہدف کے لیے غلط اکاؤنٹ آئی ڈی۔

متعلقہ:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## نوڈ جوڑا گیا مگر ٹول ناکام

اگر نوڈ جوڑا گیا ہے مگر ٹولز ناکام ہیں، تو foreground، اجازت، اور منظوری کی حالت الگ کر کے جانچیں۔

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

درج ذیل دیکھیں:

- نوڈ آن لائن ہو اور متوقع صلاحیتیں موجود ہوں۔
- کیمرہ/مائیک/لوکیشن/اسکرین کے لیے OS اجازتیں۔
- Exec منظوریات اور اجازت فہرست کی حالت۔

عام نشانیاں:

- `NODE_BACKGROUND_UNAVAILABLE` → نوڈ ایپ کو foreground میں ہونا چاہیے۔
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → OS اجازت غائب۔
- `SYSTEM_RUN_DENIED: approval required` → exec منظوری زیرِ التواء۔
- `SYSTEM_RUN_DENIED: allowlist miss` → کمانڈ اجازت فہرست کے باعث بلاک۔

متعلقہ:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## براؤزر ٹول ناکام

جب گیٹ وے خود صحت مند ہو مگر براؤزر ٹول کے اقدامات ناکام ہوں تو یہ استعمال کریں۔

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

درج ذیل دیکھیں:

- درست براؤزر executable پاتھ۔
- CDP پروفائل تک رسائی۔
- `profile="chrome"` کے لیے ایکسٹینشن ریلے ٹیب اٹیچمنٹ۔

عام نشانیاں:

- `Failed to start Chrome CDP on port` → براؤزر پروسیس لانچ نہ ہو سکا۔
- `browser.executablePath not found` → کنفیگر کیا گیا پاتھ غلط ہے۔
- `Chrome extension relay is running, but no tab is connected` → ایکسٹینشن ریلے اٹیچ نہیں۔
- `Browser attachOnly is enabled ... not reachable` → attach-only profile has no reachable target.

متعلقہ:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## اگر آپ نے اپ گریڈ کیا اور اچانک کچھ ٹوٹ گیا

زیادہ تر اپ گریڈ کے بعد خرابی کنفیگ ڈرفٹ یا اب نافذ ہونے والی سخت تر ڈیفالٹس کی وجہ سے ہوتی ہے۔

### 1. Auth اور URL اوور رائیڈ رویہ تبدیل ہو گیا

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

کیا چیک کریں:

- اگر `gateway.mode=remote` ہو، تو CLI کالز ریموٹ کو ہدف بنا رہی ہو سکتی ہیں جبکہ لوکل سروس ٹھیک ہو۔
- واضح `--url` کالز محفوظ شدہ اسناد پر واپس نہیں جاتیں۔

عام نشانیاں:

- `gateway connect failed:` → غلط URL ہدف۔
- `unauthorized` → اینڈپوائنٹ قابلِ رسائی مگر auth غلط۔

### 2. بائنڈ اور auth گارڈ ریلز زیادہ سخت ہیں

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

کیا چیک کریں:

- non-loopback بائنڈز (`lan`, `tailnet`, `custom`) کے لیے auth کنفیگر ہونا لازم ہے۔
- پرانی کیز جیسے `gateway.token`، `gateway.auth.token` کی جگہ نہیں لیتیں۔

عام نشانیاں:

- `refusing to bind gateway ... without auth` → bind+auth mismatch.
- `RPC probe: failed` جبکہ رن ٹائم چل رہا ہو → گیٹ وے زندہ مگر موجودہ auth/url کے ساتھ ناقابلِ رسائی۔

### 3. pairing اور ڈیوائس شناخت کی حالت تبدیل ہو گئی

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

کیا چیک کریں:

- ڈیش بورڈ/نوڈز کے لیے زیرِ التواء ڈیوائس منظوریات۔
- پالیسی یا شناخت کی تبدیلیوں کے بعد زیرِ التواء DM pairing منظوریات۔

عام نشانیاں:

- `device identity required` → ڈیوائس auth پوری نہیں ہوئی۔
- `pairing required` → بھیجنے والا/ڈیوائس منظور ہونا لازم ہے۔

اگر جانچ کے بعد بھی سروس کنفیگ اور رن ٹائم میں اختلاف برقرار رہے، تو اسی پروفائل/اسٹیٹ ڈائریکٹری سے سروس میٹا ڈیٹا دوبارہ انسٹال کریں:

```bash
openclaw gateway install --force
openclaw gateway restart
```

متعلقہ:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
