---
summary: "CLI حوالہ برائے `openclaw node` (ہیڈ لیس نوڈ ہوسٹ)"
read_when:
  - ہیڈ لیس نوڈ ہوسٹ چلانا
  - system.run کے لیے غیر macOS نوڈ کی جوڑی بنانا
title: "نوڈ"
x-i18n:
  source_path: cli/node.md
  source_hash: a8b1a57712663e22
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:07Z
---

# `openclaw node`

ایک **ہیڈ لیس نوڈ ہوسٹ** چلائیں جو Gateway WebSocket سے جڑتا ہے اور
اس مشین پر `system.run` / `system.which` کو ایکسپوز کرتا ہے۔

## نوڈ ہوسٹ کیوں استعمال کریں؟

جب آپ چاہتے ہیں کہ ایجنٹس آپ کے نیٹ ورک میں **دوسری مشینوں پر کمانڈز چلائیں**
اور وہاں مکمل macOS معاون ایپ انسٹال نہ کرنی پڑے، تو نوڈ ہوسٹ استعمال کریں۔

عام استعمال کے کیسز:

- ریموٹ Linux/Windows باکسز (بلڈ سرورز، لیب مشینیں، NAS) پر کمانڈز چلانا۔
- گیٹ وے پر exec کو **sandboxed** رکھنا، لیکن منظور شدہ رنز کو دیگر ہوسٹس پر تفویض کرنا۔
- آٹومیشن یا CI نوڈز کے لیے ایک ہلکا، ہیڈ لیس ایگزیکیوشن ہدف فراہم کرنا۔

ایگزیکیوشن اب بھی **exec approvals** اور نوڈ ہوسٹ پر ہر ایجنٹ کی اجازت فہرستوں کے ذریعے محفوظ رہتی ہے، لہٰذا آپ کمانڈ تک رسائی کو محدود اور واضح رکھ سکتے ہیں۔

## براؤزر پراکسی (زیرو کنفیگ)

نوڈ ہوسٹس خودکار طور پر ایک براؤزر پراکسی کا اعلان کرتے ہیں اگر نوڈ پر `browser.enabled` غیر فعال نہ ہو۔
اس سے ایجنٹ اضافی کنفیگریشن کے بغیر اس نوڈ پر براؤزر آٹومیشن استعمال کر سکتا ہے۔

ضرورت ہو تو نوڈ پر اسے غیر فعال کریں:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## چلائیں (فارگراؤنڈ)

```bash
openclaw node run --host <gateway-host> --port 18789
```

اختیارات:

- `--host <host>`: Gateway WebSocket ہوسٹ (بطورِ طے شدہ: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket پورٹ (بطورِ طے شدہ: `18789`)
- `--tls`: گیٹ وے کنکشن کے لیے TLS استعمال کریں
- `--tls-fingerprint <sha256>`: متوقع TLS سرٹیفکیٹ فنگرپرنٹ (sha256)
- `--node-id <id>`: نوڈ آئی ڈی اووررائیڈ کریں (جوڑی بنانے کا ٹوکن صاف ہو جاتا ہے)
- `--display-name <name>`: نوڈ ڈسپلے نام اووررائیڈ کریں

## سروس (بیک گراؤنڈ)

ایک ہیڈ لیس نوڈ ہوسٹ کو یوزر سروس کے طور پر انسٹال کریں۔

```bash
openclaw node install --host <gateway-host> --port 18789
```

اختیارات:

- `--host <host>`: Gateway WebSocket ہوسٹ (بطورِ طے شدہ: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket پورٹ (بطورِ طے شدہ: `18789`)
- `--tls`: گیٹ وے کنکشن کے لیے TLS استعمال کریں
- `--tls-fingerprint <sha256>`: متوقع TLS سرٹیفکیٹ فنگرپرنٹ (sha256)
- `--node-id <id>`: نوڈ آئی ڈی اووررائیڈ کریں (جوڑی بنانے کا ٹوکن صاف ہو جاتا ہے)
- `--display-name <name>`: نوڈ ڈسپلے نام اووررائیڈ کریں
- `--runtime <runtime>`: سروس رن ٹائم (`node` یا `bun`)
- `--force`: اگر پہلے سے انسٹال ہو تو دوبارہ انسٹال/اووررائٹ کریں

سروس کو منظم کریں:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

فارگراؤنڈ نوڈ ہوسٹ (بغیر سروس) کے لیے `openclaw node run` استعمال کریں۔

سروس کمانڈز مشین کے لیے قابلِ مطالعہ آؤٹ پٹ کے لیے `--json` قبول کرتی ہیں۔

## جوڑی بنانا

پہلا کنکشن Gateway پر ایک زیرِ التواء نوڈ جوڑی درخواست بناتا ہے۔
اسے درج ذیل کے ذریعے منظور کریں:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

نوڈ ہوسٹ اپنا نوڈ آئی ڈی، ٹوکن، ڈسپلے نام، اور گیٹ وے کنکشن کی معلومات
`~/.openclaw/node.json` میں محفوظ کرتا ہے۔

## Exec approvals

`system.run` مقامی ایگزیک منظوریات کے ذریعے محدود ہے:

- `~/.openclaw/exec-approvals.json`
- [Exec approvals](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (Gateway سے ترمیم کریں)
