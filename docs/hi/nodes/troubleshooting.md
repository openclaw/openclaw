---
summary: "नोड पेयरिंग, फ़ोरग्राउंड आवश्यकताओं, अनुमतियों और टूल विफलताओं का समस्या‑निवारण"
read_when:
  - नोड कनेक्टेड है लेकिन कैमरा/कैनवास/स्क्रीन/exec टूल विफल होते हैं
  - आपको नोड पेयरिंग बनाम अनुमोदनों का मानसिक मॉडल चाहिए
title: "नोड समस्या‑निवारण"
---

# नोड समस्या‑निवारण

जब किसी नोड की स्थिति में वह दिखाई दे रहा हो लेकिन नोड टूल विफल हो रहे हों, तब इस पृष्ठ का उपयोग करें।

## कमांड सीढ़ी

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

फिर नोड‑विशिष्ट जाँचें चलाएँ:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

स्वस्थ संकेत:

- नोड कनेक्टेड है और भूमिका `node` के लिए पेयर्ड है।
- `nodes describe` में वह क्षमता शामिल है जिसे आप कॉल कर रहे हैं।
- Exec अनुमोदन अपेक्षित मोड/allowlist दिखाते हैं।

## फ़ोरग्राउंड आवश्यकताएँ

iOS/Android नोड्स पर `canvas.*`, `camera.*`, और `screen.*` केवल फ़ोरग्राउंड में काम करते हैं।

त्वरित जाँच और समाधान:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

यदि आपको `NODE_BACKGROUND_UNAVAILABLE` दिखाई दे, तो नोड ऐप को फ़ोरग्राउंड में लाएँ और पुनः प्रयास करें।

## अनुमतियाँ मैट्रिक्स

| क्षमता                       | iOS                                                        | Android                                                       | macOS नोड ऐप                                         | सामान्य विफलता कोड             |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | कैमरा (+ क्लिप ऑडियो के लिए माइक)       | कैमरा (+ क्लिप ऑडियो के लिए माइक)          | कैमरा (+ क्लिप ऑडियो के लिए माइक) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | स्क्रीन रिकॉर्डिंग (+ माइक वैकल्पिक)    | स्क्रीन कैप्चर प्रॉम्प्ट (+ माइक वैकल्पिक) | स्क्रीन रिकॉर्डिंग                                   | `*_PERMISSION_REQUIRED`        |
| `location.get`               | उपयोग के दौरान या हमेशा (मोड पर निर्भर) | मोड के आधार पर फ़ोरग्राउंड/बैकग्राउंड लोकेशन                  | लोकेशन अनुमति                                        | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | लागू नहीं (नोड होस्ट पथ)                | लागू नहीं (नोड होस्ट पथ)                   | Exec अनुमोदन आवश्यक                                  | `SYSTEM_RUN_DENIED`            |

## पेयरिंग बनाम अनुमोदन

ये अलग‑अलग गेट हैं:

1. **डिवाइस पेयरिंग**: क्या यह नोड Gateway से कनेक्ट हो सकता है?
2. **Exec अनुमोदन**: क्या यह नोड किसी विशिष्ट शेल कमांड को चला सकता है?

त्वरित जाँचें:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

यदि pairing ठीक है लेकिन `system.run` विफल होता है, तो exec approvals/allowlist ठीक करें।
Triggers को normalize किया जाता है (trim किए जाते हैं, खाली entries हटाई जाती हैं)।

## सामान्य नोड त्रुटि कोड

- `NODE_BACKGROUND_UNAVAILABLE` → ऐप बैकग्राउंड में है; इसे फ़ोरग्राउंड में लाएँ।
- `CAMERA_DISABLED` → नोड सेटिंग्स में कैमरा टॉगल अक्षम है।
- `*_PERMISSION_REQUIRED` → OS अनुमति अनुपलब्ध/अस्वीकृत।
- `LOCATION_DISABLED` → लोकेशन मोड बंद है।
- `LOCATION_PERMISSION_REQUIRED` → अनुरोधित लोकेशन मोड प्रदान नहीं किया गया।
- `LOCATION_BACKGROUND_UNAVAILABLE` → ऐप बैकग्राउंड में है लेकिन केवल “उपयोग के दौरान” अनुमति मौजूद है।
- `SYSTEM_RUN_DENIED: approval required` → exec अनुरोध के लिए स्पष्ट अनुमोदन आवश्यक है।
- `SYSTEM_RUN_DENIED: allowlist miss` → कमांड allowlist मोड द्वारा अवरुद्ध है।

## त्वरित पुनर्प्राप्ति लूप

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

यदि फिर भी अटके हों:

- डिवाइस पेयरिंग को पुनः‑अनुमोदित करें।
- नोड ऐप को पुनः खोलें (फ़ोरग्राउंड)।
- OS अनुमतियाँ पुनः प्रदान करें।
- exec अनुमोदन नीति को पुनः बनाएँ/समायोजित करें।

संबंधित:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
