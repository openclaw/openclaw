---
summary: "CLI کے لیے حوالہ برائے `openclaw memory` (اسٹیٹس/انڈیکس/تلاش)"
read_when:
  - آپ سیمینٹک میموری کو انڈیکس یا تلاش کرنا چاہتے ہوں
  - آپ میموری کی دستیابی یا انڈیکسنگ کی ڈیبگنگ کر رہے ہوں
title: "میموری"
---

# `openclaw memory`

2. معنوی میموری کی انڈیکسنگ اور تلاش کا نظم کریں۔
3. فعال میموری پلگ ان کے ذریعے فراہم کیا جاتا ہے (ڈیفالٹ: `memory-core`؛ غیر فعال کرنے کے لیے `plugins.slots.memory = "none"` سیٹ کریں)۔

متعلقہ:

- میموری کا تصور: [Memory](/concepts/memory)
- پلگ اِنز: [Plugins](/tools/plugin)

## مثالیں

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## اختیارات

عام:

- `--agent <id>`: دائرہ کار کو ایک واحد ایجنٹ تک محدود کریں (بطورِ طے شدہ: تمام کنفیگر کیے گئے ایجنٹس)۔
- `--verbose`: پروبز اور انڈیکسنگ کے دوران تفصیلی لاگز جاری کریں۔

نوٹس:

- `memory status --deep` ویکٹر اور ایمبیڈنگ کی دستیابی کو پروب کرتا ہے۔
- `memory status --deep --index` اگر اسٹور ڈرٹی ہو تو ری انڈیکس چلاتا ہے۔
- `memory index --verbose` ہر مرحلے کی تفصیلات پرنٹ کرتا ہے (فراہم کنندہ، ماڈل، ذرائع، بیچ سرگرمی)۔
- `memory status` وہ تمام اضافی راستے شامل کرتا ہے جو `memorySearch.extraPaths` کے ذریعے کنفیگر کیے گئے ہوں۔
