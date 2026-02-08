---
summary: "OpenClaw के साथ OpenCode Zen (क्यूरेटेड मॉडल) का उपयोग करें"
read_when:
  - "आप मॉडल एक्सेस के लिए OpenCode Zen चाहते हैं"
  - "आप कोडिंग-फ्रेंडली मॉडलों की एक क्यूरेटेड सूची चाहते हैं"
title: "OpenCode Zen"
x-i18n:
  source_path: providers/opencode.md
  source_hash: b3b5c640ac32f317
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:32Z
---

# OpenCode Zen

OpenCode Zen, OpenCode टीम द्वारा कोडिंग एजेंट्स के लिए अनुशंसित **मॉडलों की एक क्यूरेटेड सूची** है।
यह एक वैकल्पिक, होस्टेड मॉडल एक्सेस पथ है जो एपीआई कुंजी और `opencode` प्रदाता का उपयोग करता है।
Zen वर्तमान में बीटा में है।

## CLI सेटअप

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## विन्यास स्निपेट

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## नोट्स

- `OPENCODE_ZEN_API_KEY` भी समर्थित है।
- आप Zen में साइन इन करते हैं, बिलिंग विवरण जोड़ते हैं, और अपनी एपीआई कुंजी कॉपी करते हैं।
- OpenCode Zen प्रति अनुरोध बिल करता है; विवरण के लिए OpenCode डैशबोर्ड देखें।
