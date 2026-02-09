---
summary: "`openclaw configure` के लिए CLI संदर्भ (इंटरैक्टिव विन्यास प्रॉम्प्ट)"
read_when:
  - आप क्रेडेंशियल्स, डिवाइस, या एजेंट डिफ़ॉल्ट्स को इंटरैक्टिव रूप से समायोजित करना चाहते हैं
title: "configure"
---

# `openclaw configure`

क्रेडेंशियल्स, डिवाइस, और एजेंट डिफ़ॉल्ट्स सेट अप करने के लिए इंटरैक्टिव प्रॉम्प्ट।

टिप्पणी: **Model** अनुभाग में अब `agents.defaults.models` allowlist के लिए एक मल्टी-सेलेक्ट शामिल है (जो `/model` और मॉडल पिकर में दिखाई देता है)।

Tip: `openclaw config` without a subcommand opens the same wizard. Use
`openclaw config get|set|unset` for non-interactive edits.

संबंधित:

- Gateway विन्यास संदर्भ: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

टिप्पणियाँ:

- Choosing where the Gateway runs always updates `gateway.mode`. You can select "Continue" without other sections if that is all you need.
- Channel-oriented services (Slack/Discord/Matrix/Microsoft Teams) prompt for channel/room allowlists during setup. You can enter names or IDs; the wizard resolves names to IDs when possible.

## उदाहरण

```bash
openclaw configure
openclaw configure --section models --section channels
```
