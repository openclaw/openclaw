---
summary: "استخدم واجهة Qianfan البرمجية الموحّدة للوصول إلى العديد من النماذج في OpenClaw"
read_when:
  - تريد مفتاح API واحدًا للعديد من نماذج LLM
  - تحتاج إلى إرشادات إعداد Baidu Qianfan
title: "Qianfan"
---

# دليل موفّر Qianfan

Qianfan هي منصة MaaS من Baidu، وتوفّر **واجهة برمجية موحّدة** تقوم بتوجيه الطلبات إلى العديد من النماذج خلف نقطة نهاية واحدة ومفتاح API واحد. وهي متوافقة مع OpenAI، لذلك تعمل معظم حِزم OpenAI SDK عبر تبديل عنوان URL الأساسي.

## المتطلبات المسبقة

1. حساب Baidu Cloud مع تفعيل الوصول إلى واجهة Qianfan البرمجية
2. مفتاح API من وحدة تحكم Qianfan
3. تثبيت OpenClaw على نظامك

## الحصول على مفتاح API

1. انتقل إلى [وحدة تحكم Qianfan](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. أنشئ تطبيقًا جديدًا أو اختر تطبيقًا موجودًا
3. أنشئ مفتاح API (الصيغة: `bce-v3/ALTAK-...`)
4. انسخ مفتاح API لاستخدامه مع OpenClaw

## إعداد CLI

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## وثائق ذات صلة

- [تهيئة OpenClaw](/gateway/configuration)
- [موفّرو النماذج](/concepts/model-providers)
- [إعداد الوكيل](/concepts/agent)
- [توثيق واجهة Qianfan البرمجية](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
