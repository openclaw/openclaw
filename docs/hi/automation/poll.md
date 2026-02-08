---
summary: "Gateway + CLI के माध्यम से पोल भेजना"
read_when:
  - पोल समर्थन जोड़ते या संशोधित करते समय
  - CLI या Gateway से पोल भेजने का डिबग करते समय
title: "पोल"
x-i18n:
  source_path: automation/poll.md
  source_hash: 760339865d27ec40
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:54Z
---

# पोल

## समर्थित चैनल

- WhatsApp (वेब चैनल)
- Discord
- MS Teams (Adaptive Cards)

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789@g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

विकल्प:

- `--channel`: `whatsapp` (डिफ़ॉल्ट), `discord`, या `msteams`
- `--poll-multi`: कई विकल्प चुनने की अनुमति
- `--poll-duration-hours`: केवल Discord (छोड़ने पर डिफ़ॉल्ट 24)

## Gateway RPC

विधि: `poll`

पैरामीटर:

- `to` (string, आवश्यक)
- `question` (string, आवश्यक)
- `options` (string[], आवश्यक)
- `maxSelections` (number, वैकल्पिक)
- `durationHours` (number, वैकल्पिक)
- `channel` (string, वैकल्पिक, डिफ़ॉल्ट: `whatsapp`)
- `idempotencyKey` (string, आवश्यक)

## चैनल अंतर

- WhatsApp: 2-12 विकल्प, `maxSelections` विकल्पों की संख्या के भीतर होना चाहिए, `durationHours` को अनदेखा करता है।
- Discord: 2-10 विकल्प, `durationHours` को 1-768 घंटों के बीच सीमित किया जाता है (डिफ़ॉल्ट 24)। `maxSelections > 1` बहु-चयन सक्षम करता है; Discord सख्त चयन संख्या का समर्थन नहीं करता।
- MS Teams: Adaptive Card पोल (OpenClaw-प्रबंधित)। कोई मूल पोल API नहीं; `durationHours` को अनदेखा किया जाता है।

## एजेंट टूल (संदेश)

`message` टूल का उपयोग `poll` क्रिया के साथ करें (`to`, `pollQuestion`, `pollOption`, वैकल्पिक `pollMulti`, `pollDurationHours`, `channel`)।

टिप्पणी: Discord में “ठीक N चुनें” मोड नहीं है; `pollMulti` बहु-चयन से मैप होता है।
Teams पोल Adaptive Cards के रूप में रेंडर किए जाते हैं और वोट रिकॉर्ड करने के लिए Gateway का ऑनलाइन रहना आवश्यक है
`~/.openclaw/msteams-polls.json` में।
