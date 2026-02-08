---
summary: "एक ही होस्ट पर कई OpenClaw Gateway चलाएँ (आइसोलेशन, पोर्ट्स और प्रोफाइल)"
read_when:
  - एक ही मशीन पर एक से अधिक Gateway चलाते समय
  - प्रत्येक Gateway के लिए पृथक विन्यास/स्थिति/पोर्ट्स की आवश्यकता हो
title: "एकाधिक Gateway"
x-i18n:
  source_path: gateway/multiple-gateways.md
  source_hash: 09b5035d4e5fb97c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:16Z
---

# एकाधिक Gateway (एक ही होस्ट)

अधिकांश सेटअप में एक Gateway का उपयोग करना चाहिए क्योंकि एक ही Gateway कई मैसेजिंग कनेक्शन और एजेंट संभाल सकता है। यदि आपको अधिक मज़बूत आइसोलेशन या रेडंडेंसी (जैसे, एक रेस्क्यू बॉट) की आवश्यकता है, तो पृथक प्रोफाइल/पोर्ट्स के साथ अलग-अलग Gateway चलाएँ।

## आइसोलेशन चेकलिस्ट (आवश्यक)

- `OPENCLAW_CONFIG_PATH` — प्रति-इंस्टेंस विन्यास फ़ाइल
- `OPENCLAW_STATE_DIR` — प्रति-इंस्टेंस सत्र, क्रेडेंशियल्स, कैश
- `agents.defaults.workspace` — प्रति-इंस्टेंस वर्कस्पेस रूट
- `gateway.port` (या `--port`) — प्रत्येक इंस्टेंस के लिए अद्वितीय
- व्युत्पन्न पोर्ट्स (ब्राउज़र/कैनवास) ओवरलैप नहीं होने चाहिए

यदि ये साझा किए जाते हैं, तो आपको विन्यास रेस और पोर्ट टकराव का सामना करना पड़ेगा।

## अनुशंसित: प्रोफाइल (`--profile`)

प्रोफाइल स्वतः `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` को स्कोप करते हैं और सेवा नामों में प्रत्यय जोड़ते हैं।

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

प्रति-प्रोफाइल सेवाएँ:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## रेस्क्यू-बॉट गाइड

उसी होस्ट पर एक दूसरा Gateway उसके अपने निम्नलिखित के साथ चलाएँ:

- प्रोफाइल/विन्यास
- स्टेट डायरेक्टरी
- वर्कस्पेस
- बेस पोर्ट (साथ में व्युत्पन्न पोर्ट्स)

यह रेस्क्यू बॉट को मुख्य बॉट से अलग रखता है ताकि प्राथमिक बॉट डाउन होने पर यह डिबग कर सके या विन्यास परिवर्तन लागू कर सके।

पोर्ट स्पेसिंग: बेस पोर्ट्स के बीच कम से कम 20 पोर्ट का अंतर रखें ताकि व्युत्पन्न ब्राउज़र/कैनवास/CDP पोर्ट्स कभी टकराएँ नहीं।

### कैसे इंस्टॉल करें (रेस्क्यू बॉट)

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

## पोर्ट मैपिंग (व्युत्पन्न)

बेस पोर्ट = `gateway.port` (या `OPENCLAW_GATEWAY_PORT` / `--port`)।

- ब्राउज़र कंट्रोल सेवा पोर्ट = बेस + 2 (केवल loopback)
- `canvasHost.port = base + 4`
- ब्राउज़र प्रोफाइल CDP पोर्ट्स `browser.controlPort + 9 .. + 108` से स्वतः आवंटित होते हैं

यदि आप इनमें से किसी को भी विन्यास या पर्यावरण चर में ओवरराइड करते हैं, तो आपको प्रत्येक इंस्टेंस के लिए इन्हें अद्वितीय रखना होगा।

## ब्राउज़र/CDP नोट्स (सामान्य गलती)

- कई इंस्टेंस पर `browser.cdpUrl` को एक ही मान पर **पिन न करें**।
- प्रत्येक इंस्टेंस को अपना स्वयं का ब्राउज़र कंट्रोल पोर्ट और CDP रेंज चाहिए (जो उसके Gateway पोर्ट से व्युत्पन्न होती है)।
- यदि आपको स्पष्ट CDP पोर्ट्स की आवश्यकता है, तो प्रति इंस्टेंस `browser.profiles.<name>.cdpPort` सेट करें।
- रिमोट Chrome: `browser.profiles.<name>.cdpUrl` का उपयोग करें (प्रति प्रोफाइल, प्रति इंस्टेंस)।

## मैनुअल env उदाहरण

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## त्वरित जाँच

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
