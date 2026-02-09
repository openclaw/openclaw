---
summary: "براہِ راست `openclaw agent` CLI رنز (اختیاری ترسیل کے ساتھ)"
read_when:
  - ایجنٹ CLI اینٹری پوائنٹ شامل کرتے یا ترمیم کرتے وقت
title: "Agent Send"
---

# `openclaw agent` (براہِ راست ایجنٹ رنز)

`openclaw agent` runs a single agent turn without needing an inbound chat message.
By default it goes **through the Gateway**; add `--local` to force the embedded
runtime on the current machine.

## رویّہ

- لازمی: `--message <text>`
- سیشن کا انتخاب:
  - `--to <dest>` سیشن کلید اخذ کرتا ہے (گروپ/چینل اہداف تنہائی برقرار رکھتے ہیں؛ براہِ راست چیٹس `main` تک سمٹ جاتی ہیں)، **یا**
  - `--session-id <id>` کسی موجودہ سیشن کو آئی ڈی کے ذریعے دوبارہ استعمال کرتا ہے، **یا**
  - `--agent <id>` براہِ راست کسی کنفیگرڈ ایجنٹ کو ہدف بناتا ہے (اس ایجنٹ کی `main` سیشن کلید استعمال ہوتی ہے)
- عام ان باؤنڈ جوابات کی طرح وہی ایمبیڈڈ ایجنٹ رن ٹائم چلاتا ہے۔
- تھنکنگ/وربوز فلیگز سیشن اسٹور میں برقرار رہتے ہیں۔
- آؤٹ پٹ:
  - بطورِ طے شدہ: جواب کا متن پرنٹ کرتا ہے (ساتھ `MEDIA:<url>` لائنیں)
  - `--json`: اسٹرکچرڈ پے لوڈ + میٹا ڈیٹا پرنٹ کرتا ہے
- `--deliver` + `--channel` کے ساتھ کسی چینل پر اختیاری ترسیل (ہدف کے فارمیٹس `openclaw message --target` سے مماثل ہیں)۔
- سیشن تبدیل کیے بغیر ترسیل اووررائیڈ کرنے کے لیے `--reply-channel`/`--reply-to`/`--reply-account` استعمال کریں۔

اگر Gateway قابلِ رسائی نہ ہو تو CLI **فال بیک** کے طور پر ایمبیڈڈ لوکل رن پر چلا جاتا ہے۔

## مثالیں

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## فلیگز

- `--local`: لوکل طور پر چلائیں (آپ کے شیل میں ماڈل فراہم کنندہ کی API کلیدیں درکار ہیں)
- `--deliver`: منتخب چینل پر جواب بھیجیں
- `--channel`: ترسیلی چینل (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, بطورِ طے شدہ: `whatsapp`)
- `--reply-to`: ترسیلی ہدف اووررائیڈ
- `--reply-channel`: ترسیلی چینل اووررائیڈ
- `--reply-account`: ترسیلی اکاؤنٹ آئی ڈی اووررائیڈ
- `--thinking <off|minimal|low|medium|high|xhigh>`: تھنکنگ لیول برقرار رکھیں (صرف GPT-5.2 + Codex ماڈلز)
- `--verbose <on|full|off>`: وربوز لیول برقرار رکھیں
- `--timeout <seconds>`: ایجنٹ ٹائم آؤٹ اووررائیڈ
- `--json`: اسٹرکچرڈ JSON آؤٹ پٹ
