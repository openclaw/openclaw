---
title: "بوابة Vercel AI"
summary: "إعداد بوابة Vercel AI (المصادقة + اختيار النموذج)"
read_when:
  - تريد استخدام بوابة Vercel AI مع OpenClaw
  - تحتاج إلى متغير بيئة مفتاح واجهة برمجة التطبيقات أو خيار المصادقة عبر CLI
---

# بوابة Vercel AI

توفر [Vercel AI Gateway](https://vercel.com/ai-gateway) واجهة برمجة تطبيقات موحّدة للوصول إلى مئات النماذج عبر نقطة نهاية واحدة.

- الموفّر: `vercel-ai-gateway`
- المصادقة: `AI_GATEWAY_API_KEY`
- واجهة البرمجة: متوافقة مع رسائل Anthropic

## البدء السريع

1. عيّن مفتاح واجهة برمجة التطبيقات (موصى به: تخزينه لـ Gateway):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. عيّن نموذجًا افتراضيًا:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## مثال غير تفاعلي

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## ملاحظة حول البيئة

إذا كانت Gateway تعمل كخدمة (launchd/systemd)، فتأكد من أن `AI_GATEWAY_API_KEY`
متاح لتلك العملية (على سبيل المثال، في `~/.openclaw/.env` أو عبر
`env.shellEnv`).
