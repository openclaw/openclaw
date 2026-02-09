---
summary: "ایک ہی ہوسٹ پر متعدد OpenClaw Gateways چلائیں (آئسولیشن، پورٹس، اور پروفائلز)"
read_when:
  - ایک ہی مشین پر ایک سے زیادہ Gateway چلانا ہو
  - ہر Gateway کے لیے الگ کنفیگ/اسٹیٹ/پورٹس درکار ہوں
title: "متعدد Gateways"
---

# متعدد Gateways (ایک ہی ہوسٹ)

36. زیادہ تر سیٹ اپس کو ایک ہی گیٹ وے استعمال کرنا چاہیے کیونکہ ایک گیٹ وے متعدد میسجنگ کنکشنز اور ایجنٹس کو سنبھال سکتا ہے۔ 37. اگر آپ کو زیادہ مضبوط آئسولیشن یا ریڈنڈنسی درکار ہو (مثلاً ایک ریسکیو بوٹ)، تو آئسولیٹڈ پروفائلز/پورٹس کے ساتھ الگ گیٹ ویز چلائیں۔

## آئسولیشن چیک لسٹ (لازم)

- `OPENCLAW_CONFIG_PATH` — ہر انسٹینس کے لیے الگ کنفیگ فائل
- `OPENCLAW_STATE_DIR` — ہر انسٹینس کے لیے الگ سیشنز، کریڈینشلز، کیشز
- `agents.defaults.workspace` — ہر انسٹینس کے لیے الگ ورک اسپیس روٹ
- `gateway.port` (یا `--port`) — ہر انسٹینس کے لیے منفرد
- ماخوذ پورٹس (browser/canvas) آپس میں اوورلیپ نہیں ہونے چاہئیں

اگر یہ چیزیں شیئر ہوں تو آپ کو کنفیگ ریسز اور پورٹ کانفلکٹس کا سامنا ہوگا۔

## سفارش کردہ: پروفائلز (`--profile`)

پروفائلز خودکار طور پر `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` کو اسکوپ کرتے ہیں اور سروس ناموں کے آخر میں لاحقہ لگاتے ہیں۔

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

فی-پروفائل سروسز:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## ریسکیو بوٹ گائیڈ

اسی ہوسٹ پر دوسرا Gateway چلائیں جس کے اپنے ہوں:

- پروفائل/کنفیگ
- اسٹیٹ ڈائریکٹری
- ورک اسپیس
- بیس پورٹ (اور اس سے ماخوذ پورٹس)

یہ ریسکیو بوٹ کو مین بوٹ سے الگ رکھتا ہے تاکہ اگر پرائمری بوٹ ڈاؤن ہو تو یہ ڈیبگ کر سکے یا کنفیگ تبدیلیاں لاگو کر سکے۔

پورٹ اسپیسنگ: بیس پورٹس کے درمیان کم از کم 20 پورٹس کا فاصلہ رکھیں تاکہ ماخوذ browser/canvas/CDP پورٹس کبھی ٹکرائیں نہیں۔

### انسٹال کیسے کریں (ریسکیو بوٹ)

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## پورٹ میپنگ (ماخوذ)

بیس پورٹ = `gateway.port` (یا `OPENCLAW_GATEWAY_PORT` / `--port`)۔

- براؤزر کنٹرول سروس پورٹ = بیس + 2 (صرف loopback)
- `canvasHost.port = base + 4`
- 38. براؤزر پروفائل CDP پورٹس خودکار طور پر `browser.controlPort + 9 ..` سے الاٹ ہوتے ہیں 39. `+ 108`

اگر آپ کنفیگ یا env میں ان میں سے کسی کو اووررائیڈ کریں، تو ہر انسٹینس کے لیے انہیں منفرد رکھنا لازم ہے۔

## براؤزر/CDP نوٹس (عام غلطی)

- متعدد انسٹینسز پر `browser.cdpUrl` کو ایک ہی ویلیوز پر **فکس نہ کریں**۔
- ہر انسٹینس کو اپنا براؤزر کنٹرول پورٹ اور CDP رینج درکار ہوتی ہے (جو اس کے gateway پورٹ سے ماخوذ ہوتی ہے)۔
- 40. اگر آپ کو واضح CDP پورٹس درکار ہوں، تو `browser.profiles.<name>` سیٹ کریں41. `.cdpPort` فی انسٹینس۔
- 42. ریموٹ کروم: `browser.profiles.<name>` استعمال کریں43. `.cdpUrl` (فی پروفائل، فی انسٹینس)۔

## دستی env مثال

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## فوری جانچ

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
