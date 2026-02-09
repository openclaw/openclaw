---
summary: "OpenClaw میں متعدد ماڈلز تک رسائی کے لیے Qianfan کی متحدہ API استعمال کریں"
read_when:
  - آپ متعدد LLMs کے لیے ایک واحد API کلید چاہتے ہیں
  - آپ کو Baidu Qianfan کے سیٹ اپ کی رہنمائی درکار ہے
title: "Qianfan"
---

# Qianfan فراہم کنندہ رہنما

Qianfan Baidu کا MaaS پلیٹ فارم ہے، جو ایک **unified API** فراہم کرتا ہے جو ایک ہی endpoint اور API key کے پیچھے متعدد ماڈلز تک ریکویسٹ روٹ کرتا ہے۔ یہ OpenAI-compatible ہے، اس لیے زیادہ تر OpenAI SDKs بیس URL تبدیل کر کے کام کر لیتے ہیں۔

## پیشگی تقاضے

1. Qianfan API رسائی کے ساتھ Baidu Cloud اکاؤنٹ
2. Qianfan کنسول سے ایک API کلید
3. آپ کے سسٹم پر OpenClaw انسٹال ہونا

## اپنی API کلید حاصل کرنا

1. [Qianfan کنسول](https://console.bce.baidu.com/qianfan/ais/console/apiKey) ملاحظہ کریں
2. نئی ایپلیکیشن بنائیں یا کسی موجودہ کو منتخب کریں
3. ایک API کلید تیار کریں (فارمیٹ: `bce-v3/ALTAK-...`)
4. OpenClaw کے ساتھ استعمال کے لیے API کلید کاپی کریں

## CLI سیٹ اپ

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## متعلقہ دستاویزات

- [OpenClaw Configuration](/gateway/configuration)
- [Model Providers](/concepts/model-providers)
- [Agent Setup](/concepts/agent)
- [Qianfan API Documentation](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
