---
title: "سير عمل تطوير Pi"
---

# سير عمل تطوير Pi

يلخّص هذا الدليل سير عمل عملي ومعقول للعمل على تكامل Pi في OpenClaw.

## التحقق من الأنواع والتدقيق اللغوي

- التحقق من الأنواع والبناء: `pnpm build`
- التدقيق اللغوي (Lint): `pnpm lint`
- التحقق من التنسيق: `pnpm format`
- البوابة الكاملة قبل الدفع: `pnpm lint && pnpm build && pnpm test`

## تشغيل اختبارات Pi

استخدم السكربت المخصّص لمجموعة اختبارات تكامل Pi:

```bash
scripts/pi/run-tests.sh
```

لتضمين الاختبار الحي الذي يختبر سلوك الموفّر الحقيقي:

```bash
scripts/pi/run-tests.sh --live
```

يقوم السكربت بتشغيل جميع اختبارات الوحدات المتعلقة بـ Pi عبر أنماط المطابقة التالية:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## الاختبار اليدوي

التدفق الموصى به:

- تشغيل Gateway في وضع التطوير:
  - `pnpm gateway:dev`
- استدعاء الوكيل مباشرة:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- استخدام واجهة TUI للتصحيح التفاعلي:
  - `pnpm tui`

لسلوك استدعاءات الأدوات، اطلب إجراء `read` أو `exec` حتى تتمكن من رؤية بثّ الأدوات ومعالجة الحمولة.

## إعادة الضبط إلى حالة نظيفة

توجد الحالة ضمن دليل حالة OpenClaw. الافتراضي هو `~/.openclaw`. إذا تم تعيين `OPENCLAW_STATE_DIR`، فاستخدم ذلك الدليل بدلًا منه.

لإعادة ضبط كل شيء:

- `openclaw.json` للتهيئة
- `credentials/` لملفات تعريف المصادقة والرموز
- `agents/<agentId>/sessions/` لسجل جلسات الوكيل
- `agents/<agentId>/sessions.json` لفهرس الجلسات
- `sessions/` إذا وُجدت مسارات قديمة
- `workspace/` إذا كنت تريد مساحة عمل فارغة

إذا كنت تريد إعادة ضبط الجلسات فقط، فاحذف `agents/<agentId>/sessions/` و`agents/<agentId>/sessions.json` لذلك الوكيل. احتفظ بـ `credentials/` إذا كنت لا تريد إعادة المصادقة.

## المراجع

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
