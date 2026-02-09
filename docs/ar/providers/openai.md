---
summary: "استخدم OpenAI عبر مفاتيح API أو اشتراك Codex في OpenClaw"
read_when:
  - تريد استخدام نماذج OpenAI في OpenClaw
  - تريد مصادقة اشتراك Codex بدلًا من مفاتيح API
title: "OpenAI"
---

# OpenAI

توفّر OpenAI واجهات برمجة تطبيقات للمطوّرين لنماذج GPT. يدعم Codex **تسجيل الدخول إلى ChatGPT** للوصول القائم على الاشتراك أو **تسجيل الدخول بمفتاح API** للوصول القائم على الاستهلاك. تتطلّب سحابة Codex تسجيل الدخول إلى ChatGPT.

## الخيار A: مفتاح OpenAI API (منصّة OpenAI)

**الأفضل لـ:** الوصول المباشر إلى واجهة البرمجة والفوترة القائمة على الاستهلاك.
احصل على مفتاح API من لوحة تحكّم OpenAI.

### إعداد CLI

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### مقتطف تهيئة

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## الخيار B: اشتراك OpenAI Code (Codex)

**الأفضل لـ:** استخدام وصول اشتراك ChatGPT/Codex بدلًا من مفتاح API.
تتطلّب سحابة Codex تسجيل الدخول إلى ChatGPT، بينما يدعم Codex CLI تسجيل الدخول إلى ChatGPT أو بمفتاح API.

### إعداد CLI (مصادقة Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### مقتطف تهيئة (اشتراك Codex)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## ملاحظات

- تستخدم مراجع النماذج دائمًا `provider/model` (انظر [/concepts/models](/concepts/models)).
- توجد تفاصيل المصادقة + قواعد إعادة الاستخدام في [/concepts/oauth](/concepts/oauth).
