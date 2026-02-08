---
summary: "طقس تهيئة الوكيل الذي يزرع مساحة العمل وملفات الهوية"
read_when:
  - "فهم ما يحدث عند التشغيل الأول للوكيل"
  - "شرح مكان وجود ملفات التهيئة"
  - "استكشاف أخطاء إعداد هوية التهيئة الأولية وإصلاحها"
title: "تهيئة الوكيل"
sidebarTitle: "التهيئة"
x-i18n:
  source_path: start/bootstrapping.md
  source_hash: 4a08b5102f25c6c4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:39Z
---

# تهيئة الوكيل

التهيئة هي طقس **التشغيل الأول** الذي يُحضِّر مساحة عمل الوكيل ويجمع تفاصيل
الهوية. تحدث بعد التهيئة الأولية، عندما يبدأ الوكيل للمرة الأولى.

## ما الذي تفعله التهيئة

عند أول تشغيل للوكيل، يقوم OpenClaw بتهيئة مساحة العمل (الافتراضية
`~/.openclaw/workspace`):

- يزرع `AGENTS.md`، `BOOTSTRAP.md`، `IDENTITY.md`، `USER.md`.
- يُجري طقس أسئلة وأجوبة قصير (سؤال واحد في كل مرة).
- يكتب الهوية + التفضيلات إلى `IDENTITY.md`، `USER.md`، `SOUL.md`.
- يزيل `BOOTSTRAP.md` عند الانتهاء بحيث يعمل مرة واحدة فقط.

## أين يتم التشغيل

تعمل التهيئة دائمًا على **مضيف Gateway**. إذا اتصل تطبيق macOS بـ Gateway
بعيد، فستكون مساحة العمل وملفات التهيئة موجودة على تلك الآلة البعيدة.

<Note>
عندما يعمل Gateway على آلة أخرى، قم بتحرير ملفات مساحة العمل على مضيف Gateway
(على سبيل المثال، `user@gateway-host:~/.openclaw/workspace`).
</Note>

## مستندات ذات صلة

- تهيئة تطبيق macOS: [Onboarding](/start/onboarding)
- تخطيط مساحة العمل: [Agent workspace](/concepts/agent-workspace)
