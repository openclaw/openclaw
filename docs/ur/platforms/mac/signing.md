---
summary: "پیکیجنگ اسکرپٹس کے ذریعے تیار کردہ macOS ڈیبگ بلڈز کے لیے سائننگ کے مراحل"
read_when:
  - mac ڈیبگ بلڈز بناتے یا سائن کرتے وقت
title: "macOS سائننگ"
x-i18n:
  source_path: platforms/mac/signing.md
  source_hash: 403b92f9a0ecdb7c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:33Z
---

# mac سائننگ (ڈیبگ بلڈز)

یہ ایپ عموماً [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) سے بنائی جاتی ہے، جو اب:

- ایک مستحکم ڈیبگ بنڈل شناخت کنندہ سیٹ کرتی ہے: `ai.openclaw.mac.debug`
- اسی بنڈل شناخت کنندہ کے ساتھ Info.plist لکھتی ہے (اووررائیڈ کے لیے `BUNDLE_ID=...` استعمال کریں)
- [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) کو کال کرتی ہے تاکہ مرکزی بائنری اور ایپ بنڈل کو سائن کیا جائے، تاکہ macOS ہر ری بلڈ کو ایک ہی سائن شدہ بنڈل سمجھے اور TCC اجازتیں (نوٹیفیکیشنز، ایکسیسبلٹی، اسکرین ریکارڈنگ، مائیک، اسپیچ) برقرار رکھے۔ مستحکم اجازتوں کے لیے حقیقی سائننگ شناخت استعمال کریں؛ ad-hoc اختیاری اور نازک ہے (دیکھیں [macOS permissions](/platforms/mac/permissions)).
- بطورِ طے شدہ `CODESIGN_TIMESTAMP=auto` استعمال کرتی ہے؛ یہ Developer ID دستخطوں کے لیے قابلِ اعتماد ٹائم اسٹیمپس فعال کرتا ہے۔ ٹائم اسٹیمپنگ چھوڑنے کے لیے (آف لائن ڈیبگ بلڈز) `CODESIGN_TIMESTAMP=off` سیٹ کریں۔
- Info.plist میں بلڈ میٹاڈیٹا شامل کرتی ہے: `OpenClawBuildTimestamp` (UTC) اور `OpenClawGitCommit` (مختصر ہیش) تاکہ About پین میں بلڈ، git، اور ڈیبگ/ریلیز چینل دکھایا جا سکے۔
- **پیکیجنگ کے لیے Node 22+ درکار ہے**: اسکرپٹ TS بلڈز اور Control UI بلڈ چلاتی ہے۔
- ماحول سے `SIGN_IDENTITY` پڑھتی ہے۔ ہمیشہ اپنے سرٹیفکیٹ سے سائن کرنے کے لیے اپنے شیل rc میں `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (یا آپ کا Developer ID Application سرٹیفیکیٹ) شامل کریں۔ ad-hoc سائننگ کے لیے `ALLOW_ADHOC_SIGNING=1` یا `SIGN_IDENTITY="-"` کے ذریعے واضح opt-in درکار ہے (اجازتوں کی جانچ کے لیے سفارش نہیں کی جاتی)۔
- سائننگ کے بعد Team ID آڈٹ چلاتی ہے اور اگر ایپ بنڈل کے اندر کوئی Mach-O مختلف Team ID سے سائن ہو تو ناکام ہو جاتی ہے۔ بائی پاس کرنے کے لیے `SKIP_TEAM_ID_CHECK=1` سیٹ کریں۔

## Usage

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Ad-hoc سائننگ نوٹ

جب `SIGN_IDENTITY="-"` (ad-hoc) کے ساتھ سائن کیا جاتا ہے تو اسکرپٹ خودکار طور پر **Hardened Runtime** (`--options runtime`) کو غیرفعال کر دیتی ہے۔ یہ اس لیے ضروری ہے کہ ایپ ایمبیڈڈ فریم ورکس (جیسے Sparkle) لوڈ کرنے کی کوشش کرتے وقت کریش نہ ہو، جو ایک ہی Team ID شیئر نہیں کرتے۔ ad-hoc دستخط TCC اجازتوں کی برقراریت بھی توڑ دیتے ہیں؛ بحالی کے مراحل کے لیے [macOS permissions](/platforms/mac/permissions) دیکھیں۔

## About کے لیے بلڈ میٹاڈیٹا

`package-mac-app.sh` بنڈل پر یہ مہر لگاتا ہے:

- `OpenClawBuildTimestamp`: پیکیج وقت پر ISO8601 UTC
- `OpenClawGitCommit`: مختصر git ہیش (یا اگر دستیاب نہ ہو تو `unknown`)

About ٹیب ان کیز کو پڑھ کر ورژن، بلڈ تاریخ، git کمیٹ، اور یہ کہ آیا یہ ڈیبگ بلڈ ہے (بذریعہ `#if DEBUG`) دکھاتا ہے۔ کوڈ میں تبدیلیوں کے بعد ان قدروں کو تازہ کرنے کے لیے پیکیجر چلائیں۔

## Why

TCC اجازتیں بنڈل شناخت کنندہ _اور_ کوڈ دستخط سے منسلک ہوتی ہیں۔ بدلتے ہوئے UUIDs کے ساتھ غیر سائن شدہ ڈیبگ بلڈز کی وجہ سے macOS ہر ری بلڈ کے بعد اجازتیں بھول جاتا تھا۔ بائنریز کو سائن کرنا (بطورِ طے شدہ ad-hoc) اور ایک مقررہ بنڈل شناخت کنندہ/راستہ (`dist/OpenClaw.app`) برقرار رکھنا بلڈز کے درمیان اجازتوں کو محفوظ رکھتا ہے، جو VibeTunnel کے طریقۂ کار سے مطابقت رکھتا ہے۔
