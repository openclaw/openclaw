---
summary: "OpenClaw لاگنگ: رولنگ ڈائیگناسٹکس فائل لاگ + یونیفائیڈ لاگ پرائیویسی فلیگز"
read_when:
  - macOS لاگز کی گرفت یا نجی ڈیٹا کی لاگنگ کی تفتیش کرتے وقت
  - وائس ویک/سیشن لائف سائیکل کے مسائل کی ڈیبگنگ کرتے وقت
title: "macOS لاگنگ"
---

# لاگنگ (macOS)

## رولنگ ڈائیگناسٹکس فائل لاگ (Debug pane)

OpenClaw macOS ایپ کے لاگز کو swift-log کے ذریعے روٹ کرتا ہے (بطورِ طے شدہ یونیفائیڈ لاگنگ) اور جب آپ کو پائیدار کیپچر درکار ہو تو ڈسک پر ایک مقامی، گھومتی ہوئی فائل لاگ بھی لکھ سکتا ہے۔

- Verbosity: **Debug pane → Logs → App logging → Verbosity**
- Enable: **Debug pane → Logs → App logging → “Write rolling diagnostics log (JSONL)”**
- مقام: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (خودکار طور پر روٹیٹ ہوتا ہے؛ پرانی فائلوں کے آخر میں `.1`، `.2`، … لگ جاتا ہے)
- Clear: **Debug pane → Logs → App logging → “Clear”**

نوٹس:

- یہ **ڈیفالٹ طور پر بند** ہے۔ صرف اس وقت فعال کریں جب آپ واقعی ڈیبگ کر رہے ہوں۔
- فائل کو حساس سمجھیں؛ نظرِ ثانی کے بغیر اسے شیئر نہ کریں۔

## macOS پر یونیفائیڈ لاگنگ میں نجی ڈیٹا

یونفائیڈ لاگنگ زیادہ تر پےلوڈز کو ریڈیکٹ کر دیتی ہے جب تک کہ کوئی سب سسٹم `privacy -off` میں آپٹ اِن نہ کرے۔ پیٹر کی macOS پر [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) والی تحریر کے مطابق، یہ `/Library/Preferences/Logging/Subsystems/` میں موجود ایک plist کے ذریعے کنٹرول ہوتا ہے جو سب سسٹم کے نام سے کیڈ ہوتی ہے۔ صرف نئے لاگ انٹریز ہی اس فلیگ کو حاصل کرتی ہیں، اس لیے مسئلہ دوبارہ پیدا کرنے سے پہلے اسے فعال کریں۔

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
