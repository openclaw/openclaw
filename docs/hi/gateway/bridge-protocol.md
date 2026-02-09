---
summary: "ब्रिज प्रोटोकॉल (लीगेसी नोड्स): TCP JSONL, पेयरिंग, स्कोप्ड RPC"
read_when:
  - नोड क्लाइंट (iOS/Android/macOS नोड मोड) बनाते या डिबग करते समय
  - पेयरिंग या ब्रिज प्रमाणीकरण विफलताओं की जाँच करते समय
  - Gateway द्वारा उजागर किए गए नोड सरफेस का ऑडिट करते समय
title: "ब्रिज प्रोटोकॉल"
---

# ब्रिज प्रोटोकॉल (लीगेसी नोड ट्रांसपोर्ट)

27. Bridge प्रोटोकॉल एक **legacy** node transport (TCP JSONL) है। 28. नए node clients
    को इसके बजाय unified Gateway WebSocket प्रोटोकॉल का उपयोग करना चाहिए।

यदि आप कोई ऑपरेटर या नोड क्लाइंट बना रहे हैं, तो
[Gateway प्रोटोकॉल](/gateway/protocol) का उपयोग करें।

29. **नोट:** वर्तमान OpenClaw builds अब TCP bridge listener के साथ ship नहीं होते; यह दस्तावेज़ ऐतिहासिक संदर्भ के लिए रखा गया है।
30. Legacy `bridge.*` config keys अब config schema का हिस्सा नहीं हैं।

## हमारे पास दोनों क्यों हैं

- **सुरक्षा सीमा**: ब्रिज, पूर्ण Gateway API सरफेस के बजाय एक छोटा allowlist उजागर करता है।
- **पेयरिंग + नोड पहचान**: नोड प्रवेश Gateway के स्वामित्व में होता है और प्रति-नोड टोकन से जुड़ा होता है।
- **डिस्कवरी UX**: नोड्स LAN पर Bonjour के माध्यम से Gateway खोज सकते हैं, या सीधे किसी tailnet पर कनेक्ट कर सकते हैं।
- **लूपबैक WS**: पूर्ण WS कंट्रोल प्लेन स्थानीय रहता है, जब तक कि SSH के माध्यम से टनल न किया जाए।

## ट्रांसपोर्ट

- TCP, प्रति पंक्ति एक JSON ऑब्जेक्ट (JSONL)।
- वैकल्पिक TLS (जब `bridge.tls.enabled` true हो)।
- लीगेसी डिफ़ॉल्ट लिस्नर पोर्ट `18790` था (वर्तमान बिल्ड्स TCP ब्रिज शुरू नहीं करते)।

जब TLS सक्षम होता है, तो डिस्कवरी TXT रिकॉर्ड्स में `bridgeTls=1` के साथ
`bridgeTlsSha256` शामिल होता है ताकि नोड्स प्रमाणपत्र को पिन कर सकें।

## हैंडशेक + पेयरिंग

1. क्लाइंट नोड मेटाडेटा + टोकन (यदि पहले से पेयर हो) के साथ `hello` भेजता है।
2. यदि पेयर नहीं है, तो Gateway `error` (`NOT_PAIRED`/`UNAUTHORIZED`) के साथ उत्तर देता है।
3. क्लाइंट `pair-request` भेजता है।
4. Gateway अनुमोदन की प्रतीक्षा करता है, फिर `pair-ok` और `hello-ok` भेजता है।

`hello-ok` `serverName` लौटाता है और इसमें `canvasHostUrl` शामिल हो सकता है।

## फ़्रेम्स

क्लाइंट → Gateway:

- `req` / `res`: स्कोप्ड Gateway RPC (चैट, सत्र, विन्यास, स्वास्थ्य, voicewake, skills.bins)
- `event`: नोड संकेत (वॉइस ट्रांसक्रिप्ट, एजेंट अनुरोध, चैट सब्सक्राइब, exec लाइफसाइकिल)

Gateway → क्लाइंट:

- `invoke` / `invoke-res`: नोड कमांड्स (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: सब्सक्राइब किए गए सत्रों के लिए चैट अपडेट्स
- `ping` / `pong`: कीपअलाइव

लीगेसी allowlist प्रवर्तन `src/gateway/server-bridge.ts` में रहता था (हटाया गया)।

## Exec लाइफसाइकिल इवेंट्स

31. Nodes सिस्टम.run गतिविधि को सतह पर लाने के लिए `exec.finished` या `exec.denied` events emit कर सकते हैं।
32. इन्हें gateway में system events के रूप में map किया जाता है। 33. (Legacy nodes अभी भी `exec.started` emit कर सकते हैं।)

पेलोड फ़ील्ड्स (जहाँ उल्लेख न हो, सभी वैकल्पिक):

- `sessionKey` (आवश्यक): सिस्टम इवेंट प्राप्त करने के लिए एजेंट सत्र।
- `runId`: समूहकरण के लिए अद्वितीय exec id।
- `command`: कच्ची या फ़ॉर्मैटेड कमांड स्ट्रिंग।
- `exitCode`, `timedOut`, `success`, `output`: पूर्णता विवरण (केवल समाप्त होने पर)।
- `reason`: अस्वीकृति कारण (केवल अस्वीकृत होने पर)।

## Tailnet उपयोग

- ब्रिज को किसी tailnet IP पर बाइंड करें: `bridge.bind: "tailnet"` में
  `~/.openclaw/openclaw.json`।
- क्लाइंट्स MagicDNS नाम या tailnet IP के माध्यम से कनेक्ट करते हैं।
- Bonjour नेटवर्क्स के पार **नहीं** जाता; आवश्यकता होने पर मैनुअल होस्ट/पोर्ट या वाइड-एरिया DNS‑SD का उपयोग करें।

## संस्करणिंग

34. Bridge वर्तमान में **implicit v1** है (कोई min/max negotiation नहीं)। 35. Backward‑compat
    अपेक्षित है; किसी भी breaking changes से पहले bridge protocol version field जोड़ें।
