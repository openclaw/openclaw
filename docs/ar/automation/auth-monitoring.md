---
summary: "مراقبة انتهاء صلاحية OAuth لموفّري النماذج"
read_when:
  - إعداد مراقبة أو تنبيهات لانتهاء صلاحية المصادقة
  - أتمتة فحوصات تحديث OAuth لـ Claude Code / Codex
title: "مراقبة المصادقة"
---

# مراقبة المصادقة

يُتيح OpenClaw حالة سلامة انتهاء صلاحية OAuth عبر `openclaw models status`. استخدم ذلك
للأتمتة والتنبيه؛ وتُعدّ السكربتات إضافات اختيارية لسير عمل الهاتف.

## المُفضّل: فحص عبر CLI (محمول)

```bash
openclaw models status --check
```

رموز الخروج:

- `0`: سليم
- `1`: بيانات اعتماد منتهية أو مفقودة
- `2`: على وشك الانتهاء (خلال 24 ساعة)

يعمل هذا ضمن cron/systemd ولا يتطلب أي سكربتات إضافية.

## سكربتات اختيارية (العمليات / سير عمل الهاتف)

توجد هذه ضمن `scripts/` وهي **اختيارية**. تفترض وصول SSH إلى
مضيف Gateway ومُهيّأة لـ systemd + Termux.

- `scripts/claude-auth-status.sh` يستخدم الآن `openclaw models status --json` باعتباره
  مصدر الحقيقة (مع الرجوع إلى قراءة الملفات مباشرةً إذا كان CLI غير متاح)،
  لذا أبقِ `openclaw` على `PATH` للمؤقّتات.
- `scripts/auth-monitor.sh`: هدف cron/systemd للمؤقّت؛ يرسل تنبيهات (ntfy أو الهاتف).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: مؤقّت مستخدم systemd.
- `scripts/claude-auth-status.sh`: فاحص مصادقة Claude Code + OpenClaw (كامل/JSON/بسيط).
- `scripts/mobile-reauth.sh`: تدفّق إعادة مصادقة موجّه عبر SSH.
- `scripts/termux-quick-auth.sh`: حالة ويدجت بنقرة واحدة + فتح عنوان URL للمصادقة.
- `scripts/termux-auth-widget.sh`: تدفّق ويدجت موجّه كامل.
- `scripts/termux-sync-widget.sh`: مزامنة بيانات اعتماد Claude Code → OpenClaw.

إذا لم تكن بحاجة إلى أتمتة الهاتف أو مؤقّتات systemd، فتجاوز هذه السكربتات.
