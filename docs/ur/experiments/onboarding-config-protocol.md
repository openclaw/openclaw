---
summary: "آن بورڈنگ وزرڈ اور کنفیگ اسکیما کے لیے RPC پروٹوکول نوٹس"
read_when: "آن بورڈنگ وزرڈ کے مراحل یا کنفیگ اسکیما اینڈپوائنٹس میں تبدیلی کرتے وقت"
title: "آن بورڈنگ اور کنفیگ پروٹوکول"
---

# آن بورڈنگ + کنفیگ پروٹوکول

مقصد: CLI، macOS ایپ، اور Web UI کے درمیان مشترکہ آن بورڈنگ + کنفیگ سطحیں۔

## اجزاء

- وزرڈ انجن (مشترکہ سیشن + پرامپٹس + آن بورڈنگ اسٹیٹ)۔
- CLI آن بورڈنگ، UI کلائنٹس کے ساتھ وہی وزرڈ فلو استعمال کرتی ہے۔
- Gateway RPC وزرڈ + کنفیگ اسکیما اینڈپوائنٹس فراہم کرتا ہے۔
- macOS آن بورڈنگ وزرڈ اسٹیپ ماڈل استعمال کرتی ہے۔
- Web UI، JSON Schema + UI ہنٹس سے کنفیگ فارمز رینڈر کرتا ہے۔

## Gateway RPC

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value?` } }\`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

Responses (شکل)

- Wizard: `{ sessionId, done, step?, status?, error?` } }\`
- Config schema: `{ schema, uiHints, version, generatedAt }`

## UI ہنٹس

- `uiHints` پاتھ کے ذریعے کیڈ؛ اختیاری میٹاڈیٹا (label/help/group/order/advanced/sensitive/placeholder)۔
- حساس فیلڈز پاس ورڈ اِن پٹس کے طور پر رینڈر ہوتے ہیں؛ کوئی ریڈیکشن لیئر نہیں۔
- غیر معاون اسکیما نوڈز خام JSON ایڈیٹر پر واپس آتے ہیں۔

## نوٹس

- یہ دستاویز آن بورڈنگ/کنفیگ کے لیے پروٹوکول ریفیکٹرز کو ٹریک کرنے کی واحد جگہ ہے۔
