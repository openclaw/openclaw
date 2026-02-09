---
summary: "ورک فلو کے لیے صرف JSON پر مبنی LLM ٹاسکس (اختیاری پلگ اِن ٹول)"
read_when:
  - آپ ورک فلو کے اندر صرف JSON پر مبنی LLM مرحلہ چاہتے ہیں
  - آپ آٹومیشن کے لیے اسکیما سے توثیق شدہ LLM آؤٹ پٹ چاہتے ہیں
title: "LLM ٹاسک"
---

# LLM ٹاسک

`llm-task` ایک **اختیاری پلگ اِن ٹول** ہے جو صرف JSON پر مبنی LLM ٹاسک چلاتا ہے اور
ساختہ آؤٹ پٹ واپس کرتا ہے (اختیاری طور پر JSON Schema کے مطابق توثیق کے ساتھ)۔

یہ Lobster جیسے ورک فلو انجنز کے لیے موزوں ہے: آپ ہر ورک فلو کے لیے حسبِ ضرورت OpenClaw کوڈ لکھے بغیر ایک واحد LLM مرحلہ شامل کر سکتے ہیں۔

## پلگ اِن فعال کریں

1. پلگ اِن فعال کریں:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. ٹول کو اجازت فہرست میں شامل کریں (یہ `optional: true` کے ساتھ رجسٹرڈ ہے):

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

## کنفیگ (اختیاری)

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

`allowedModels`، `provider/model` اسٹرنگز کی ایک allowlist ہے۔ اگر سیٹ ہو، تو فہرست سے باہر کی کوئی بھی درخواست مسترد کر دی جاتی ہے۔

## ٹول کے پیرامیٹرز

- `prompt` (string، لازم)
- `input` (any، اختیاری)
- `schema` (object، اختیاری JSON Schema)
- `provider` (string، اختیاری)
- `model` (string، اختیاری)
- `authProfileId` (string، اختیاری)
- `temperature` (number، اختیاری)
- `maxTokens` (number، اختیاری)
- `timeoutMs` (number، اختیاری)

## آؤٹ پٹ

`details.json` واپس کرتا ہے جس میں پارس کیا گیا JSON شامل ہوتا ہے (اور فراہم کیے جانے پر `schema` کے مطابق توثیق کرتا ہے)۔

## مثال: Lobster ورک فلو مرحلہ

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

## سکیورٹی نوٹس

- یہ ٹول **صرف JSON** ہے اور ماڈل کو ہدایت دیتا ہے کہ وہ صرف JSON آؤٹ پٹ دے (کوئی کوڈ فینس نہیں، کوئی تبصرہ نہیں)۔
- اس رَن کے لیے ماڈل کو کوئی ٹولز فراہم نہیں کیے جاتے۔
- آؤٹ پٹ کو غیر معتبر سمجھیں جب تک کہ آپ `schema` کے ساتھ توثیق نہ کر لیں۔
- کسی بھی سائیڈ ایفیکٹ والے مرحلے (send، post، exec) سے پہلے منظوریات رکھیں۔
