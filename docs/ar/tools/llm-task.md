---
summary: "مهام LLM بخرج JSON فقط لسير العمل (أداة إضافة اختيارية)"
read_when:
  - تريد خطوة LLM بخرج JSON فقط داخل سير العمل
  - تحتاج إلى خرج LLM مُتحقَّق منه بالمخطط لأغراض الأتمتة
title: "مهمة LLM"
---

# مهمة LLM

`llm-task` هي **أداة إضافة اختيارية** تُشغِّل مهمة LLM بخرج JSON فقط وتُعيد
خرجًا مُنظَّمًا (مع التحقق اختياريًا مقابل مخطط JSON).

يُعد هذا مثاليًا لمحركات سير العمل مثل Lobster: إذ يمكنك إضافة خطوة LLM واحدة
من دون كتابة كود OpenClaw مخصّص لكل سير عمل.

## تمكين الإضافة

1. فعِّل الإضافة:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. أدرِج الأداة في قائمة السماح (فهي مُسجَّلة ضمن `optional: true`):

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

## التهيئة (اختياري)

```json
{
  "plugins": {
    "entries": {
      "llm-task": {
        "enabled": true,
        "config": {
          "defaultProvider": "openai-codex",
          "defaultModel": "gpt-5.2",
          "defaultAuthProfileId": "main",
          "allowedModels": ["openai-codex/gpt-5.3-codex"],
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

`allowedModels` هي قائمة سماح لسلاسل `provider/model`. عند ضبطها، يُرفَض أي طلب
خارج القائمة.

## Tool parameters

- `prompt` (سلسلة، مطلوب)
- `input` (أيّ نوع، اختياري)
- `schema` (كائن، مخطط JSON اختياري)
- `provider` (سلسلة، اختياري)
- `model` (سلسلة، اختياري)
- `authProfileId` (سلسلة، اختياري)
- `temperature` (رقم، اختياري)
- `maxTokens` (رقم، اختياري)
- `timeoutMs` (رقم، اختياري)

## المخرجات

تُعيد `details.json` التي تحتوي على JSON المُحلَّل (وتُجري التحقق مقابل
`schema` عند توفيره).

## مثال: خطوة سير عمل Lobster

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": {
    "subject": "Hello",
    "body": "Can you help?"
  },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

## ملاحظات السلامة

- الأداة **JSON فقط** وتُوجِّه النموذج لإخراج JSON فقط (من دون
  أسوار كود، ومن دون تعليقات).
- لا تُعرَض أي أدوات على النموذج أثناء هذا التشغيل.
- تعامل مع المخرجات على أنها غير موثوقة ما لم تُحقِّقها باستخدام `schema`.
- ضع الموافقات قبل أي خطوة لها آثار جانبية (إرسال، نشر، تنفيذ).
