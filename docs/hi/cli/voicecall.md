---
summary: "`openclaw voicecall` के लिए CLI संदर्भ (voice-call प्लगइन कमांड सतह)"
read_when:
  - आप voice-call प्लगइन का उपयोग करते हैं और CLI एंट्री पॉइंट्स चाहते हैं
  - आप `voicecall call|continue|status|tail|expose` के लिए त्वरित उदाहरण चाहते हैं
title: "voicecall"
x-i18n:
  source_path: cli/voicecall.md
  source_hash: d93aaee6f6f5c9ac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:05Z
---

# `openclaw voicecall`

`voicecall` एक प्लगइन-प्रदान किया गया कमांड है। यह केवल तब दिखाई देता है जब voice-call प्लगइन इंस्टॉल और सक्षम हो।

प्राथमिक दस्तावेज़:

- Voice-call प्लगइन: [Voice Call](/plugins/voice-call)

## सामान्य कमांड

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## वेबहुक्स को एक्सपोज़ करना (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

सुरक्षा टिप्पणी: वेबहुक एंडपॉइंट को केवल उन्हीं नेटवर्क्स तक एक्सपोज़ करें जिन पर आप भरोसा करते हैं। जहाँ संभव हो, Funnel की बजाय Tailscale Serve को प्राथमिकता दें।
