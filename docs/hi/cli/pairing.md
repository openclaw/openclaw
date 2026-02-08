---
summary: "CLI संदर्भ `openclaw pairing` के लिए (पेयरिंग अनुरोधों को स्वीकृत/सूचीबद्ध करना)"
read_when:
  - आप पेयरिंग-मोड डीएम का उपयोग कर रहे हैं और प्रेषकों को स्वीकृत करने की आवश्यकता है
title: "पेयरिंग"
x-i18n:
  source_path: cli/pairing.md
  source_hash: 785869d24d953141
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:02Z
---

# `openclaw pairing`

डीएम पेयरिंग अनुरोधों को स्वीकृत करें या उनका निरीक्षण करें (उन चैनलों के लिए जो पेयरिंग का समर्थन करते हैं)।

संबंधित:

- पेयरिंग प्रवाह: [पेयरिंग](/channels/pairing)

## कमांड्स

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <code> --notify
```
