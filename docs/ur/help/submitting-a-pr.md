---
summary: "اعلیٰ سگنل PR کیسے جمع کریں"
title: "PR جمع کرنا"
---

اچھی PRs کا جائزہ لینا آسان ہوتا ہے: ریویورز کو جلدی سے نیت سمجھ آ جانی چاہیے، رویّے کی تصدیق ہو سکے، اور تبدیلیاں محفوظ طریقے سے مرج کی جا سکیں۔ یہ گائیڈ انسانوں اور LLM ریویو کے لیے مختصر، اعلیٰ سگنل سبمشنز کا احاطہ کرتی ہے۔

## ایک اچھے PR کی خصوصیات

- [ ] مسئلہ، اس کی اہمیت، اور کی گئی تبدیلی کی وضاحت کریں۔
- [ ] تبدیلیوں کو مرکوز رکھیں۔ وسیع ریفیکٹرز سے گریز کریں۔
- [ ] صارف کو نظر آنے والی/کنفیگ/بطورِ طے شدہ تبدیلیوں کا خلاصہ دیں۔
- [ ] ٹیسٹ کوریج، اسکیپس، اور وجوہات درج کریں۔
- [ ] شواہد شامل کریں: لاگز، اسکرین شاٹس، یا ریکارڈنگز (UI/UX)۔
- [ ] کوڈ لفظ: اگر آپ نے یہ رہنما پڑھا ہے تو PR کی وضاحت میں “lobster-biscuit” شامل کریں۔
- [ ] PR بنانے سے پہلے متعلقہ `pnpm` کمانڈز چلائیں/ناکامیاں درست کریں۔
- [ ] متعلقہ فعالیت/مسائل/فکسز کے لیے کوڈبیس اور GitHub میں تلاش کریں۔
- [ ] دعوؤں کی بنیاد شواہد یا مشاہدے پر رکھیں۔
- [ ] اچھا عنوان: فعل + دائرہ + نتیجہ (مثلاً `Docs: add PR and issue templates`)۔

مختصر رہیں؛ مختصر ریویو > گرامر۔ 29. کسی بھی غیر قابلِ اطلاق حصے کو چھوڑ دیں۔

### بنیادی تصدیقی کمانڈز (اپنی تبدیلی کے لیے ناکامیوں کو چلائیں/درست کریں)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- پروٹوکول تبدیلیاں: `pnpm protocol:check`

## تدریجی انکشاف

- اوپر: خلاصہ/مقصد
- اگلا: تبدیلیاں/خطرات
- اگلا: ٹیسٹ/تصدیق
- آخر میں: نفاذ/شواہد

## عام PR اقسام: مخصوصات

- [ ] فکس: ری پرو، بنیادی وجہ، تصدیق شامل کریں۔
- [ ] فیچر: استعمال کے کیسز، رویّہ/ڈیموز/اسکرین شاٹس (UI) شامل کریں۔
- [ ] ری فیکٹر: "کوئی رویّہ تبدیلی نہیں" واضح کریں، کیا منتقل/سادہ کیا گیا درج کریں۔
- [ ] کور: وجہ بتائیں (مثلاً بلڈ وقت، CI، انحصارات)۔
- [ ] ڈاکس: پہلے/بعد کا سیاق، اپ ڈیٹ شدہ صفحے کا لنک، `pnpm format` چلائیں۔
- [ ] ٹیسٹ: کون سا خلا پُر ہوا؛ ریگریشنز کیسے روکتی ہے۔
- [ ] پرف: پہلے/بعد کے میٹرکس، اور پیمائش کا طریقہ۔
- [ ] UX/UI: اسکرین شاٹس/ویڈیو، رسائی پر اثر نوٹ کریں۔
- [ ] انفرا/بلڈ: ماحولیات/تصدیق۔
- [ ] سیکیورٹی: رسک، ری پرو، تصدیق کا خلاصہ کریں، کوئی حساس ڈیٹا شامل نہ کریں۔ صرف ٹھوس/بنیادی دعوے کریں۔

## چیک لسٹ

- [ ] واضح مسئلہ/مقصد
- [ ] مرکوز دائرہ
- [ ] رویّہ تبدیلیوں کی فہرست
- [ ] ٹیسٹس اور ان کے نتائج
- [ ] دستی ٹیسٹ مراحل (جب قابلِ اطلاق ہوں)
- [ ] کوئی راز/نجی ڈیٹا نہیں
- [ ] شواہد پر مبنی

## عمومی PR ٹیمپلیٹ

```md
#### Summary

#### Behavior Changes

#### Codebase and GitHub Search

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort (self-reported):
- Agent notes (optional, cite evidence):
```

## PR قسم کے ٹیمپلیٹس (اپنی قسم سے بدلیں)

### Fix

```md
#### Summary

#### Repro Steps

#### Root Cause

#### Behavior Changes

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Feature

```md
#### Summary

#### Use Cases

#### Behavior Changes

#### Existing Functionality Check

- [ ] I searched the codebase for existing functionality.
      Searches performed (1-3 bullets):
  -
  -

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Refactor

```md
#### Summary

#### Scope

#### No Behavior Change Statement

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Chore/Maintenance

```md
#### Summary

#### Why This Matters

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Docs

```md
#### Summary

#### Pages Updated

#### Before/After

#### Formatting

pnpm format

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Test

```md
#### Summary

#### Gap Covered

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Perf

```md
#### Summary

#### Baseline

#### After

#### Measurement Method

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### UX/UI

```md
#### Summary

#### Screenshots or Video

#### Accessibility Impact

#### Tests

#### Manual Testing

### Prerequisites

-

### Steps

1.
2. **Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Infra/Build

```md
#### Summary

#### Environments Affected

#### Validation Steps

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Security

```md
#### Summary

#### Risk Summary

#### Repro Steps

#### Mitigation or Fix

#### Verification

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```
