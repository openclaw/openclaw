---
summary: "NIP-04 خفیہ پیغامات کے ذریعے Nostr DM چینل"
read_when:
  - آپ چاہتے ہیں کہ OpenClaw کو Nostr کے ذریعے DMs موصول ہوں
  - آپ غیر مرکزی پیغام رسانی سیٹ اپ کر رہے ہیں
title: "Nostr"
---

# Nostr

**اسٹیٹس:** اختیاری پلگ اِن (بطورِ طے شدہ غیرفعال)۔

Nostr is a decentralized protocol for social networking. This channel enables OpenClaw to receive and respond to encrypted direct messages (DMs) via NIP-04.

## Install (on demand)

### Onboarding (سفارش کردہ)

- آن بورڈنگ وزارڈ (`openclaw onboard`) اور `openclaw channels add` اختیاری چینل پلگ اِنز کی فہرست دکھاتے ہیں۔
- Nostr منتخب کرنے پر پلگ اِن کو حسبِ ضرورت انسٹال کرنے کا اشارہ ملتا ہے۔

ڈیفالٹ انسٹال طریقے:

- **Dev چینل + git checkout دستیاب:** لوکل پلگ اِن پاتھ استعمال کرتا ہے۔
- **Stable/Beta:** npm سے ڈاؤن لوڈ کرتا ہے۔

آپ پرامپٹ میں ہمیشہ اس انتخاب کو اووررائیڈ کر سکتے ہیں۔

### Manual install

```bash
openclaw plugins install @openclaw/nostr
```

لوکل checkout استعمال کریں (dev ورک فلو):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

پلگ اِنز انسٹال یا فعال کرنے کے بعد Gateway کو ری اسٹارٹ کریں۔

## Quick setup

1. Nostr کی پیئر (keypair) بنائیں (اگر درکار ہو):

```bash
# Using nak
nak key generate
```

2. کنفیگ میں شامل کریں:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. کلید ایکسپورٹ کریں:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Gateway کو ری اسٹارٹ کریں۔

## Configuration reference

| Key          | Type                                                         | Default                                     | Description                              |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------- |
| `privateKey` | string                                                       | required                                    | نجی کلید `nsec` یا hex فارمیٹ میں        |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | ریلے URLs (WebSocket) |
| `dmPolicy`   | string                                                       | `pairing`                                   | DM رسائی پالیسی                          |
| `allowFrom`  | string[] | `[]`                                        | مجاز ارسال کنندگان کے pubkeys            |
| `enabled`    | boolean                                                      | `true`                                      | چینل فعال/غیرفعال کریں                   |
| `name`       | string                                                       | -                                           | ڈسپلے نام                                |
| `profile`    | object                                                       | -                                           | NIP-01 پروفائل میٹا ڈیٹا                 |

## Profile metadata

Profile data is published as a NIP-01 `kind:0` event. You can manage it from the Control UI (Channels -> Nostr -> Profile) or set it directly in config.

مثال:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

نوٹس:

- پروفائل URLs میں `https://` استعمال ہونا لازم ہے۔
- ریلے سے امپورٹ کرنے پر فیلڈز ضم ہو جاتی ہیں اور لوکل اووررائیڈز برقرار رہتے ہیں۔

## Access control

### DM پالیسیز

- **pairing** (ڈیفالٹ): نامعلوم ارسال کنندگان کو pairing کوڈ ملتا ہے۔
- **allowlist**: صرف `allowFrom` میں موجود pubkeys DM بھیج سکتے ہیں۔
- **open**: عوامی inbound DMs (درکار: `allowFrom: ["*"]`)۔
- **disabled**: inbound DMs کو نظرانداز کریں۔

### Allowlist مثال

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## Key formats

قابلِ قبول فارمیٹس:

- **نجی کلید:** `nsec...` یا 64-حرفی hex
- **Pubkeys (`allowFrom`):** `npub...` یا hex

## Relays

ڈیفالٹس: `relay.damus.io` اور `nos.lol`۔

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

مشورے:

- اضافی تحفظ کے لیے 2-3 ریلے استعمال کریں۔
- بہت زیادہ ریلے سے پرہیز کریں (تاخیر، تکرار)۔
- ادا شدہ ریلے قابلِ اعتماد ی بڑھا سکتے ہیں۔
- جانچ کے لیے لوکل ریلے مناسب ہیں (`ws://localhost:7777`)۔

## Protocol support

| NIP    | Status    | Description                             |
| ------ | --------- | --------------------------------------- |
| NIP-01 | Supported | بنیادی ایونٹ فارمیٹ + پروفائل میٹا ڈیٹا |
| NIP-04 | Supported | خفیہ DMs (`kind:4`)  |
| NIP-17 | Planned   | گفٹ-ریپڈ DMs                            |
| NIP-44 | Planned   | ورژن شدہ خفیہ کاری                      |

## Testing

### Local relay

```bash
# Start strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### Manual test

1. لاگز سے بوٹ pubkey (npub) نوٹ کریں۔
2. Nostr کلائنٹ کھولیں (Damus، Amethyst وغیرہ)۔
3. بوٹ pubkey کو DM بھیجیں۔
4. جواب کی تصدیق کریں۔

## Troubleshooting

### پیغامات موصول نہیں ہو رہے

- تصدیق کریں کہ نجی کلید درست ہے۔
- یقینی بنائیں کہ ریلے URLs قابلِ رسائی ہیں اور `wss://` استعمال کرتے ہیں (یا لوکل کے لیے `ws://`)۔
- تصدیق کریں کہ `enabled`، `false` نہیں ہے۔
- ریلے کنکشن کی غلطیوں کے لیے Gateway لاگز چیک کریں۔

### جوابات نہیں بھیجے جا رہے

- چیک کریں کہ ریلے لکھائی قبول کرتا ہے۔
- آؤٹ باؤنڈ کنیکٹیوٹی کی تصدیق کریں۔
- ریلے کی ریٹ لمٹس پر نظر رکھیں۔

### ڈپلیکیٹ جوابات

- متعدد ریلے استعمال کرنے پر متوقع ہے۔
- پیغامات ایونٹ ID کے ذریعے ڈی ڈپلیکیٹ ہوتے ہیں؛ صرف پہلی ڈیلیوری پر ہی جواب ٹرگر ہوتا ہے۔

## Security

- نجی کلیدیں کبھی commit نہ کریں۔
- کلیدوں کے لیے ماحولیاتی متغیرات استعمال کریں۔
- پروڈکشن بوٹس کے لیے `allowlist` پر غور کریں۔

## Limitations (MVP)

- صرف براہِ راست پیغامات (گروپ چیٹس نہیں)۔
- میڈیا اٹیچمنٹس نہیں۔
- صرف NIP-04 (NIP-17 گفٹ-ریپ منصوبہ بند ہے)۔
