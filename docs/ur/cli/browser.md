---
summary: "`openclaw browser` کے لیے CLI حوالہ (پروفائلز، ٹیبز، ایکشنز، ایکسٹینشن ریلے)"
read_when:
  - آپ `openclaw browser` استعمال کرتے ہیں اور عام کاموں کے لیے مثالیں چاہتے ہیں
  - آپ کسی دوسرے مشین پر چلنے والے براؤزر کو node host کے ذریعے کنٹرول کرنا چاہتے ہیں
  - آپ Chrome ایکسٹینشن ریلے استعمال کرنا چاہتے ہیں (ٹول بار بٹن کے ذریعے attach/detach)
title: "browser"
---

# `openclaw browser`

OpenClaw کے براؤزر کنٹرول سرور کا نظم کریں اور براؤزر ایکشنز چلائیں (ٹیبز، اسنیپ شاٹس، اسکرین شاٹس، نیویگیشن، کلکس، ٹائپنگ)۔

متعلقہ:

- Browser tool + API: [Browser tool](/tools/browser)
- Chrome extension relay: [Chrome extension](/tools/chrome-extension)

## Common flags

- `--url <gatewayWsUrl>`: Gateway WebSocket URL (بطورِ طے شدہ کنفیگ سے)۔
- `--token <token>`: Gateway ٹوکن (اگر درکار ہو)۔
- `--timeout <ms>`: درخواست کا ٹائم آؤٹ (ms)۔
- `--browser-profile <name>`: براؤزر پروفائل منتخب کریں (بطورِ طے شدہ کنفیگ سے)۔
- `--json`: مشین کے قابلِ مطالعہ آؤٹ پٹ (جہاں معاونت موجود ہو)۔

## Quick start (local)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Profiles

پروفائلز براؤزر روٹنگ کنفیگز کے نام ہوتے ہیں۔ عملی طور پر:

- `openclaw`: ایک مخصوص OpenClaw کے زیرِ انتظام Chrome انسٹینس لانچ/اٹیچ کرتا ہے (الگ تھلگ user data dir)۔
- `chrome`: Chrome ایکسٹینشن ریلے کے ذریعے آپ کے موجودہ Chrome ٹیب(ز) کو کنٹرول کرتا ہے۔

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

ایک مخصوص پروفائل استعمال کریں:

```bash
openclaw browser --browser-profile work tabs
```

## Tabs

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Snapshot / screenshot / actions

Snapshot:

```bash
openclaw browser snapshot
```

Screenshot:

```bash
openclaw browser screenshot
```

Navigate/click/type (ref-based UI automation):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome extension relay (attach via toolbar button)

یہ موڈ ایجنٹ کو ایک موجودہ Chrome ٹیب کنٹرول کرنے دیتا ہے جسے آپ دستی طور پر attach کرتے ہیں (یہ خودکار طور پر attach نہیں ہوتا)۔

Unpacked ایکسٹینشن کو ایک مستحکم راستے پر انسٹال کریں:

```bash
openclaw browser extension install
openclaw browser extension path
```

پھر Chrome → `chrome://extensions` → “Developer mode” فعال کریں → “Load unpacked” → پرنٹ کیے گئے فولڈر کو منتخب کریں۔

مکمل رہنمائی: [Chrome extension](/tools/chrome-extension)

## Remote browser control (node host proxy)

اگر گیٹ وے براؤزر سے مختلف مشین پر چل رہا ہو تو اس مشین پر **نوڈ ہوسٹ** چلائیں جس پر Chrome/Brave/Edge/Chromium موجود ہو۔ گیٹ وے براؤزر ایکشنز کو اس نوڈ کی طرف پراکسی کرے گا (الگ براؤزر کنٹرول سرور کی ضرورت نہیں)۔

آٹو روٹنگ کو کنٹرول کرنے کے لیے `gateway.nodes.browser.mode` استعمال کریں اور اگر متعدد nodes منسلک ہوں تو کسی مخصوص node کو پن کرنے کے لیے `gateway.nodes.browser.node` استعمال کریں۔

سکیورٹی + ریموٹ سیٹ اپ: [Browser tool](/tools/browser)، [Remote access](/gateway/remote)، [Tailscale](/gateway/tailscale)، [Security](/gateway/security)
