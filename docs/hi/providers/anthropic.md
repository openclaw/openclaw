---
summary: "OpenClaw में API कुंजियों या setup-token के माध्यम से Anthropic Claude का उपयोग करें"
read_when:
  - आप OpenClaw में Anthropic मॉडल का उपयोग करना चाहते हैं
  - आप API कुंजियों के बजाय setup-token चाहते हैं
title: "Anthropic"
x-i18n:
  source_path: providers/anthropic.md
  source_hash: a0e91ae9fc5b67ba
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:34Z
---

# Anthropic (Claude)

Anthropic **Claude** मॉडल परिवार बनाता है और API के माध्यम से एक्सेस प्रदान करता है।
OpenClaw में आप API कुंजी या **setup-token** के साथ प्रमाणीकरण कर सकते हैं।

## विकल्प A: Anthropic API कुंजी

**उपयुक्त:** मानक API एक्सेस और उपयोग-आधारित बिलिंग।
Anthropic Console में अपनी API कुंजी बनाएँ।

### CLI सेटअप

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Config snippet

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Prompt caching (Anthropic API)

OpenClaw, Anthropic की prompt caching सुविधा का समर्थन करता है। यह **केवल API** के लिए है; सब्सक्रिप्शन प्रमाणीकरण कैश सेटिंग्स का सम्मान नहीं करता।

### Configuration

अपने मॉडल विन्यास में `cacheRetention` पैरामीटर का उपयोग करें:

| Value   | Cache Duration | Description                        |
| ------- | -------------- | ---------------------------------- |
| `none`  | No caching     | Prompt caching अक्षम करें          |
| `short` | 5 minutes      | API Key प्रमाणीकरण के लिए डिफ़ॉल्ट |
| `long`  | 1 hour         | विस्तारित कैश (beta फ़्लैग आवश्यक) |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### Defaults

Anthropic API Key प्रमाणीकरण का उपयोग करते समय, OpenClaw सभी Anthropic मॉडलों के लिए स्वचालित रूप से `cacheRetention: "short"` (5‑मिनट कैश) लागू करता है। आप अपने विन्यास में स्पष्ट रूप से `cacheRetention` सेट करके इसे ओवरराइड कर सकते हैं।

### Legacy parameter

पुराना `cacheControlTtl` पैरामीटर पिछड़े अनुकूलन के लिए अभी भी समर्थित है:

- `"5m"` का मैपिंग `short` से होता है
- `"1h"` का मैपिंग `long` से होता है

हम नए `cacheRetention` पैरामीटर पर माइग्रेट करने की अनुशंसा करते हैं।

OpenClaw में Anthropic API अनुरोधों के लिए `extended-cache-ttl-2025-04-11` beta फ़्लैग शामिल है; यदि आप प्रदाता हेडर ओवरराइड करते हैं तो इसे बनाए रखें (देखें [/gateway/configuration](/gateway/configuration))।

## विकल्प B: Claude setup-token

**उपयुक्त:** अपनी Claude सब्सक्रिप्शन का उपयोग करने के लिए।

### setup-token कहाँ प्राप्त करें

Setup-token **Claude Code CLI** द्वारा बनाए जाते हैं, न कि Anthropic Console द्वारा। आप इसे **किसी भी मशीन** पर चला सकते हैं:

```bash
claude setup-token
```

टोकन को OpenClaw में पेस्ट करें (विज़ार्ड: **Anthropic token (paste setup-token)**), या इसे Gateway होस्ट पर चलाएँ:

```bash
openclaw models auth setup-token --provider anthropic
```

यदि आपने टोकन किसी दूसरी मशीन पर बनाया है, तो उसे पेस्ट करें:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI सेटअप (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### Config snippet (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Notes

- `claude setup-token` के साथ setup-token जनरेट करें और उसे पेस्ट करें, या Gateway होस्ट पर `openclaw models auth setup-token` चलाएँ।
- यदि Claude सब्सक्रिप्शन पर “OAuth token refresh failed …” दिखाई दे, तो setup-token के साथ पुनः प्रमाणीकरण करें। देखें [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription)।
- प्रमाणीकरण विवरण + पुनः उपयोग नियम [/concepts/oauth](/concepts/oauth) में हैं।

## Troubleshooting

**401 त्रुटियाँ / टोकन अचानक अमान्य**

- Claude सब्सक्रिप्शन प्रमाणीकरण समाप्त हो सकता है या रद्द किया जा सकता है। `claude setup-token` पुनः चलाएँ
  और इसे **Gateway होस्ट** में पेस्ट करें।
- यदि Claude CLI लॉगिन किसी दूसरी मशीन पर है, तो Gateway होस्ट पर
  `openclaw models auth paste-token --provider anthropic` का उपयोग करें।

**प्रदाता "anthropic" के लिए कोई API कुंजी नहीं मिली**

- प्रमाणीकरण **प्रति एजेंट** होता है। नए एजेंट मुख्य एजेंट की कुंजियाँ विरासत में नहीं लेते।
- उस एजेंट के लिए onboarding पुनः चलाएँ, या Gateway होस्ट पर setup-token / API कुंजी पेस्ट करें,
  फिर `openclaw models status` के साथ सत्यापित करें।

**प्रोफ़ाइल `anthropic:default` के लिए कोई क्रेडेंशियल नहीं मिले**

- यह देखने के लिए `openclaw models status` चलाएँ कि कौन-सा auth प्रोफ़ाइल सक्रिय है।
- onboarding पुनः चलाएँ, या उस प्रोफ़ाइल के लिए setup-token / API कुंजी पेस्ट करें।

**कोई उपलब्ध auth प्रोफ़ाइल नहीं (सभी cooldown/अनुपलब्ध)**

- `openclaw models status --json` में `auth.unusableProfiles` की जाँच करें।
- कोई अन्य Anthropic प्रोफ़ाइल जोड़ें या cooldown समाप्त होने की प्रतीक्षा करें।

और अधिक: [/gateway/troubleshooting](/gateway/troubleshooting) और [/help/faq](/help/faq)।
