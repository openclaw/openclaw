---
summary: "zca-cli (QR لاگ اِن) کے ذریعے Zalo ذاتی اکاؤنٹ کی معاونت، صلاحیتیں، اور کنفیگریشن"
read_when:
  - OpenClaw کے لیے Zalo Personal سیٹ اپ کرنا
  - Zalo Personal لاگ اِن یا پیغام کے بہاؤ کی ڈیبگنگ
title: "Zalo Personal"
---

# Zalo Personal (غیر سرکاری)

حالت: تجرباتی۔ یہ انضمام `zca-cli` کے ذریعے ایک **ذاتی Zalo اکاؤنٹ** کو خودکار بناتا ہے۔

> **انتباہ:** یہ ایک غیر سرکاری انضمام ہے اور اس کے نتیجے میں اکاؤنٹ معطل یا بین ہو سکتا ہے۔ اپنے خطرے پر استعمال کریں۔

## مطلوبہ پلگ اِن

Zalo Personal ایک پلگ اِن کے طور پر فراہم کیا جاتا ہے اور بنیادی انسٹال کے ساتھ شامل نہیں ہوتا۔

- CLI کے ذریعے انسٹال کریں: `openclaw plugins install @openclaw/zalouser`
- یا سورس چیک آؤٹ سے: `openclaw plugins install ./extensions/zalouser`
- تفصیلات: [Plugins](/tools/plugin)

## پیشگی تقاضہ: zca-cli

Gateway مشین پر `zca` بائنری `PATH` میں دستیاب ہونی چاہیے۔

- تصدیق کریں: `zca --version`
- اگر موجود نہ ہو تو zca-cli انسٹال کریں (دیکھیں `extensions/zalouser/README.md` یا اپ اسٹریم zca-cli دستاویزات)۔

## فوری سیٹ اپ (مبتدی)

1. پلگ اِن انسٹال کریں (اوپر دیکھیں)۔
2. لاگ اِن کریں (QR، Gateway مشین پر):
   - `openclaw channels login --channel zalouser`
   - ٹرمینل میں دکھائے گئے QR کو Zalo موبائل ایپ سے اسکین کریں۔
3. چینل فعال کریں:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. Gateway کو ری اسٹارٹ کریں (یا آن بورڈنگ مکمل کریں)۔
5. DM رسائی بطورِ طے شدہ جوڑی بنانے پر ہوتی ہے؛ پہلی رابطہ کاری پر جوڑی بنانے کے کوڈ کی منظوری دیں۔

## یہ کیا ہے

- ان باؤنڈ پیغامات وصول کرنے کے لیے `zca listen` استعمال کرتا ہے۔
- جوابات (متن/میڈیا/لنک) بھیجنے کے لیے `zca msg ...` استعمال کرتا ہے۔
- اُن “ذاتی اکاؤنٹ” استعمالات کے لیے ڈیزائن کیا گیا ہے جہاں Zalo Bot API دستیاب نہیں۔

## نامگذاری

چینل آئی ڈی `zalouser` ہے تاکہ واضح ہو کہ یہ ایک **ذاتی Zalo صارف اکاؤنٹ** (غیر سرکاری) کو خودکار بناتا ہے۔ ہم `zalo` کو مستقبل میں ممکنہ سرکاری Zalo API انضمام کے لیے محفوظ رکھتے ہیں۔

## آئی ڈیز تلاش کرنا (ڈائریکٹری)

ہم منصبوں/گروپس اور ان کی آئی ڈیز دریافت کرنے کے لیے ڈائریکٹری CLI استعمال کریں:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## حدود

- آؤٹ باؤنڈ متن کو ~2000 حروف میں تقسیم کیا جاتا ہے (Zalo کلائنٹ کی حدود)۔
- اسٹریمنگ بطورِ طے شدہ مسدود ہے۔

## رسائی کا کنٹرول (DMs)

`channels.zalouser.dmPolicy` کی معاونت: `pairing | allowlist | open | disabled` (ڈیفالٹ: `pairing`)۔
`channels.zalouser.allowFrom` صارف آئی ڈیز یا نام قبول کرتا ہے۔ وزرڈ دستیاب ہونے پر `zca friend find` کے ذریعے ناموں کو آئی ڈیز میں حل کرتا ہے۔

منظوری دیں بذریعہ:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## گروپ رسائی (اختیاری)

- ڈیفالٹ: `channels.zalouser.groupPolicy = "open"` (گروپس کی اجازت ہے)۔ جب غیر متعین ہو تو ڈیفالٹ کو اووررائیڈ کرنے کے لیے `channels.defaults.groupPolicy` استعمال کریں۔
- اجازت فہرست کے ساتھ محدود کریں:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (کلیدیں گروپ آئی ڈیز یا نام ہیں)
- تمام گروپس بلاک کریں: `channels.zalouser.groupPolicy = "disabled"`۔
- کنفیگر وِزارڈ گروپ اجازت فہرستوں کے لیے پرامپٹ کر سکتا ہے۔
- اسٹارٹ اپ پر، OpenClaw اجازت فہرستوں میں موجود گروپ/صارف ناموں کو آئی ڈیز میں حل کرتا ہے اور میپنگ لاگ کرتا ہے؛ غیر حل شدہ اندراجات کو ویسے ہی رکھا جاتا ہے جیسے درج کیے گئے ہوں۔

مثال:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## کثیر اکاؤنٹ

اکاؤنٹس zca پروفائلز سے منسلک ہوتے ہیں۔ مثال:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## خرابیوں کا ازالہ

**`zca` نہیں ملا:**

- zca-cli انسٹال کریں اور یقینی بنائیں کہ یہ Gateway پروسیس کے لیے `PATH` پر موجود ہے۔

**لاگ اِن برقرار نہیں رہتا:**

- `openclaw channels status --probe`
- دوبارہ لاگ اِن کریں: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
