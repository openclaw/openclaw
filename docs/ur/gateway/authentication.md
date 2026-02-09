---
summary: "ماڈل کی تصدیق: OAuth، API کلیدیں، اور setup-token"
read_when:
  - ماڈل تصدیق یا OAuth کی میعاد ختم ہونے کی خرابیوں کی جانچ کے وقت
  - تصدیق یا اسناد کے ذخیرے کی دستاویز بندی کرتے وقت
title: "تصدیق"
---

# تصدیق

OpenClaw ماڈل فراہم کنندگان کے لیے OAuth اور API keys کو سپورٹ کرتا ہے۔ Anthropic
اکاؤنٹس کے لیے، ہم **API key** استعمال کرنے کی سفارش کرتے ہیں۔ Claude سبسکرپشن ایکسس کے لیے،
`claude setup-token` کے ذریعے بنایا گیا long‑lived ٹوکن استعمال کریں۔

OAuth کے مکمل فلو اور اسٹوریج لے آؤٹ کے لیے
[/concepts/oauth](/concepts/oauth) دیکھیں۔

## Anthropic کے لیے سفارش کردہ سیٹ اپ (API کلید)

اگر آپ Anthropic کو براہِ راست استعمال کر رہے ہیں تو API کلید استعمال کریں۔

1. Anthropic Console میں ایک API کلید بنائیں۔
2. اسے **گیٹ وے ہوسٹ** (وہ مشین جس پر `openclaw gateway` چل رہا ہو) پر رکھیں۔

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. اگر Gateway systemd/launchd کے تحت چل رہا ہو تو بہتر ہے کہ کلید
   `~/.openclaw/.env` میں رکھیں تاکہ ڈیمَن اسے پڑھ سکے:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

اس کے بعد ڈیمَن کو ری اسٹارٹ کریں (یا اپنے Gateway پروسیس کو دوبارہ شروع کریں) اور دوبارہ جانچ کریں:

```bash
openclaw models status
openclaw doctor
```

اگر آپ خود env vars کا انتظام نہیں کرنا چاہتے تو آن بورڈنگ وزرڈ
ڈیمَن کے استعمال کے لیے API کلیدیں محفوظ کر سکتا ہے: `openclaw onboard`۔

env inheritance کی تفصیلات کے لیے [Help](/help) دیکھیں
(`env.shellEnv`، `~/.openclaw/.env`، systemd/launchd)۔

## Anthropic: setup-token (سبسکرپشن تصدیق)

Anthropic کے لیے، تجویز کردہ راستہ **API key** ہے۔ اگر آپ Claude
سبسکرپشن استعمال کر رہے ہیں، تو setup-token فلو بھی سپورٹڈ ہے۔ اسے **gateway host** پر چلائیں:

```bash
claude setup-token
```

پھر اسے OpenClaw میں پیسٹ کریں:

```bash
openclaw models auth setup-token --provider anthropic
```

اگر ٹوکن کسی دوسری مشین پر بنایا گیا تھا تو اسے دستی طور پر پیسٹ کریں:

```bash
openclaw models auth paste-token --provider anthropic
```

اگر آپ کو Anthropic کی کوئی ایسی خرابی نظر آئے جیسے:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…تو اس کے بجائے Anthropic API کلید استعمال کریں۔

دستی ٹوکن اندراج (کسی بھی فراہم کنندہ کے لیے؛ `auth-profiles.json` لکھتا ہے + کنفیگ اپ ڈیٹ کرتا ہے):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

آٹومیشن کے لیے موزوں جانچ (میعاد ختم یا غیر موجود ہونے پر exit `1`،
میعاد ختم ہونے کے قریب ہونے پر `2`):

```bash
openclaw models status --check
```

اختیاری ops اسکرپٹس (systemd/Termux) یہاں دستاویزی ہیں:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` کے لیے انٹرایکٹو TTY درکار ہے۔

## ماڈل تصدیق کی حالت چیک کرنا

```bash
openclaw models status
openclaw doctor
```

## یہ کنٹرول کرنا کہ کون سی اسناد استعمال ہوں

### فی سیشن (چیٹ کمانڈ)

موجودہ سیشن کے لیے کسی مخصوص فراہم کنندہ کی اسناد کو پن کرنے کے لیے
`/model <alias-or-id>@<profileId>` استعمال کریں (مثالی پروفائل آئی ڈیز: `anthropic:default`، `anthropic:work`)۔

کمپیکٹ پِکر کے لیے `/model` (یا `/model list`) استعمال کریں؛
مکمل منظر کے لیے `/model status` استعمال کریں
(امیدوار + اگلا auth پروفائل، نیز کنفیگر ہونے پر فراہم کنندہ کے endpoint کی تفصیلات)۔

### فی ایجنٹ (CLI اووررائیڈ)

کسی ایجنٹ کے لیے auth پروفائل آرڈر کا واضح اووررائیڈ سیٹ کریں
(جو اس ایجنٹ کے `auth-profiles.json` میں محفوظ ہوتا ہے):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

کسی مخصوص ایجنٹ کو ہدف بنانے کے لیے `--agent <id>` استعمال کریں؛
اگر چھوڑ دیں تو کنفیگر شدہ ڈیفالٹ ایجنٹ استعمال ہوگا۔

## خرابیوں کا ازالہ

### “No credentials found”

اگر Anthropic ٹوکن پروفائل موجود نہیں ہے تو
**گیٹ وے ہوسٹ** پر `claude setup-token` چلائیں، پھر دوبارہ جانچ کریں:

```bash
openclaw models status
```

### ٹوکن کی میعاد ختم ہو رہی ہے/ختم ہو چکی ہے

`openclaw models status` چلائیں تاکہ یہ تصدیق ہو سکے کہ کون سا پروفائل expire ہو رہا ہے۔ اگر پروفائل
غائب ہو، تو `claude setup-token` دوبارہ چلائیں اور ٹوکن دوبارہ پیسٹ کریں۔

## ضروریات

- Claude Max یا Pro سبسکرپشن ( `claude setup-token` کے لیے)
- Claude Code CLI انسٹال ہونا (`claude` کمانڈ دستیاب ہو)
