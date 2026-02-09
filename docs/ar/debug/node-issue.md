---
summary: ملاحظات وتعويضات لتعطّل Node + tsx برسالة «__name is not a function»
read_when:
  - تصحيح أخطاء سكربتات التطوير الخاصة بـ Node فقط أو أعطال وضع المراقبة
  - التحقيق في أعطال مُحمِّل tsx/esbuild في OpenClaw
title: "تعطّل Node + tsx"
---

# تعطّل Node + tsx «\_\_name is not a function»

## الملخص

يؤدي تشغيل OpenClaw عبر Node مع `tsx` إلى الفشل عند بدء التشغيل مع الرسالة:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

بدأ ذلك بعد تبديل سكربتات التطوير من Bun إلى `tsx` (الالتزام `2871657e`، 2026-01-06). كان مسار وقت التشغيل نفسه يعمل مع Bun.

## البيئة

- Node: الإصدار v25.x (لوحِظ على v25.3.0)
- tsx: 4.21.0
- نظام التشغيل: macOS (ومن المحتمل إعادة إنتاجه أيضًا على منصات أخرى تشغّل Node 25)

## إعادة الإنتاج (Node فقط)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## الحد الأدنى لإعادة الحرف في المستودع

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## التحقق من إصدار Node

- Node 25.3.0: يفشل
- Node 22.22.0 (Homebrew `node@22`): يفشل
- Node 24: غير مُثبّت هنا بعد؛ يحتاج إلى تحقق

## ملاحظات / فرضية

- يستخدم `tsx` مكتبة esbuild لتحويل TS/ESM. يُصدر خيار `keepNames` في esbuild مُساعدًا باسم `__name` ويغلّف تعريفات الدوال بـ `__name(...)`.
- يشير التعطّل إلى أنّ `__name` موجود لكنه ليس دالة في وقت التشغيل، ما يوحي بأن المُساعد مفقود أو أُعيدت كتابته لهذه الوحدة ضمن مسار مُحمِّل Node 25.
- تم الإبلاغ عن مشكلات مُشابهة لمُساعد `__name` لدى مستهلكين آخرين لـ esbuild عندما يكون المُساعد مفقودًا أو أُعيدت كتابته.

## تاريخ الانحدار

- `2871657e` (2026-01-06): تغيّرت السكربتات من Bun إلى tsx لجعل Bun اختياريًا.
- قبل ذلك (مسار Bun)، كان `openclaw status` و `gateway:watch` يعملان.

## الحلول الالتفافية

- استخدام Bun لسكربتات التطوير (تراجع مؤقت حالي).

- استخدام Node + tsc في وضع المراقبة، ثم تشغيل المخرجات المُترجمة:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- تم التأكيد محليًا: يعمل `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` على Node 25.

- تعطيل خيار esbuild keepNames في مُحمِّل TS إن أمكن (يمنع إدراج مُساعد `__name`)؛ لا يوفّر tsx هذا حاليًا.

- اختبار Node LTS (22/24) مع `tsx` لمعرفة ما إذا كانت المشكلة خاصة بـ Node 25.

## المراجع

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## الخطوات التالية

- إعادة الإنتاج على Node 22/24 لتأكيد انحدار Node 25.
- اختبار `tsx` الليلي أو التثبيت على إصدار أقدم إذا وُجد انحدار معروف.
- إذا أُعيد الإنتاج على Node LTS، فقم برفع إعادة إنتاج مصغّرة إلى المصدر الأعلى مع تتبّع المكدس `__name`.
