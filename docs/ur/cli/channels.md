---
summary: "CLI کے لیے `openclaw channels` کا حوالہ (اکاؤنٹس، اسٹیٹس، لاگ اِن/لاگ آؤٹ، لاگز)"
read_when:
  - آپ چینل اکاؤنٹس شامل/حذف کرنا چاہتے ہیں (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage)
  - آپ چینل اسٹیٹس چیک کرنا یا چینل لاگز ٹیل کرنا چاہتے ہیں
title: "channels"
---

# `openclaw channels`

Gateway پر چیٹ چینل اکاؤنٹس اور ان کے رن ٹائم اسٹیٹس کا انتظام کریں۔

متعلقہ دستاویزات:

- چینل رہنما: [Channels](/channels/index)
- Gateway کنفیگریشن: [Configuration](/gateway/configuration)

## Common commands

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Add / remove accounts

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

Tip: `openclaw channels add --help` ہر چینل کے لیے فلیگز دکھاتا ہے (token، app token، signal-cli paths وغیرہ)۔

## Login / logout (interactive)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Troubleshooting

- وسیع جانچ کے لیے `openclaw status --deep` چلائیں۔
- رہنمائی شدہ حل کے لیے `openclaw doctor` استعمال کریں۔
- `openclaw channels list` پرنٹ کرتا ہے `Claude: HTTP 403 ... `user:profile`→ استعمال کا اسنیپ شاٹ کے لیے`user:profile`اسکوپ درکار ہے۔`--no-usage` استعمال کریں، یا claude.ai سیشن کی (`CLAUDE_WEB_SESSION_KEY`/`CLAUDE_WEB_COOKIE\`) فراہم کریں، یا Claude Code CLI کے ذریعے دوبارہ توثیق کریں۔

## Capabilities probe

فراہم کنندہ کی صلاحیتوں کے اشارے (جہاں دستیاب ہوں وہاں intents/scopes) کے ساتھ جامد فیچر سپورٹ حاصل کریں:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Notes:

- `--channel` اختیاری ہے؛ اسے چھوڑنے پر تمام چینلز (بشمول ایکسٹینشنز) کی فہرست دکھائی جائے گی۔
- `--target`، `channel:<id>` یا خام عددی چینل ID قبول کرتا ہے اور صرف Discord پر لاگو ہوتا ہے۔
- پروبز فراہم کنندہ کے لحاظ سے مخصوص ہوتے ہیں: Discord intents + اختیاری چینل اجازتیں؛ Slack بوٹ + صارف اسکوپس؛ Telegram بوٹ فلیگز + ویب ہُک؛ Signal ڈیمَن ورژن؛ MS Teams ایپ ٹوکن + Graph کردار/اسکوپس (جہاں معلوم ہو تشریح شدہ)۔ Channels without probes report `Probe: unavailable`.

## Resolve names to IDs

فراہم کنندہ ڈائریکٹری استعمال کرتے ہوئے چینل/یوزر ناموں کو IDs میں تبدیل کریں:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Notes:

- ہدف کی قسم مجبور کرنے کے لیے `--kind user|group|auto` استعمال کریں۔
- جب ایک ہی نام کے متعدد اندراجات ہوں تو حل فعال میچز کو ترجیح دیتا ہے۔
