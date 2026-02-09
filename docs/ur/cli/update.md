---
summary: "CLI حوالہ برائے `openclaw update` (محفوظ نوعیت کی سورس اپ ڈیٹ + گیٹ وے کی خودکار ری اسٹارٹ)"
read_when:
  - آپ سورس چیک آؤٹ کو محفوظ طریقے سے اپ ڈیٹ کرنا چاہتے ہیں
  - آپ کو `--update` شارٹ ہینڈ کے رویّے کو سمجھنے کی ضرورت ہے
title: "اپ ڈیٹ"
---

# `openclaw update`

OpenClaw کو محفوظ طریقے سے اپ ڈیٹ کریں اور stable/beta/dev چینلز کے درمیان سوئچ کریں۔

اگر آپ نے **npm/pnpm** کے ذریعے انسٹال کیا ہے (گلوبل انسٹال، بغیر git میٹاڈیٹا)، تو اپ ڈیٹس پیکیج مینیجر کے فلو کے ذریعے [Updating](/install/updating) میں ہوتی ہیں۔

## Usage

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Options

- `--no-restart`: کامیاب اپ ڈیٹ کے بعد Gateway سروس کو ری اسٹارٹ کرنے سے گریز کریں۔
- `--channel <stable|beta|dev>`: اپ ڈیٹ چینل سیٹ کریں (git + npm؛ کنفیگ میں محفوظ رہتا ہے)۔
- `--tag <dist-tag|version>`: صرف اسی اپ ڈیٹ کے لیے npm dist-tag یا ورژن اووررائیڈ کریں۔
- `--json`: مشین کے قابلِ مطالعہ `UpdateRunResult` JSON پرنٹ کریں۔
- `--timeout <seconds>`: ہر مرحلے کا ٹائم آؤٹ (بطورِ طے شدہ 1200s)۔

نوٹ: ڈاؤن گریڈ کے لیے تصدیق درکار ہوتی ہے کیونکہ پرانے ورژنز کنفیگریشن کو خراب کر سکتے ہیں۔

## `update status`

فعال اپ ڈیٹ چینل + git ٹیگ/برانچ/SHA (سورس چیک آؤٹس کے لیے)، نیز اپ ڈیٹ کی دستیابی دکھائیں۔

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options:

- `--json`: مشین کے قابلِ مطالعہ اسٹیٹس JSON پرنٹ کریں۔
- `--timeout <seconds>`: چیکس کے لیے ٹائم آؤٹ (بطورِ طے شدہ 3s)۔

## `update wizard`

Interactive flow to pick an update channel and confirm whether to restart the Gateway
after updating (default is to restart). If you select `dev` without a git checkout, it
offers to create one.

## What it does

جب آپ واضح طور پر چینلز سوئچ کرتے ہیں (`--channel ...`)، تو OpenClaw
انسٹال طریقہ بھی ہم آہنگ رکھتا ہے:

- `dev` → git چیک آؤٹ یقینی بناتا ہے (بطورِ طے شدہ: `~/openclaw`، `OPENCLAW_GIT_DIR` کے ساتھ اووررائیڈ کریں)،
  اسے اپ ڈیٹ کرتا ہے، اور اسی چیک آؤٹ سے گلوبل CLI انسٹال کرتا ہے۔
- `stable`/`beta` → متعلقہ dist-tag کے ساتھ npm سے انسٹال کرتا ہے۔

## Git checkout flow

Channels:

- `stable`: تازہ ترین non-beta ٹیگ چیک آؤٹ کریں، پھر build + doctor۔
- `beta`: تازہ ترین `-beta` ٹیگ چیک آؤٹ کریں، پھر build + doctor۔
- `dev`: `main` چیک آؤٹ کریں، پھر fetch + rebase۔

High-level:

1. صاف worktree درکار ہے (کوئی غیر committed تبدیلیاں نہیں)۔
2. منتخب چینل (ٹیگ یا برانچ) پر سوئچ کرتا ہے۔
3. upstream سے fetch کرتا ہے (صرف dev)۔
4. صرف dev: عارضی worktree میں preflight lint + TypeScript build؛ اگر tip ناکام ہو جائے تو تازہ ترین صاف build تلاش کرنے کے لیے 10 کمٹس تک پیچھے جاتا ہے۔
5. منتخب کمٹ پر rebase کرتا ہے (صرف dev)۔
6. deps انسٹال کرتا ہے (pnpm ترجیحی؛ npm متبادل)۔
7. build کرتا ہے + Control UI build کرتا ہے۔
8. آخری “safe update” چیک کے طور پر `openclaw doctor` چلاتا ہے۔
9. پلگ انز کو فعال چینل کے ساتھ sync کرتا ہے (dev میں bundled extensions؛ stable/beta میں npm) اور npm سے انسٹال شدہ پلگ انز اپ ڈیٹ کرتا ہے۔

## `--update` shorthand

`openclaw --update` کو `openclaw update` میں rewrite کیا جاتا ہے (شیلز اور لانچر اسکرپٹس کے لیے مفید)۔

## See also

- `openclaw doctor` (git چیک آؤٹس پر پہلے اپ ڈیٹ چلانے کی پیشکش کرتا ہے)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
