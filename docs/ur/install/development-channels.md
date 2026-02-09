---
summary: "اسٹیبل، بیٹا، اور ڈیو چینلز: معنیات، سوئچنگ، اور ٹیگنگ"
read_when:
  - آپ اسٹیبل/بیٹا/ڈیو کے درمیان سوئچ کرنا چاہتے ہیں
  - آپ پری ریلیزز کو ٹیگ یا شائع کر رہے ہیں
title: "Development Channels"
---

# Development channels

آخری تازہ کاری: 2026-01-21

OpenClaw تین اپڈیٹ چینلز فراہم کرتا ہے:

- **stable**: npm dist-tag `latest`۔
- **beta**: npm dist-tag `beta` (زیرِ آزمائش بلڈز)۔
- **dev**: moving head of `main` (git). npm dist-tag: `dev` (when published).

ہم بلڈز کو **beta** پر بھیجتے ہیں، ان کی جانچ کرتے ہیں، پھر **جانچ شدہ بلڈ کو `latest` پر ترقی دیتے ہیں**
بغیر ورژن نمبر بدلے — npm انسٹالز کے لیے dist-tags ہی واحد ماخذِ حقیقت ہیں۔

## Switching channels

Git checkout:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` تازہ ترین مطابقت رکھنے والے ٹیگ پر checkout کرتے ہیں (اکثر ایک ہی ٹیگ)۔
- `dev` `main` پر سوئچ کرتا ہے اور اپ اسٹریم پر rebase کرتا ہے۔

npm/pnpm گلوبل انسٹال:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

یہ متعلقہ npm dist-tag (`latest`، `beta`، `dev`) کے ذریعے اپڈیٹ ہوتا ہے۔

جب آپ `--channel` کے ساتھ **واضح طور پر** چینلز سوئچ کرتے ہیں، تو OpenClaw
انسٹال طریقہ بھی ہم آہنگ کر دیتا ہے:

- `dev` ایک git checkout کو یقینی بناتا ہے (بطورِ طے شدہ `~/openclaw`، `OPENCLAW_GIT_DIR` کے ساتھ اووررائیڈ کریں)،
  اسے اپڈیٹ کرتا ہے، اور اسی checkout سے گلوبل CLI انسٹال کرتا ہے۔
- `stable`/`beta` مماثل dist-tag کے ساتھ npm سے انسٹال کرتا ہے۔

مشورہ: اگر آپ متوازی طور پر stable + dev چاہتے ہیں، تو دو کلونز رکھیں اور اپنے Gateway کو stable والے کی طرف پوائنٹ کریں۔

## Plugins and channels

جب آپ `openclaw update` کے ساتھ چینلز سوئچ کرتے ہیں، تو OpenClaw پلگ اِن ذرائع کو بھی ہم آہنگ کرتا ہے:

- `dev` git checkout سے بنڈلڈ پلگ اِنز کو ترجیح دیتا ہے۔
- `stable` اور `beta` npm سے انسٹال شدہ پلگ اِن پیکجز کو بحال کرتے ہیں۔

## Tagging best practices

- وہ ریلیزز ٹیگ کریں جن پر آپ چاہتے ہیں کہ git checkouts اتریں (`vYYYY.M.D` یا `vYYYY.M.D-<patch>`)۔
- ٹیگز کو ناقابلِ تغیر رکھیں: کبھی بھی کسی ٹیگ کو نہ ہلائیں اور نہ دوبارہ استعمال کریں۔
- npm dist-tags npm انسٹالز کے لیے واحد ماخذِ حقیقت رہتے ہیں:
  - `latest` → stable
  - `beta` → امیدوار بلڈ
  - `dev` → مین اسنیپ شاٹ (اختیاری)

## macOS app availability

Beta and dev builds may **not** include a macOS app release. That’s OK:

- git ٹیگ اور npm dist-tag پھر بھی شائع کیے جا سکتے ہیں۔
- ریلیز نوٹس یا چینج لاگ میں “اس بیٹا کے لیے macOS بلڈ نہیں” کی وضاحت کریں۔
