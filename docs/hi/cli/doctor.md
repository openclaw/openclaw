---
summary: "CLI संदर्भ `openclaw doctor` के लिए (स्वास्थ्य जाँच + मार्गदर्शित मरम्मत)"
read_when:
  - आपको कनेक्टिविटी/प्रमाणीकरण संबंधी समस्याएँ हैं और आप मार्गदर्शित समाधान चाहते हैं
  - आपने अपडेट किया है और एक त्वरित सत्यापन चाहते हैं
title: "doctor"
x-i18n:
  source_path: cli/doctor.md
  source_hash: 92310aa3f3d111e9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:00Z
---

# `openclaw doctor`

Gateway और चैनलों के लिए स्वास्थ्य जाँच + त्वरित सुधार।

संबंधित:

- समस्या-निवारण: [Troubleshooting](/gateway/troubleshooting)
- सुरक्षा ऑडिट: [Security](/gateway/security)

## उदाहरण

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

नोट्स:

- इंटरैक्टिव प्रॉम्प्ट (जैसे कीचेन/OAuth सुधार) केवल तब चलते हैं जब stdin एक TTY हो और `--non-interactive` सेट **न** हो। हेडलेस रन (cron, Telegram, टर्मिनल नहीं) प्रॉम्प्ट को छोड़ देंगे।
- `--fix` (`--repair` का उपनाम) `~/.openclaw/openclaw.json.bak` में एक बैकअप लिखता है और अज्ञात विन्यास कुंजियों को हटा देता है, प्रत्येक हटाने को सूचीबद्ध करते हुए।

## macOS: `launchctl` env overrides

यदि आपने पहले `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (या `...PASSWORD`) चलाया था, तो वह मान आपकी विन्यास फ़ाइल को ओवरराइड करता है और लगातार “unauthorized” त्रुटियों का कारण बन सकता है।

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
