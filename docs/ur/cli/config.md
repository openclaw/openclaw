---
summary: "CLI حوالہ برائے `openclaw config` (کنفیگ ویلیوز حاصل کریں/سیٹ کریں/ان سیٹ کریں)"
read_when:
  - آپ کنفیگ کو غیر تعاملی طور پر پڑھنا یا ترمیم کرنا چاہتے ہیں
title: "config"
---

# `openclaw config`

کنفیگ مددگار: راستے کے ذریعے ویلیوز حاصل/سیٹ/ان سیٹ کریں۔ سب کمانڈ کے بغیر چلائیں تاکہ کنفیگر وزرڈ کھلے
(وہی جو `openclaw configure`)۔

## مثالیں

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## راستے

راستے ڈاٹ یا بریکٹ نوٹیشن استعمال کرتے ہیں:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

کسی مخصوص ایجنٹ کو ہدف بنانے کے لیے ایجنٹ فہرست کے انڈیکس کا استعمال کریں:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## ویلیوز

قدریں جہاں ممکن ہو JSON5 کے طور پر پارس کی جاتی ہیں؛ بصورت دیگر انہیں اسٹرنگز سمجھا جاتا ہے۔
Use `--json` to require JSON5 parsing.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

ترمیمات کے بعد gateway (گیٹ وے) کو دوبارہ شروع کریں۔
