---
summary: "اعلیٰ معیار کے مسائل اور بگ رپورٹس جمع کرانا"
title: "مسئلہ جمع کرانا"
---

## مسئلہ جمع کرانا

واضح اور مختصر ایشوز تشخیص اور فکسز کو تیز کرتے ہیں۔ بگز، ریگریشنز، یا فیچر گیپس کے لیے درج ذیل شامل کریں:

### کیا شامل کریں

- [ ] عنوان: حصہ اور علامت
- [ ] کم سے کم ری پرو اقدامات
- [ ] متوقع بمقابلہ حقیقی
- [ ] اثر اور شدت
- [ ] ماحول: OS، رن ٹائم، ورژنز، کنفیگ
- [ ] شواہد: ریڈیکٹڈ لاگز، اسکرین شاٹس (غیر-PII)
- [ ] دائرہ: نیا، ریگریشن، یا طویل عرصے سے موجود
- [ ] کوڈ ورڈ: lobster-biscuit اپنے ایشو میں شامل کریں
- [ ] موجودہ ایشو کے لیے کوڈ بیس اور GitHub میں تلاش کیا
- [ ] تصدیق کہ حال ہی میں درست/حل نہیں ہوا (خصوصاً سکیورٹی)
- [ ] دعوے شواہد یا ری پرو سے ثابت ہوں

مختصر رہیں۔ اختصار > کامل گرامر۔

تصدیق (PR سے پہلے چلائیں/درست کریں):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- اگر پروٹوکول کوڈ ہو: `pnpm protocol:check`

### ٹیمپلیٹس

#### بگ رپورٹ

```md
- [ ] Minimal repro
- [ ] Expected vs actual
- [ ] Environment
- [ ] Affected channels, where not seen
- [ ] Logs/screenshots (redacted)
- [ ] Impact/severity
- [ ] Workarounds

### Summary

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact

### Workarounds
```

#### سکیورٹی مسئلہ

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

30. _عوامی جگہوں پر راز/ایکسپلائٹ کی تفصیلات سے پرہیز کریں۔ حساس مسائل کے لیے، تفصیل کم رکھیں اور نجی انکشاف کی درخواست کریں۔_

#### ریگریشن رپورٹ

```md
### Summary

### Last Known Good

### First Known Bad

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact
```

#### فیچر کی درخواست

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### بہتری

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### تحقیق

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### فکس PR جمع کرانا

PR سے پہلے ایشو بنانا اختیاری ہے۔ اگر چھوڑ رہے ہیں تو PR میں تفصیلات شامل کریں۔ PR کو مرکوز رکھیں، ایشو نمبر نوٹ کریں، ٹیسٹس شامل کریں یا عدم موجودگی کی وضاحت کریں، رویّے میں تبدیلیوں/خطرات کو دستاویز کریں، ثبوت کے طور پر ریڈیکٹڈ لاگز/اسکرین شاٹس شامل کریں، اور جمع کرانے سے پہلے مناسب ویلیڈیشن چلائیں۔
