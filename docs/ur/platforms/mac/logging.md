---
summary: "OpenClaw لاگنگ: رولنگ ڈائیگناسٹکس فائل لاگ + یونیفائیڈ لاگ پرائیویسی فلیگز"
read_when:
  - macOS لاگز کی گرفت یا نجی ڈیٹا کی لاگنگ کی تفتیش کرتے وقت
  - وائس ویک/سیشن لائف سائیکل کے مسائل کی ڈیبگنگ کرتے وقت
title: "macOS لاگنگ"
x-i18n:
  source_path: platforms/mac/logging.md
  source_hash: c4c201d154915e0e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:28Z
---

# لاگنگ (macOS)

## رولنگ ڈائیگناسٹکس فائل لاگ (Debug pane)

OpenClaw macOS ایپ کے لاگز کو swift-log کے ذریعے روٹ کرتا ہے (بطورِ طے شدہ یونیفائیڈ لاگنگ) اور جب آپ کو پائیدار کیپچر درکار ہو تو ڈسک پر ایک مقامی، گھومتی ہوئی فائل لاگ بھی لکھ سکتا ہے۔

- Verbosity: **Debug pane → Logs → App logging → Verbosity**
- Enable: **Debug pane → Logs → App logging → “Write rolling diagnostics log (JSONL)”**
- Location: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (خودکار طور پر گردش کرتا ہے؛ پرانی فائلوں کے آخر میں `.1`, `.2`, … لگایا جاتا ہے)
- Clear: **Debug pane → Logs → App logging → “Clear”**

نوٹس:

- یہ **بطورِ طے شدہ بند** ہے۔ صرف فعال ڈیبگنگ کے دوران ہی فعال کریں۔
- فائل کو حساس سمجھیں؛ نظرِ ثانی کے بغیر اسے شیئر نہ کریں۔

## macOS پر یونیفائیڈ لاگنگ میں نجی ڈیٹا

یونیفائیڈ لاگنگ زیادہ تر payloads کو ریڈیکٹ کرتی ہے جب تک کوئی سب سسٹم `privacy -off` میں شامل ہونے کا انتخاب نہ کرے۔ Peter کی macOS پر [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) والی تحریر کے مطابق، یہ ایک plist کے ذریعے کنٹرول ہوتا ہے جو `/Library/Preferences/Logging/Subsystems/` میں سب سسٹم کے نام کی کلید کے ساتھ ہوتا ہے۔ صرف نئے لاگ اندراجات ہی اس فلیگ کو اختیار کرتے ہیں، اس لیے مسئلہ دوبارہ پیدا کرنے سے پہلے اسے فعال کریں۔

## OpenClaw کے لیے فعال کریں (`bot.molt`)

- پہلے plist کو ایک عارضی فائل میں لکھیں، پھر اسے root کے طور پر ایٹامک انداز میں انسٹال کریں:

```bash
cat <<'EOF' >/tmp/bot.molt.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist
```

- ریبوٹ درکار نہیں؛ logd فائل کو تیزی سے نوٹس کر لیتا ہے، لیکن صرف نئی لاگ لائنز میں نجی payloads شامل ہوں گی۔
- موجودہ helper کے ساتھ زیادہ بھرپور آؤٹ پٹ دیکھیں، مثلاً `./scripts/clawlog.sh --category WebChat --last 5m`۔

## ڈیبگنگ کے بعد غیر فعال کریں

- اووررائیڈ ہٹائیں: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`۔
- اختیاری طور پر فوراً logd کو اووررائیڈ چھوڑنے پر مجبور کرنے کے لیے `sudo log config --reload` چلائیں۔
- یاد رکھیں کہ اس سطح پر فون نمبرز اور پیغام کے متن شامل ہو سکتے ہیں؛ اضافی تفصیل کی فعال ضرورت کے دوران ہی plist کو برقرار رکھیں۔
