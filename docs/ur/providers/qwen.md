---
summary: "OpenClaw میں Qwen OAuth (فری ٹئیر) استعمال کریں"
read_when:
  - آپ OpenClaw کے ساتھ Qwen استعمال کرنا چاہتے ہیں
  - آپ Qwen Coder کے لیے فری ٹئیر OAuth رسائی چاہتے ہیں
title: "Qwen"
---

# Qwen

Qwen، Qwen Coder اور Qwen Vision ماڈلز کے لیے فری ٹئیر OAuth فلو فراہم کرتا ہے
(یومیہ 2,000 درخواستیں، Qwen کی ریٹ لمٹس کے تابع)۔

## پلگ اِن فعال کریں

```bash
openclaw plugins enable qwen-portal-auth
```

فعال کرنے کے بعد Gateway کو دوبارہ شروع کریں۔

## تصدیق

```bash
openclaw models auth login --provider qwen-portal --set-default
```

یہ Qwen ڈیوائس-کوڈ OAuth فلو چلاتا ہے اور آپ کے
`models.json` میں ایک فراہم کنندہ اندراج لکھتا ہے
(ساتھ ہی تیز سوئچنگ کے لیے ایک `qwen` عرف)۔

## ماڈل IDs

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

ماڈلز تبدیل کریں:

```bash
openclaw models set qwen-portal/coder-model
```

## Qwen Code CLI لاگ اِن کو دوبارہ استعمال کریں

اگر آپ پہلے ہی Qwen Code CLI کے ساتھ لاگ اِن ہیں، تو OpenClaw جب auth store لوڈ کرتا ہے تو `~/.qwen/oauth_creds.json` سے اسناد ہم آہنگ کر لے گا۔ آپ کو پھر بھی ایک `models.providers.qwen-portal` انٹری درکار ہے (اوپر دیا گیا login کمانڈ استعمال کر کے ایک بنائیں)۔

## نوٹس

- ٹوکن خودکار طور پر ریفریش ہوتے ہیں؛ اگر ریفریش ناکام ہو جائے یا رسائی منسوخ ہو جائے تو لاگ اِن کمانڈ دوبارہ چلائیں۔
- طے شدہ بیس URL: `https://portal.qwen.ai/v1` (اگر Qwen کوئی مختلف اینڈ پوائنٹ فراہم کرے تو
  `models.providers.qwen-portal.baseUrl` کے ساتھ اووررائیڈ کریں)۔
- فراہم کنندہ سطح کے قواعد کے لیے [Model providers](/concepts/model-providers) دیکھیں۔
