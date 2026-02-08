---
summary: "Zalo Personal प्लगइन: zca-cli के माध्यम से QR लॉगिन + मैसेजिंग (प्लगइन इंस्टॉल + चैनल विन्यास + CLI + टूल)"
read_when:
  - आप OpenClaw में Zalo Personal (अनौपचारिक) समर्थन चाहते हैं
  - आप zalouser प्लगइन को विन्यस्त या विकसित कर रहे हैं
title: "Zalo Personal प्लगइन"
x-i18n:
  source_path: plugins/zalouser.md
  source_hash: b29b788b023cd507
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:30Z
---

# Zalo Personal (प्लगइन)

`zca-cli` का उपयोग करते हुए, एक सामान्य Zalo उपयोगकर्ता खाते को स्वचालित करने के लिए प्लगइन के माध्यम से OpenClaw के लिए Zalo Personal समर्थन।

> **चेतावनी:** अनौपचारिक ऑटोमेशन से खाते का निलंबन/प्रतिबंध हो सकता है। अपने जोखिम पर उपयोग करें।

## Naming

चैनल id `zalouser` है ताकि यह स्पष्ट हो कि यह **व्यक्तिगत Zalo उपयोगकर्ता खाते** (अनौपचारिक) को स्वचालित करता है। संभावित भविष्य के आधिकारिक Zalo API एकीकरण के लिए हम `zalo` को आरक्षित रखते हैं।

## Where it runs

यह प्लगइन **Gateway (गेटवे) प्रक्रिया के भीतर** चलता है।

यदि आप एक दूरस्थ Gateway का उपयोग करते हैं, तो इसे **Gateway चलाने वाली मशीन** पर इंस्टॉल/विन्यस्त करें, फिर Gateway को पुनः आरंभ करें।

## Install

### Option A: npm से इंस्टॉल करें

```bash
openclaw plugins install @openclaw/zalouser
```

इसके बाद Gateway को पुनः आरंभ करें।

### Option B: स्थानीय फ़ोल्डर से इंस्टॉल करें (dev)

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

इसके बाद Gateway को पुनः आरंभ करें।

## Prerequisite: zca-cli

Gateway मशीन पर `zca` का `PATH` पर होना आवश्यक है:

```bash
zca --version
```

## Config

चैनल विन्यास `channels.zalouser` के अंतर्गत रहता है (`plugins.entries.*` के अंतर्गत नहीं):

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

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## Agent tool

टूल नाम: `zalouser`

क्रियाएँ: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`
