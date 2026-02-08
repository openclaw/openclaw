---
summary: "RPC के माध्यम से Gateway लॉग्स को टेल करने के लिए `openclaw logs` का CLI संदर्भ"
read_when:
  - आपको SSH के बिना दूरस्थ रूप से Gateway लॉग्स टेल करने की आवश्यकता हो
  - आपको टूलिंग के लिए JSON लॉग लाइनों की आवश्यकता हो
title: "लॉग्स"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:59Z
---

# `openclaw logs`

RPC के माध्यम से Gateway फ़ाइल लॉग्स को टेल करें (दूरस्थ मोड में कार्य करता है)।

संबंधित:

- लॉगिंग अवलोकन: [Logging](/logging)

## उदाहरण

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
