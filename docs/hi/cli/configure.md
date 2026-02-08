---
summary: "`openclaw configure` के लिए CLI संदर्भ (इंटरैक्टिव विन्यास प्रॉम्प्ट)"
read_when:
  - आप क्रेडेंशियल्स, डिवाइस, या एजेंट डिफ़ॉल्ट्स को इंटरैक्टिव रूप से समायोजित करना चाहते हैं
title: "configure"
x-i18n:
  source_path: cli/configure.md
  source_hash: 9cb2bb5237b02b3a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:54Z
---

# `openclaw configure`

क्रेडेंशियल्स, डिवाइस, और एजेंट डिफ़ॉल्ट्स सेट अप करने के लिए इंटरैक्टिव प्रॉम्प्ट।

टिप्पणी: **Model** अनुभाग में अब `agents.defaults.models` allowlist के लिए एक मल्टी-सेलेक्ट शामिल है (जो `/model` और मॉडल पिकर में दिखाई देता है)।

सुझाव: बिना किसी सबकमांड के `openclaw config` चलाने पर वही विज़ार्ड खुलता है। नॉन-इंटरैक्टिव संपादन के लिए `openclaw config get|set|unset` का उपयोग करें।

संबंधित:

- Gateway विन्यास संदर्भ: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

टिप्पणियाँ:

- Gateway कहाँ चलता है इसका चयन हमेशा `gateway.mode` को अपडेट करता है। यदि आपको केवल यही चाहिए, तो आप अन्य अनुभागों के बिना "Continue" चुन सकते हैं।
- चैनल-उन्मुख सेवाएँ (Slack/Discord/Matrix/Microsoft Teams) सेटअप के दौरान चैनल/रूम allowlist के लिए प्रॉम्प्ट करती हैं। आप नाम या IDs दर्ज कर सकते हैं; जहाँ संभव हो, विज़ार्ड नामों को IDs में बदल देता है।

## उदाहरण

```bash
openclaw configure
openclaw configure --section models --section channels
```
