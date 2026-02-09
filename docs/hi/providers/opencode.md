---
summary: "OpenClaw के साथ OpenCode Zen (क्यूरेटेड मॉडल) का उपयोग करें"
read_when:
  - आप मॉडल एक्सेस के लिए OpenCode Zen चाहते हैं
  - आप कोडिंग-फ्रेंडली मॉडलों की एक क्यूरेटेड सूची चाहते हैं
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen is a **curated list of models** recommended by the OpenCode team for coding agents.
It is an optional, hosted model access path that uses an API key and the `opencode` provider.
Zen is currently in beta.

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
