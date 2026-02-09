---
summary: "`openclaw voicecall` के लिए CLI संदर्भ (voice-call प्लगइन कमांड सतह)"
read_when:
  - आप voice-call प्लगइन का उपयोग करते हैं और CLI एंट्री पॉइंट्स चाहते हैं
  - आप `voicecall call|continue|status|tail|expose` के लिए त्वरित उदाहरण चाहते हैं
title: "voicecall"
---

# `openclaw voicecall`

19. `voicecall` एक प्लगइन-प्रदान किया गया कमांड है। 20. यह केवल तभी दिखाई देता है जब voice-call प्लगइन इंस्टॉल और सक्षम हो।

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

21. सुरक्षा नोट: webhook endpoint को केवल उन नेटवर्क्स तक ही एक्सपोज़ करें जिन पर आप भरोसा करते हैं। 22. जहाँ संभव हो Funnel की बजाय Tailscale Serve को प्राथमिकता दें।
