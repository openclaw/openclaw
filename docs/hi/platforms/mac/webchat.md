---
summary: "mac ऐप Gateway WebChat को कैसे एम्बेड करता है और उसे कैसे डिबग करें"
read_when:
  - mac WebChat दृश्य या loopback पोर्ट का डिबगिंग
title: "WebChat"
x-i18n:
  source_path: platforms/mac/webchat.md
  source_hash: 7c425374673b817a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:27Z
---

# WebChat (macOS ऐप)

macOS मेनू बार ऐप WebChat UI को एक नेटिव SwiftUI दृश्य के रूप में एम्बेड करता है। यह
Gateway से कनेक्ट होता है और चयनित एजेंट के लिए डिफ़ॉल्ट रूप से **मुख्य सत्र** का उपयोग करता है
(अन्य सत्रों के लिए सत्र स्विचर के साथ)।

- **Local mode**: सीधे स्थानीय Gateway WebSocket से कनेक्ट होता है।
- **Remote mode**: Gateway कंट्रोल पोर्ट को SSH के माध्यम से फ़ॉरवर्ड करता है और उस
  टनल को डेटा प्लेन के रूप में उपयोग करता है।

## Launch & debugging

- Manual: Lobster मेनू → “Open Chat”.
- परीक्षण के लिए Auto‑open:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Logs: `./scripts/clawlog.sh` (subsystem `bot.molt`, category `WebChatSwiftUI`)।

## How it’s wired

- Data plane: Gateway WS मेथड्स `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` और इवेंट्स `chat`, `agent`, `presence`, `tick`, `health`।
- Session: डिफ़ॉल्ट रूप से प्राथमिक सत्र (`main`, या जब scope
  global हो तो `global`)। UI सत्रों के बीच स्विच कर सकता है।
- Onboarding पहले‑रन सेटअप को अलग रखने के लिए एक समर्पित सत्र का उपयोग करता है।

## Security surface

- Remote mode में केवल Gateway WebSocket कंट्रोल पोर्ट को SSH के माध्यम से फ़ॉरवर्ड किया जाता है।

## Known limitations

- UI चैट सत्रों के लिए अनुकूलित है (पूर्ण ब्राउज़र sandbox नहीं)।
