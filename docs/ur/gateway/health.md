---
summary: "چینل کنیکٹیویٹی کے لیے ہیلتھ چیک کے مراحل"
read_when:
  - WhatsApp چینل کی صحت کی تشخیص
title: "ہیلتھ چیکس"
x-i18n:
  source_path: gateway/health.md
  source_hash: 74f242e98244c135
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:17Z
---

# ہیلتھ چیکس (CLI)

اندازے کے بغیر چینل کنیکٹیویٹی کی توثیق کے لیے مختصر رہنما۔

## فوری جانچ

- `openclaw status` — مقامی خلاصہ: gateway (گیٹ وے) کی رسائی/موڈ، اپڈیٹ اشارہ، منسلک چینل کی تصدیق کی عمر، سیشنز + حالیہ سرگرمی۔
- `openclaw status --all` — مکمل مقامی تشخیص (صرف مطالعہ، رنگین، ڈیبگنگ کے لیے پیسٹ کرنا محفوظ)۔
- `openclaw status --deep` — چلتے ہوئے Gateway (گیٹ وے) کی بھی جانچ کرتا ہے (جہاں سپورٹ ہو، فی چینل پروبز)۔
- `openclaw health --json` — چلتے ہوئے Gateway (گیٹ وے) سے مکمل ہیلتھ اسنیپ شاٹ مانگتا ہے (صرف WS؛ براہِ راست Baileys ساکٹ نہیں)۔
- WhatsApp/WebChat میں `/status` کو بطورِ واحد پیغام بھیجیں تاکہ ایجنٹ کو فعال کیے بغیر اسٹیٹس جواب مل سکے۔
- لاگز: `/tmp/openclaw/openclaw-*.log` کو ٹیل کریں اور `web-heartbeat`، `web-reconnect`، `web-auto-reply`، `web-inbound` کے لیے فلٹر کریں۔

## گہری تشخیص

- ڈسک پر اسناد: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime حالیہ ہونا چاہیے)۔
- سیشن اسٹور: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (راستہ کنفیگ میں اووررائیڈ کیا جا سکتا ہے)۔ گنتی اور حالیہ وصول کنندگان `status` کے ذریعے ظاہر کیے جاتے ہیں۔
- ری لنک فلو: `openclaw channels logout && openclaw channels login --verbose` جب اسٹیٹس کوڈز 409–515 ہوں یا لاگز میں `loggedOut` ظاہر ہو۔ (نوٹ: QR لاگ اِن فلو اسٹیٹس 515 کے بعد جوڑی بننے پر ایک بار خودکار طور پر دوبارہ شروع ہوتا ہے۔)

## جب کچھ ناکام ہو جائے

- `logged out` یا اسٹیٹس 409–515 → `openclaw channels logout` کے ساتھ ری لنک کریں، پھر `openclaw channels login`۔
- Gateway (گیٹ وے) ناقابلِ رسائی → اسے شروع کریں: `openclaw gateway --port 18789` (اگر پورٹ مصروف ہو تو `--force` استعمال کریں)۔
- اندر آنے والے پیغامات نہیں → تصدیق کریں کہ منسلک فون آن لائن ہے اور بھیجنے والا مجاز ہے (`channels.whatsapp.allowFrom`)؛ گروپ چیٹس کے لیے، یقینی بنائیں کہ اجازت فہرست + منشن کے قواعد مطابقت رکھتے ہیں (`channels.whatsapp.groups`، `agents.list[].groupChat.mentionPatterns`)۔

## مخصوص "health" کمانڈ

`openclaw health --json` چلتے ہوئے Gateway (گیٹ وے) سے اس کا ہیلتھ اسنیپ شاٹ مانگتا ہے (CLI سے براہِ راست چینل ساکٹس نہیں)۔ دستیاب ہونے پر یہ منسلک اسناد/تصدیق کی عمر، فی چینل پروب خلاصے، سیشن اسٹور کا خلاصہ، اور پروب کی مدت رپورٹ کرتا ہے۔ اگر Gateway (گیٹ وے) ناقابلِ رسائی ہو یا پروب ناکام/ٹائم آؤٹ ہو جائے تو یہ non-zero کے ساتھ خارج ہوتا ہے۔ 10s ڈیفالٹ کو اووررائیڈ کرنے کے لیے `--timeout <ms>` استعمال کریں۔
