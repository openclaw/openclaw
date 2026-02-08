---
summary: "Gateway के माध्यम से `openclaw agent` के लिए CLI संदर्भ (एक एजेंट टर्न भेजें)"
read_when:
  - आप स्क्रिप्ट्स से एक एजेंट टर्न चलाना चाहते हैं (वैकल्पिक रूप से उत्तर वितरित करें)
title: "एजेंट"
x-i18n:
  source_path: cli/agent.md
  source_hash: dcf12fb94e207c68
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:57Z
---

# `openclaw agent`

Gateway (गेटवे) के माध्यम से एक एजेंट टर्न चलाएँ (एम्बेडेड के लिए `--local` का उपयोग करें)।
कॉन्फ़िगर किए गए एजेंट को सीधे लक्षित करने के लिए `--agent <id>` का उपयोग करें।

संबंधित:

- Agent send टूल: [एजेंट भेजें](/tools/agent-send)

## उदाहरण

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
