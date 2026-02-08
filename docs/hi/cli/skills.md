---
summary: "`openclaw skills` (list/info/check) और स्किल पात्रता के लिए CLI संदर्भ"
read_when:
  - आप देखना चाहते हैं कि कौन-से Skills उपलब्ध हैं और चलाने के लिए तैयार हैं
  - आप Skills के लिए गायब बाइनरी/पर्यावरण चर/विन्यास का डिबग करना चाहते हैं
title: "Skills"
x-i18n:
  source_path: cli/skills.md
  source_hash: 7878442c88a27ec8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:01Z
---

# `openclaw skills`

Skills (bundled + workspace + managed overrides) का निरीक्षण करें और देखें कि कौन-से पात्र हैं बनाम किन आवश्यकताओं की कमी है।

संबंधित:

- Skills सिस्टम: [Skills](/tools/skills)
- Skills विन्यास: [Skills config](/tools/skills-config)
- ClawHub इंस्टॉल्स: [ClawHub](/tools/clawhub)

## कमांड्स

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
