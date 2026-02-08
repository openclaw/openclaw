---
summary: "CLI حوالہ برائے `openclaw devices` (ڈیوائس جوڑی بنانا + ٹوکن کی گردش/منسوخی)"
read_when:
  - آپ ڈیوائس جوڑی بنانے کی درخواستوں کی منظوری دے رہے ہوں
  - آپ کو ڈیوائس ٹوکنز کی گردش یا منسوخی درکار ہو
title: "ڈیوائسز"
x-i18n:
  source_path: cli/devices.md
  source_hash: ac7d130ecdc5d429
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:58Z
---

# `openclaw devices`

ڈیوائس جوڑی بنانے کی درخواستوں اور ڈیوائس-محدود ٹوکنز کا انتظام کریں۔

## Commands

### `openclaw devices list`

زیرِ التواء جوڑی بنانے کی درخواستیں اور جوڑی شدہ ڈیوائسز کی فہرست دکھائیں۔

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

زیرِ التواء ڈیوائس جوڑی بنانے کی درخواست منظور کریں۔

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

زیرِ التواء ڈیوائس جوڑی بنانے کی درخواست مسترد کریں۔

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

کسی مخصوص کردار کے لیے ڈیوائس ٹوکن کی گردش کریں (اختیاری طور پر اسکوپس اپ ڈیٹ کرتے ہوئے)۔

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

کسی مخصوص کردار کے لیے ڈیوائس ٹوکن منسوخ کریں۔

```
openclaw devices revoke --device <deviceId> --role node
```

## Common options

- `--url <url>`: Gateway WebSocket URL (کنفیگ ہونے پر بطورِ طے شدہ `gateway.remote.url`)۔
- `--token <token>`: Gateway ٹوکن (اگر درکار ہو)۔
- `--password <password>`: Gateway پاس ورڈ (پاس ورڈ تصدیق)۔
- `--timeout <ms>`: RPC ٹائم آؤٹ۔
- `--json`: JSON آؤٹ پٹ (اسکرپٹنگ کے لیے سفارش کردہ)۔

نوٹ: جب آپ `--url` سیٹ کرتے ہیں، تو CLI کنفیگ یا ماحولیاتی اسناد پر واپس نہیں جاتا۔
`--token` یا `--password` واضح طور پر فراہم کریں۔ واضح اسناد کی عدم موجودگی ایک غلطی ہے۔

## Notes

- ٹوکن کی گردش ایک نیا ٹوکن واپس کرتی ہے (حساس)۔ اسے راز کی طرح برتیں۔
- ان کمانڈز کے لیے `operator.pairing` (یا `operator.admin`) اسکوپ درکار ہے۔
