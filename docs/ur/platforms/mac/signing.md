---
summary: "پیکیجنگ اسکرپٹس کے ذریعے تیار کردہ macOS ڈیبگ بلڈز کے لیے سائننگ کے مراحل"
read_when:
  - mac ڈیبگ بلڈز بناتے یا سائن کرتے وقت
title: "macOS سائننگ"
---

# mac سائننگ (ڈیبگ بلڈز)

یہ ایپ عموماً [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) سے بنائی جاتی ہے، جو اب:

- ایک مستحکم ڈیبگ بنڈل شناخت کنندہ سیٹ کرتی ہے: `ai.openclaw.mac.debug`
- اسی بنڈل شناخت کنندہ کے ساتھ Info.plist لکھتی ہے (اووررائیڈ کے لیے `BUNDLE_ID=...` استعمال کریں)
- مین بائنری اور ایپ بنڈل کو سائن کرنے کے لیے [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) کو کال کرتا ہے تاکہ macOS ہر ری بلڈ کو ایک ہی سائن شدہ بنڈل سمجھے اور TCC اجازتیں (notifications, accessibility, screen recording, mic, speech) برقرار رکھے۔ مستحکم اجازتوں کے لیے حقیقی سائننگ شناخت استعمال کریں؛ ad-hoc آپٹ اِن ہے اور نازک ہے (دیکھیں [macOS permissions](/platforms/mac/permissions))۔
- بطورِ ڈیفالٹ `CODESIGN_TIMESTAMP=auto` استعمال کرتا ہے؛ یہ Developer ID signatures کے لیے قابلِ اعتماد timestamps فعال کرتا ہے۔ timestamping چھوڑنے کے لیے `CODESIGN_TIMESTAMP=off` سیٹ کریں (آف لائن ڈیبگ بلڈز)۔
- Info.plist میں بلڈ میٹاڈیٹا شامل کرتی ہے: `OpenClawBuildTimestamp` (UTC) اور `OpenClawGitCommit` (مختصر ہیش) تاکہ About پین میں بلڈ، git، اور ڈیبگ/ریلیز چینل دکھایا جا سکے۔
- **پیکیجنگ کے لیے Node 22+ درکار ہے**: اسکرپٹ TS بلڈز اور Control UI بلڈ چلاتی ہے۔
- ماحول (environment) سے `SIGN_IDENTITY` پڑھتا ہے۔ ہمیشہ اپنی سرٹیفکیٹ کے ساتھ سائن کرنے کے لیے اپنی شیل rc میں `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (یا آپ کا Developer ID Application cert) شامل کریں۔ Ad-hoc signing requires explicit opt-in via `ALLOW_ADHOC_SIGNING=1` or `SIGN_IDENTITY="-"` (not recommended for permission testing).
- سائننگ کے بعد Team ID آڈٹ چلاتا ہے اور اگر ایپ بنڈل کے اندر کوئی Mach-O مختلف Team ID سے سائن ہو تو فیل ہو جاتا ہے۔ بائی پاس کرنے کے لیے `SKIP_TEAM_ID_CHECK=1` سیٹ کریں۔

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

`SIGN_IDENTITY="-"` (ad-hoc) کے ساتھ سائن کرتے وقت، اسکرپٹ خود بخود **Hardened Runtime** (`--options runtime`) کو غیر فعال کر دیتا ہے۔ یہ اس لیے ضروری ہے کہ جب ایپ ایسے ایمبیڈڈ فریم ورکس (جیسے Sparkle) لوڈ کرنے کی کوشش کرے جو ایک ہی Team ID شیئر نہیں کرتے تو کریش سے بچا جا سکے۔ Ad-hoc signatures TCC اجازتوں کی مستقل مزاجی بھی توڑ دیتے ہیں؛ بحالی کے مراحل کے لیے [macOS permissions](/platforms/mac/permissions) دیکھیں۔

## About کے لیے بلڈ میٹاڈیٹا

`package-mac-app.sh` بنڈل پر یہ مہر لگاتا ہے:

- `OpenClawBuildTimestamp`: پیکیج وقت پر ISO8601 UTC
- `OpenClawGitCommit`: مختصر git ہیش (یا اگر دستیاب نہ ہو تو `unknown`)

About ٹیب ورژن، بلڈ ڈیٹ، git commit، اور یہ کہ آیا یہ ڈیبگ بلڈ ہے (via `#if DEBUG`) دکھانے کے لیے ان کیز کو پڑھتا ہے۔ Run the packager to refresh these values after code changes.

## Why

TCC اجازتیں بنڈل شناخت _اور_ کوڈ سگنیچر دونوں سے منسلک ہوتی ہیں۔ بدلتے UUIDs کے ساتھ غیر سائن شدہ ڈیبگ بلڈز macOS کو ہر ری بلڈ کے بعد دی گئی اجازتیں بھلا دینے کا سبب بن رہے تھے۔ بائنریز کو سائن کرنا (بطورِ ڈیفالٹ ad‑hoc) اور ایک مقررہ بنڈل id/پاتھ (`dist/OpenClaw.app`) برقرار رکھنا بلڈز کے درمیان اجازتیں محفوظ رکھتا ہے، جو VibeTunnel کے طریقۂ کار سے میل کھاتا ہے۔
