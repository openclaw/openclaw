---
summary: "`openclaw onboard` के लिए CLI संदर्भ (इंटरैक्टिव ऑनबोर्डिंग विज़ार्ड)"
read_when:
  - आपको Gateway, वर्कस्पेस, प्रमाणीकरण, चैनल और Skills के लिए मार्गदर्शित सेटअप चाहिए
title: "onboard"
---

# `openclaw onboard`

इंटरैक्टिव ऑनबोर्डिंग विज़ार्ड (स्थानीय या दूरस्थ Gateway सेटअप)।

## Related guides

- CLI ऑनबोर्डिंग हब: [Onboarding Wizard (CLI)](/start/wizard)
- CLI ऑनबोर्डिंग संदर्भ: [CLI Onboarding Reference](/start/wizard-cli-reference)
- CLI स्वचालन: [CLI Automation](/start/wizard-cli-automation)
- macOS ऑनबोर्डिंग: [Onboarding (macOS App)](/start/onboarding)

## Examples

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Flow नोट्स:

- `quickstart`: न्यूनतम प्रॉम्प्ट्स, Gateway टोकन स्वतः जनरेट करता है।
- `manual`: पोर्ट/बाइंड/प्रमाणीकरण के लिए पूर्ण प्रॉम्प्ट्स ( `advanced` का उपनाम)।
- सबसे तेज़ पहली चैट: `openclaw dashboard` (कंट्रोल UI, चैनल सेटअप नहीं)।

## Common follow-up commands

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` does not imply non-interactive mode. Use `--non-interactive` for scripts.
</Note>
