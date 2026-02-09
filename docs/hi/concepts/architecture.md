---
summary: "WebSocket गेटवे आर्किटेक्चर, घटक, और क्लाइंट फ्लो"
read_when:
  - Gateway प्रोटोकॉल, क्लाइंट्स, या ट्रांसपोर्ट्स पर काम करते समय
title: "Gateway आर्किटेक्चर"
---

# Gateway आर्किटेक्चर

अंतिम अपडेट: 2026-01-22

## अवलोकन

- एक एकल, दीर्घ‑जीवी **Gateway** सभी मैसेजिंग सतहों का स्वामित्व रखता है (Baileys के माध्यम से WhatsApp, grammY के माध्यम से Telegram, Slack, Discord, Signal, iMessage, WebChat)।
- कंट्रोल‑प्लेन क्लाइंट्स (macOS ऐप, CLI, वेब UI, ऑटोमेशन्स) कॉन्फ़िगर किए गए bind होस्ट (डिफ़ॉल्ट `127.0.0.1:18789`) पर **WebSocket** के माध्यम से Gateway से जुड़ते हैं।
- **Nodes** (macOS/iOS/Android/headless) भी **WebSocket** के माध्यम से कनेक्ट होते हैं, लेकिन स्पष्ट caps/commands के साथ `role: node` घोषित करते हैं।
- प्रति होस्ट एक Gateway; वही एकमात्र स्थान है जहाँ WhatsApp सत्र खोला जाता है।
- एक **canvas host** (डिफ़ॉल्ट `18793`) एजेंट‑संपादन योग्य HTML और A2UI परोसता है।

## घटक और फ्लो

### Gateway (डेमन)

- प्रदाता कनेक्शनों को बनाए रखता है।
- एक typed WS API उजागर करता है (रिक्वेस्ट, रिस्पॉन्स, सर्वर‑पुश इवेंट्स)।
- इनबाउंड फ्रेम्स को JSON Schema के विरुद्ध वैलिडेट करता है।
- `agent`, `chat`, `presence`, `health`, `heartbeat`, `cron` जैसे इवेंट्स उत्सर्जित करता है।

### क्लाइंट्स (mac ऐप / CLI / वेब एडमिन)

- प्रति क्लाइंट एक WS कनेक्शन।
- रिक्वेस्ट भेजते हैं (`health`, `status`, `send`, `agent`, `system-presence`)।
- इवेंट्स की सदस्यता लेते हैं (`tick`, `agent`, `presence`, `shutdown`)।

### Nodes (macOS / iOS / Android / headless)

- **उसी WS सर्वर** से `role: node` के साथ कनेक्ट होते हैं।
- `connect` में एक डिवाइस पहचान प्रदान करते हैं; पेयरिंग **डिवाइस‑आधारित** होती है (भूमिका `node`) और अनुमोदन डिवाइस पेयरिंग स्टोर में रहता है।
- `canvas.*`, `camera.*`, `screen.record`, `location.get` जैसे कमांड्स उजागर करते हैं।

प्रोटोकॉल विवरण:

- [Gateway protocol](/gateway/protocol)

### WebChat

- एक स्टैटिक UI जो चैट इतिहास और सेंड्स के लिए Gateway WS API का उपयोग करता है।
- रिमोट सेटअप्स में, अन्य क्लाइंट्स की तरह उसी SSH/Tailscale टनल के माध्यम से कनेक्ट होता है।

## कनेक्शन लाइफसाइकल (एकल क्लाइंट)

```
Client                    Gateway
  |                          |
  |---- req:connect -------->|
  |<------ res (ok) ---------|   (or res error + close)
  |   (payload=hello-ok carries snapshot: presence + health)
  |                          |
  |<------ event:presence ---|
  |<------ event:tick -------|
  |                          |
  |------- req:agent ------->|
  |<------ res:agent --------|   (ack: {runId,status:"accepted"})
  |<------ event:agent ------|   (streaming)
  |<------ res:agent --------|   (final: {runId,status,summary})
  |                          |
```

## वायर प्रोटोकॉल (सारांश)

- ट्रांसपोर्ट: WebSocket, JSON पेलोड्स के साथ टेक्स्ट फ्रेम्स।
- पहला फ्रेम **अनिवार्य रूप से** `connect` होना चाहिए।
- हैंडशेक के बाद:
  - रिक्वेस्ट्स: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - इवेंट्स: `{type:"event", event, payload, seq?, stateVersion?}`
- यदि `OPENCLAW_GATEWAY_TOKEN` (या `--token`) सेट है, तो `connect.params.auth.token` का मिलान होना चाहिए; अन्यथा सॉकेट बंद हो जाता है।
- साइड‑इफ़ेक्टिंग मेथड्स (`send`, `agent`) के लिए आइडेम्पोटेंसी कीज़ आवश्यक हैं ताकि सुरक्षित रूप से री‑ट्राई किया जा सके; सर्वर एक अल्प‑आयु डिड्यूप कैश रखता है।
- Nodes को `role: "node"` के साथ‑साथ caps/commands/permissions को `connect` में शामिल करना चाहिए।

## पेयरिंग + स्थानीय ट्रस्ट

- सभी WS क्लाइंट्स (ऑपरेटर्स + nodes) `connect` पर एक **डिवाइस पहचान** शामिल करते हैं।
- नए डिवाइस IDs के लिए पेयरिंग अनुमोदन आवश्यक है; Gateway बाद के कनेक्ट्स के लिए एक **डिवाइस टोकन** जारी करता है।
- **स्थानीय** कनेक्ट्स (loopback या Gateway होस्ट का अपना tailnet पता) को समान‑होस्ट UX को सहज रखने के लिए स्वतः‑अनुमोदित किया जा सकता है।
- **गैर‑स्थानीय** कनेक्ट्स को `connect.challenge` nonce पर साइन करना होता है और स्पष्ट अनुमोदन आवश्यक होता है।
- Gateway प्रमाणीकरण (`gateway.auth.*`) **सभी** कनेक्शनों पर लागू रहता है, स्थानीय हों या रिमोट।

विवरण: [Gateway protocol](/gateway/protocol), [Pairing](/channels/pairing),
[Security](/gateway/security)।

## प्रोटोकॉल टाइपिंग और कोडजन

- TypeBox स्कीमाएँ प्रोटोकॉल को परिभाषित करती हैं।
- उन स्कीमाओं से JSON Schema जनरेट किया जाता है।
- JSON Schema से Swift मॉडल्स जनरेट किए जाते हैं।

## रिमोट एक्सेस

- प्राथमिक: Tailscale या VPN।

- वैकल्पिक: SSH टनल

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- टनल के ऊपर वही हैंडशेक + ऑथ टोकन लागू होते हैं।

- रिमोट सेटअप्स में WS के लिए TLS + वैकल्पिक पिनिंग सक्षम की जा सकती है।

## ऑपरेशन्स स्नैपशॉट

- स्टार्ट: `openclaw gateway` (फ़ोरग्राउंड, stdout पर लॉग्स)।
- हेल्थ: WS के माध्यम से `health` ( `hello-ok` में भी शामिल)।
- सुपरविज़न: ऑटो‑रीस्टार्ट के लिए launchd/systemd।

## इनवेरिएंट्स

- प्रति होस्ट ठीक एक Gateway एकल Baileys सत्र को नियंत्रित करता है।
- हैंडशेक अनिवार्य है; कोई भी non‑JSON या non‑connect पहला फ्रेम हार्ड क्लोज़ है।
- इवेंट्स रिप्ले नहीं किए जाते; गैप्स पर क्लाइंट्स को रिफ़्रेश करना चाहिए।
