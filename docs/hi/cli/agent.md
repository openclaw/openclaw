---
summary: "Gateway के माध्यम से `openclaw agent` के लिए CLI संदर्भ (एक एजेंट टर्न भेजें)"
read_when:
  - आप स्क्रिप्ट्स से एक एजेंट टर्न चलाना चाहते हैं (वैकल्पिक रूप से उत्तर वितरित करें)
title: "एजेंट"
---

# `openclaw agent`

Gateway के माध्यम से एक एजेंट टर्न चलाएँ (`--local` का उपयोग एम्बेडेड के लिए करें)।
किसी कॉन्फ़िगर किए गए एजेंट को सीधे लक्षित करने के लिए `--agent <id>` का उपयोग करें।

संबंधित:

- Agent send टूल: [एजेंट भेजें](/tools/agent-send)

## उदाहरण

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
