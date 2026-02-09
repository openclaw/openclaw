---
summary: Node + tsx میں "__name is not a function" کریش کے نوٹس اور عارضی حل
read_when:
  - صرف Node پر مبنی ڈویلپمنٹ اسکرپٹس یا واچ موڈ کی ناکامیوں کی ڈی بگنگ
  - OpenClaw میں tsx/esbuild لوڈر کریشز کی تفتیش
title: "Node + tsx کریش"
---

# Node + tsx "\_\_name is not a function" کریش

## خلاصہ

Node کے ذریعے OpenClaw چلانے پر `tsx` کے ساتھ آغاز کے وقت ناکامی ہوتی ہے اور درج ذیل ظاہر ہوتا ہے:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

یہ Bun سے `tsx` پر dev اسکرپٹس سوئچ کرنے کے بعد شروع ہوا (commit `2871657e`, 2026-01-06)۔ وہی رن ٹائم پاتھ Bun کے ساتھ کام کر رہا تھا۔

## ماحول

- Node: v25.x (v25.3.0 پر مشاہدہ)
- tsx: 4.21.0
- OS: macOS (ممکنہ طور پر دیگر پلیٹ فارمز پر بھی جن پر Node 25 چلتا ہے)

## Repro (صرف Node)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## ریپو میں کم از کم repro

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node ورژن چیک

- Node 25.3.0: ناکام
- Node 22.22.0 (Homebrew `node@22`): ناکام
- Node 24: یہاں ابھی انسٹال نہیں؛ تصدیق درکار

## نوٹس / مفروضہ

- `tsx` TS/ESM کو ٹرانسفارم کرنے کے لیے esbuild استعمال کرتا ہے۔ esbuild کا `keepNames` ایک `__name` ہیلپر ایمٹ کرتا ہے اور فنکشن ڈیفینیشنز کو `__name(...)` کے ساتھ ریپ کرتا ہے۔
- کریش اس بات کی نشاندہی کرتا ہے کہ `__name` موجود ہے مگر رن ٹائم پر فنکشن نہیں، جس سے ظاہر ہوتا ہے کہ Node 25 کے لوڈر راستے میں اس ماڈیول کے لیے ہیلپر غائب ہے یا اوور رائٹ ہو گیا ہے۔
- اسی نوعیت کے `__name` ہیلپر مسائل دیگر esbuild صارفین میں بھی رپورٹ ہوئے ہیں جب ہیلپر غائب ہو یا دوبارہ لکھ دیا جائے۔

## رجریشن ہسٹری

- `2871657e` (2026-01-06): Bun کو اختیاری بنانے کے لیے اسکرپٹس Bun سے tsx پر تبدیل کی گئیں۔
- اس سے پہلے (Bun راستہ)، `openclaw status` اور `gateway:watch` کام کر رہے تھے۔

## عارضی حل

- ڈویلپمنٹ اسکرپٹس کے لیے Bun استعمال کریں (موجودہ عارضی واپسی)۔

- Node + tsc واچ استعمال کریں، پھر کمپائل شدہ آؤٹ پٹ چلائیں:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- مقامی طور پر تصدیق شدہ: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` Node 25 پر کام کرتا ہے۔

- اگر ممکن ہو تو TS لوڈر میں esbuild keepNames کو غیر فعال کریں (اس سے `__name` ہیلپر کی شمولیت رکتی ہے)؛ tsx فی الحال یہ اختیار فراہم نہیں کرتا۔

- Node LTS (22/24) کو `tsx` کے ساتھ آزمائیں تاکہ دیکھا جا سکے کہ آیا مسئلہ مخصوص طور پر Node 25 کا ہے۔

## مراجع

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## اگلے اقدامات

- Node 22/24 پر repro کر کے Node 25 کی رجریشن کی تصدیق کریں۔
- `tsx` نائٹلی آزمائیں یا اگر کوئی معلوم رجریشن موجود ہو تو پہلے کے ورژن پر پن کریں۔
- اگر Node LTS پر بھی مسئلہ دہرایا جائے تو `__name` اسٹیک ٹریس کے ساتھ اپ اسٹریم کم از کم repro فائل کریں۔
