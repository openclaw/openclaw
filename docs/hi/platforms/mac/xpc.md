---
summary: "OpenClaw ऐप, Gateway नोड ट्रांसपोर्ट, और PeekabooBridge के लिए macOS IPC आर्किटेक्चर"
read_when:
  - IPC कॉन्ट्रैक्ट्स या मेनू बार ऐप IPC संपादित करते समय
title: "macOS IPC"
---

# OpenClaw macOS IPC आर्किटेक्चर

**Current model:** a local Unix socket connects the **node host service** to the **macOS app** for exec approvals + `system.run`. A `openclaw-mac` debug CLI exists for discovery/connect checks; agent actions still flow through the Gateway WebSocket and `node.invoke`. UI automation uses PeekabooBridge.

## लक्ष्य

- एकल GUI ऐप इंस्टेंस जो सभी TCC-सामना करने वाले कार्यों का स्वामित्व रखता है (नोटिफ़िकेशन, स्क्रीन रिकॉर्डिंग, माइक, स्पीच, AppleScript)।
- ऑटोमेशन के लिए छोटा सतह क्षेत्र: Gateway + node कमांड्स, तथा UI ऑटोमेशन के लिए PeekabooBridge।
- पूर्वानुमेय अनुमतियाँ: हमेशा वही साइन किया हुआ बंडल ID, launchd द्वारा लॉन्च किया गया, ताकि TCC ग्रांट्स स्थिर रहें।

## यह कैसे काम करता है

### Gateway + node ट्रांसपोर्ट

- ऐप Gateway (local mode) चलाता है और node के रूप में उससे कनेक्ट होता है।
- एजेंट क्रियाएँ `node.invoke` के माध्यम से की जाती हैं (जैसे `system.run`, `system.notify`, `canvas.*`)।

### Node service + ऐप IPC

- एक हेडलेस node host service Gateway WebSocket से कनेक्ट होता है।
- `system.run` अनुरोधों को एक स्थानीय Unix सॉकेट के माध्यम से macOS ऐप तक अग्रेषित किया जाता है।
- ऐप UI संदर्भ में exec करता है, आवश्यकता होने पर प्रॉम्प्ट दिखाता है, और आउटपुट लौटाता है।

आरेख (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (UI ऑटोमेशन)

- UI ऑटोमेशन एक अलग UNIX सॉकेट का उपयोग करता है जिसका नाम `bridge.sock` है और PeekabooBridge JSON प्रोटोकॉल।
- होस्ट वरीयता क्रम (क्लाइंट-साइड): Peekaboo.app → Claude.app → OpenClaw.app → स्थानीय निष्पादन।
- सुरक्षा: ब्रिज होस्ट्स के लिए एक अनुमत TeamID आवश्यक है; DEBUG-केवल same-UID एस्केप हैच `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (Peekaboo परंपरा) द्वारा संरक्षित है।
- विवरण के लिए देखें: [PeekabooBridge usage](/platforms/mac/peekaboo)।

## परिचालन प्रवाह

- Restart/rebuild: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - मौजूदा इंस्टेंस को समाप्त करता है
  - Swift बिल्ड + पैकेज
  - LaunchAgent को लिखता/बूटस्ट्रैप/किकस्टार्ट करता है
- एकल इंस्टेंस: यदि समान बंडल ID वाला कोई अन्य इंस्टेंस चल रहा हो तो ऐप प्रारंभ में ही बाहर निकल जाता है।

## हार्डनिंग नोट्स

- सभी विशेषाधिकारयुक्त सतहों के लिए TeamID मिलान की आवश्यकता को प्राथमिकता दें।
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (केवल DEBUG) स्थानीय विकास के लिए same-UID कॉलर्स की अनुमति दे सकता है।
- सभी संचार केवल स्थानीय रहते हैं; कोई नेटवर्क सॉकेट उजागर नहीं किए जाते।
- TCC प्रॉम्प्ट केवल GUI ऐप बंडल से उत्पन्न होते हैं; पुनर्निर्माणों के बीच साइन किया हुआ बंडल ID स्थिर रखें।
- IPC हार्डनिंग: सॉकेट मोड `0600`, टोकन, peer-UID जाँच, HMAC चैलेंज/रिस्पॉन्स, छोटा TTL।
