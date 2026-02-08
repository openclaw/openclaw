---
title: "بوابة Cloudflare للذكاء الاصطناعي"
summary: "إعداد بوابة Cloudflare للذكاء الاصطناعي (المصادقة + اختيار النموذج)"
read_when:
  - "تريد استخدام بوابة Cloudflare للذكاء الاصطناعي مع OpenClaw"
  - "تحتاج إلى معرّف الحساب أو معرّف البوابة أو متغير بيئة مفتاح واجهة برمجة التطبيقات"
x-i18n:
  source_path: providers/cloudflare-ai-gateway.md
  source_hash: db77652c37652ca2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:32Z
---

# بوابة Cloudflare للذكاء الاصطناعي

تعمل بوابة Cloudflare للذكاء الاصطناعي كطبقة أمام واجهات برمجة تطبيقات الموفّرين، وتتيح لك إضافة التحليلات والتخزين المؤقت وعناصر التحكم. بالنسبة إلى Anthropic، يستخدم OpenClaw واجهة Anthropic Messages API عبر نقطة نهاية البوابة الخاصة بك.

- الموفّر: `cloudflare-ai-gateway`
- عنوان URL الأساسي: `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
- النموذج الافتراضي: `cloudflare-ai-gateway/claude-sonnet-4-5`
- مفتاح واجهة برمجة التطبيقات: `CLOUDFLARE_AI_GATEWAY_API_KEY` (مفتاح واجهة برمجة التطبيقات الخاص بالموفّر للطلبات عبر البوابة)

لنماذج Anthropic، استخدم مفتاح واجهة برمجة تطبيقات Anthropic الخاص بك.

## البدء السريع

1. عيّن مفتاح واجهة برمجة تطبيقات الموفّر وتفاصيل البوابة:

```bash
openclaw onboard --auth-choice cloudflare-ai-gateway-api-key
```

2. عيّن نموذجًا افتراضيًا:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" },
    },
  },
}
```

## مثال غير تفاعلي

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cloudflare-ai-gateway-api-key \
  --cloudflare-ai-gateway-account-id "your-account-id" \
  --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
  --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY"
```

## بوابات مع مصادقة

إذا قمت بتمكين مصادقة البوابة في Cloudflare، فأضِف الترويسة `cf-aig-authorization` (وذلك بالإضافة إلى مفتاح واجهة برمجة تطبيقات الموفّر).

```json5
{
  models: {
    providers: {
      "cloudflare-ai-gateway": {
        headers: {
          "cf-aig-authorization": "Bearer <cloudflare-ai-gateway-token>",
        },
      },
    },
  },
}
```

## ملاحظة حول البيئة

إذا كانت البوابة تعمل كخدمة خلفية (launchd/systemd)، فتأكد من أن `CLOUDFLARE_AI_GATEWAY_API_KEY` متاح لتلك العملية (على سبيل المثال، في `~/.openclaw/.env` أو عبر `env.shellEnv`).
