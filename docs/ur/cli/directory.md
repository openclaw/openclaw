---
summary: "`openclaw directory` کے لیے CLI حوالہ (خود، ہم منصب، گروپس)"
read_when:
  - جب آپ کسی چینل کے لیے رابطہ/گروپس/خود کی آئی ڈیز دیکھنا چاہتے ہوں
  - جب آپ چینل ڈائریکٹری اڈاپٹر تیار کر رہے ہوں
title: "ڈائریکٹری"
---

# `openclaw directory`

ان چینلز کے لیے ڈائریکٹری تلاشیں جو اسے سپورٹ کرتے ہیں (رابطے/ہم منصب، گروپس، اور “میں”).

## Common flags

- `--channel <name>`: چینل آئی ڈی/عرف (جب متعدد چینلز کنفیگر ہوں تو لازم؛ جب صرف ایک کنفیگر ہو تو خودکار)
- `--account <id>`: اکاؤنٹ آئی ڈی (بطورِ طے شدہ: چینل ڈیفالٹ)
- `--json`: آؤٹ پٹ JSON

## Notes

- `directory` کا مقصد آپ کو ایسی آئی ڈیز تلاش کرنے میں مدد دینا ہے جنہیں آپ دوسرے کمانڈز میں پیسٹ کر سکیں (خصوصاً `openclaw message send --target ...`).
- بہت سے چینلز کے لیے نتائج لائیو فراہم کنندہ ڈائریکٹری کے بجائے کنفیگ پر مبنی ہوتے ہیں (اجازت فہرستیں / کنفیگر شدہ گروپس).
- ڈیفالٹ آؤٹ پٹ `id` (اور کبھی کبھار `name`) ہوتا ہے جو ٹیب سے جدا ہوتا ہے؛ اسکرپٹنگ کے لیے `--json` استعمال کریں۔

## Using results with `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID formats (by channel)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (group)
- Telegram: `@username` یا عددی چیٹ آئی ڈی؛ گروپس عددی آئی ڈیز ہوتے ہیں
- Slack: `user:U…` اور `channel:C…`
- Discord: `user:<id>` اور `channel:<id>`
- Matrix (plugin): `user:@user:server`, `room:!roomId:server`, یا `#alias:server`
- Microsoft Teams (plugin): `user:<id>` اور `conversation:<id>`
- Zalo (plugin): صارف آئی ڈی (Bot API)
- Zalo Personal / `zalouser` (plugin): تھریڈ آئی ڈی (DM/گروپ) از `zca` (`me`, `friend list`, `group list`)

## Self (“me”)

```bash
openclaw directory self --channel zalouser
```

## Peers (contacts/users)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Groups

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
