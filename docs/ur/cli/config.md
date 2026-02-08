---
summary: "CLI حوالہ برائے `openclaw config` (کنفیگ ویلیوز حاصل کریں/سیٹ کریں/ان سیٹ کریں)"
read_when:
  - آپ کنفیگ کو غیر تعاملی طور پر پڑھنا یا ترمیم کرنا چاہتے ہیں
title: "config"
x-i18n:
  source_path: cli/config.md
  source_hash: d60a35f5330f22bc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:54Z
---

# `openclaw config`

کنفیگ مددگار: راستے کے ذریعے ویلیوز حاصل کریں/سیٹ کریں/ان سیٹ کریں۔ ذیلی کمانڈ کے بغیر چلانے پر
کنفیگریشن وزارڈ کھلتا ہے (بالکل `openclaw configure` کی طرح)۔

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

جہاں ممکن ہو ویلیوز کو JSON5 کے طور پر پارس کیا جاتا ہے؛ بصورتِ دیگر انہیں اسٹرنگ سمجھا جاتا ہے۔
JSON5 پارسنگ لازم کرنے کے لیے `--json` استعمال کریں۔

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

ترمیمات کے بعد gateway (گیٹ وے) کو دوبارہ شروع کریں۔
