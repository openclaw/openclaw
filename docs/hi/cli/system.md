---
summary: "`openclaw system` के लिए CLI संदर्भ (सिस्टम इवेंट्स, हार्टबीट, प्रेज़ेंस)"
read_when:
  - आप क्रॉन जॉब बनाए बिना किसी सिस्टम इवेंट को कतार में डालना चाहते हैं
  - आपको हार्टबीट सक्षम या अक्षम करने की आवश्यकता है
  - आप सिस्टम प्रेज़ेंस प्रविष्टियों का निरीक्षण करना चाहते हैं
title: "system"
x-i18n:
  source_path: cli/system.md
  source_hash: 36ae5dbdec327f5a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:01Z
---

# `openclaw system`

Gateway के लिए सिस्टम-स्तरीय सहायक: सिस्टम इवेंट्स को कतार में डालें, हार्टबीट नियंत्रित करें,
और प्रेज़ेंस देखें।

## Common commands

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

**main** सत्र पर एक सिस्टम इवेंट को कतार में डालें। अगला हार्टबीट इसे प्रॉम्प्ट में
एक `System:` पंक्ति के रूप में इंजेक्ट करेगा। हार्टबीट को तुरंत ट्रिगर करने के लिए `--mode now` का उपयोग करें;
`next-heartbeat` अगली निर्धारित टिक का इंतज़ार करता है।

Flags:

- `--text <text>`: आवश्यक सिस्टम इवेंट पाठ।
- `--mode <mode>`: `now` या `next-heartbeat` (डिफ़ॉल्ट)।
- `--json`: मशीन-पठनीय आउटपुट।

## `system heartbeat last|enable|disable`

हार्टबीट नियंत्रण:

- `last`: अंतिम हार्टबीट इवेंट दिखाएँ।
- `enable`: हार्टबीट्स को फिर से चालू करें (यदि वे अक्षम थे तो इसका उपयोग करें)।
- `disable`: हार्टबीट्स को विराम दें।

Flags:

- `--json`: मशीन-पठनीय आउटपुट।

## `system presence`

Gateway को ज्ञात वर्तमान सिस्टम प्रेज़ेंस प्रविष्टियों की सूची बनाएँ (नोड्स,
इंस्टेंस, और समान स्थिति पंक्तियाँ)।

Flags:

- `--json`: मशीन-पठनीय आउटपुट।

## Notes

- आपके वर्तमान विन्यास (स्थानीय या दूरस्थ) द्वारा पहुँच योग्य एक चालू Gateway आवश्यक है।
- सिस्टम इवेंट्स अस्थायी होते हैं और पुनः आरंभ के बाद संरक्षित नहीं रहते।
