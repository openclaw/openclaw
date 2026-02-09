---
summary: "mac ऐप Gateway WebChat को कैसे एम्बेड करता है और उसे कैसे डिबग करें"
read_when:
  - mac WebChat दृश्य या loopback पोर्ट का डिबगिंग
title: "WebChat"
---

# WebChat (macOS ऐप)

The macOS menu bar app embeds the WebChat UI as a native SwiftUI view. It
connects to the Gateway and defaults to the **main session** for the selected
agent (with a session switcher for other sessions).

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
- Session: defaults to the primary session (`main`, or `global` when scope is
  global). The UI can switch between sessions.
- Onboarding पहले‑रन सेटअप को अलग रखने के लिए एक समर्पित सत्र का उपयोग करता है।

## Security surface

- Remote mode में केवल Gateway WebSocket कंट्रोल पोर्ट को SSH के माध्यम से फ़ॉरवर्ड किया जाता है।

## Known limitations

- UI चैट सत्रों के लिए अनुकूलित है (पूर्ण ब्राउज़र sandbox नहीं)।
