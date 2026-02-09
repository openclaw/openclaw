---
summary: "تسجيل OpenClaw: ملف تشخيصي دوّار + أعلام خصوصية السجل الموحّد"
read_when:
  - التقاط سجلات macOS أو التحقيق في تسجيل البيانات الخاصة
  - تصحيح أخطاء تنشيط الصوت ودورة حياة الجلسة
title: "تسجيل macOS"
---

# التسجيل (macOS)

## ملف سجل تشخيصي دوّار (لوحة Debug)

يقوم OpenClaw بتوجيه سجلات تطبيق macOS عبر swift-log (التسجيل الموحّد افتراضيًا)، ويمكنه كتابة ملف سجل محلي دوّار على القرص عندما تحتاج إلى التقاط دائم.

- مستوى التفصيل: **لوحة Debug → Logs → App logging → Verbosity**
- التمكين: **لوحة Debug → Logs → App logging → “Write rolling diagnostics log (JSONL)”**
- الموقع: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (يدور تلقائيًا؛ تُلحَق الملفات القديمة باللاحقات `.1`، `.2`، …)
- المسح: **لوحة Debug → Logs → App logging → “Clear”**

ملاحظات:

- هذا الخيار **معطّل افتراضيًا**. فعِّله فقط أثناء التصحيح النشط.
- تعامل مع الملف على أنه حساس؛ لا تشاركه دون مراجعة.

## البيانات الخاصة في التسجيل الموحّد على macOS

يقوم التسجيل الموحّد بحجب معظم الحمولات ما لم يختَر نظامٌ فرعيٌّ الانضمام إلى `privacy -off`. وفقًا لشرح Peter حول macOS [حِيَل خصوصية التسجيل](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025)، يتم التحكم بذلك عبر ملف plist في `/Library/Preferences/Logging/Subsystems/` مُفهرَس باسم النظام الفرعي. تلتقط العلامةُ فقط إدخالات السجل الجديدة، لذا فعِّلها قبل إعادة إنتاج المشكلة.

## التمكين لـ OpenClaw (`bot.molt`)

- اكتب ملف plist إلى ملف مؤقت أولًا، ثم ثبّته بشكل ذريّ بصلاحيات الجذر:

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

- لا يلزم إعادة تشغيل؛ يلتقط logd الملف بسرعة، لكن ستتضمن فقط أسطر السجل الجديدة الحمولات الخاصة.
- اعرض المخرجات الأكثر ثراءً باستخدام الأداة المساعدة الموجودة، مثلًا `./scripts/clawlog.sh --category WebChat --last 5m`.

## التعطيل بعد التصحيح

- أزل التجاوز: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- اختياريًا، شغّل `sudo log config --reload` لإجبار logd على إسقاط التجاوز فورًا.
- تذكّر أن هذه الواجهة قد تتضمن أرقام هواتف ونصوص رسائل؛ احتفِظ بملف plist في مكانه فقط طالما كنت بحاجة فعلية إلى هذا المستوى الإضافي من التفاصيل.
