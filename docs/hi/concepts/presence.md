---
summary: "OpenClaw presence प्रविष्टियाँ कैसे उत्पन्न होती हैं, कैसे मर्ज होती हैं, और कैसे प्रदर्शित की जाती हैं"
read_when:
  - Instances टैब का डिबगिंग करते समय
  - डुप्लिकेट या पुरानी instance पंक्तियों की जाँच करते समय
  - Gateway WS कनेक्ट या system-event beacons बदलते समय
title: "Presence"
---

# Presence

OpenClaw “presence” निम्न का एक हल्का, best‑effort दृश्य है:

- स्वयं **Gateway**, और
- **Gateway से जुड़े क्लाइंट** (mac ऐप, WebChat, CLI, आदि)

Presence का उपयोग मुख्य रूप से macOS ऐप के **Instances** टैब को रेंडर करने और
ऑपरेटर को त्वरित दृश्यता प्रदान करने के लिए किया जाता है।

## Presence फ़ील्ड्स (जो दिखाई देता है)

Presence प्रविष्टियाँ संरचित ऑब्जेक्ट्स होती हैं जिनमें निम्न जैसे फ़ील्ड्स होते हैं:

- `instanceId` (वैकल्पिक लेकिन दृढ़ता से अनुशंसित): स्थिर क्लाइंट पहचान (आमतौर पर `connect.client.instanceId`)
- `host`: मानव‑अनुकूल होस्ट नाम
- `ip`: best‑effort IP पता
- `version`: क्लाइंट संस्करण स्ट्रिंग
- `deviceFamily` / `modelIdentifier`: हार्डवेयर संकेत
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: “अंतिम उपयोगकर्ता इनपुट के बाद से सेकंड” (यदि ज्ञात हो)
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `ts`: अंतिम अपडेट टाइमस्टैम्प (epoch से मिलीसेकंड)

## Producers (presence कहाँ से आती है)

Presence प्रविष्टियाँ कई स्रोतों से उत्पन्न होती हैं और **मर्ज** की जाती हैं।

### 1. Gateway self entry

Gateway स्टार्टअप पर हमेशा एक “self” प्रविष्टि सीड करता है ताकि किसी भी क्लाइंट के
कनेक्ट होने से पहले ही UI में Gateway होस्ट दिखाई दे।

### 2. WebSocket connect

Every WS client begins with a `connect` request. On successful handshake the
Gateway upserts a presence entry for that connection.

#### एक‑बार वाले CLI कमांड क्यों नहीं दिखते

The CLI often connects for short, one‑off commands. To avoid spamming the
Instances list, `client.mode === "cli"` is **not** turned into a presence entry.

### 3. `system-event` beacons

Clients can send richer periodic beacons via the `system-event` method. The mac
app uses this to report host name, IP, and `lastInputSeconds`.

### 4. Node कनेक्शन (role: node)

जब कोई node Gateway WebSocket पर `role: node` के साथ कनेक्ट होता है, तो Gateway
उस node के लिए एक presence प्रविष्टि upsert करता है (अन्य WS क्लाइंट्स जैसा ही प्रवाह)।

## Merge + dedupe नियम (`instanceId` क्यों महत्वपूर्ण है)

Presence प्रविष्टियाँ एक ही in‑memory मैप में संग्रहीत होती हैं:

- प्रविष्टियाँ एक **presence key** द्वारा key की जाती हैं।
- सबसे अच्छा key एक स्थिर `instanceId` होता है ( `connect.client.instanceId` से) जो
  रीस्टार्ट के बाद भी बना रहता है।
- Keys case‑insensitive होती हैं।

यदि कोई क्लाइंट बिना स्थिर `instanceId` के पुनः कनेक्ट होता है, तो वह
**डुप्लिकेट** पंक्ति के रूप में दिखाई दे सकता है।

## TTL और सीमित आकार

Presence जानबूझकर ephemeral है:

- **TTL:** 5 मिनट से पुराने प्रविष्टियाँ हटा दी जाती हैं
- **अधिकतम प्रविष्टियाँ:** 200 (सबसे पुरानी पहले हटाई जाती हैं)

यह सूची को ताज़ा रखता है और अनियंत्रित मेमोरी वृद्धि से बचाता है।

## Remote/tunnel चेतावनी (loopback IPs)

When a client connects over an SSH tunnel / local port forward, the Gateway may
see the remote address as `127.0.0.1`. To avoid overwriting a good client‑reported
IP, loopback remote addresses are ignored.

## Consumers

### macOS Instances टैब

macOS ऐप `system-presence` के आउटपुट को रेंडर करता है और अंतिम अपडेट की आयु के आधार पर
एक छोटा स्टेटस संकेतक (Active/Idle/Stale) लागू करता है।

## Debugging सुझाव

- कच्ची सूची देखने के लिए, Gateway के विरुद्ध `system-presence` कॉल करें।
- यदि आपको डुप्लिकेट दिखाई दें:
  - पुष्टि करें कि क्लाइंट हैंडशेक में एक स्थिर `client.instanceId` भेजते हैं
  - पुष्टि करें कि आवधिक beacons उसी `instanceId` का उपयोग करते हैं
  - जाँचें कि क्या कनेक्शन‑व्युत्पन्न प्रविष्टि में `instanceId` गायब है (डुप्लिकेट अपेक्षित हैं)
