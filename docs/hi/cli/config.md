---
summary: "`openclaw config` के लिए CLI संदर्भ (config मान प्राप्त/सेट/अनसेट करें)"
read_when:
  - आप config को गैर‑इंटरैक्टिव रूप से पढ़ना या संपादित करना चाहते हैं
title: "config"
x-i18n:
  source_path: cli/config.md
  source_hash: d60a35f5330f22bc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:53Z
---

# `openclaw config`

Config सहायक: पथ के अनुसार मान प्राप्त/सेट/अनसेट करें। बिना किसी उपकमांड के चलाने पर
कॉन्फ़िगर विज़ार्ड खुलेगा ( `openclaw configure` के समान)।

## Examples

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Paths

पथ डॉट या ब्रैकेट नोटेशन का उपयोग करते हैं:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

किसी विशिष्ट एजेंट को लक्षित करने के लिए एजेंट सूची इंडेक्स का उपयोग करें:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

जहाँ संभव हो, मानों को JSON5 के रूप में पार्स किया जाता है; अन्यथा उन्हें स्ट्रिंग माना जाता है।
JSON5 पार्सिंग अनिवार्य करने के लिए `--json` का उपयोग करें।

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

संपादन के बाद Gateway को पुनः आरंभ करें।
