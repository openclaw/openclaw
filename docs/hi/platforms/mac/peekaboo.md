---
summary: "macOS UI स्वचालन के लिए PeekabooBridge एकीकरण"
read_when:
  - OpenClaw.app में PeekabooBridge होस्ट करना
  - Swift Package Manager के माध्यम से Peekaboo का एकीकरण
  - PeekabooBridge प्रोटोकॉल/पाथ बदलना
title: "Peekaboo ब्रिज"
x-i18n:
  source_path: platforms/mac/peekaboo.md
  source_hash: b5b9ddb9a7c59e15
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:32Z
---

# Peekaboo ब्रिज (macOS UI स्वचालन)

OpenClaw **PeekabooBridge** को एक स्थानीय, अनुमति‑सचेत UI स्वचालन
ब्रोकर के रूप में होस्ट कर सकता है। इससे `peekaboo` CLI
macOS ऐप की TCC अनुमतियों का पुन: उपयोग करते हुए UI स्वचालन को नियंत्रित कर सकता है।

## यह क्या है (और क्या नहीं है)

- **होस्ट**: OpenClaw.app, PeekabooBridge होस्ट के रूप में कार्य कर सकता है।
- **क्लाइंट**: `peekaboo` CLI का उपयोग करें (कोई अलग `openclaw ui ...` सतह नहीं)।
- **UI**: विज़ुअल ओवरले Peekaboo.app में ही रहते हैं; OpenClaw एक पतला ब्रोकर होस्ट है।

## ब्रिज सक्षम करें

macOS ऐप में:

- Settings → **Enable Peekaboo Bridge**

सक्षम होने पर, OpenClaw एक स्थानीय UNIX सॉकेट सर्वर शुरू करता है। यदि अक्षम किया गया,
तो होस्ट बंद हो जाता है और `peekaboo` अन्य उपलब्ध होस्ट्स पर फ़ॉलबैक करेगा।

## क्लाइंट डिस्कवरी क्रम

Peekaboo क्लाइंट सामान्यतः इस क्रम में होस्ट्स आज़माते हैं:

1. Peekaboo.app (पूर्ण UX)
2. Claude.app (यदि इंस्टॉल हो)
3. OpenClaw.app (पतला ब्रोकर)

कौन‑सा होस्ट सक्रिय है और कौन‑सा सॉकेट पाथ उपयोग में है, यह देखने के लिए `peekaboo bridge status --verbose` का उपयोग करें।
आप इसे निम्न के साथ ओवरराइड कर सकते हैं:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## सुरक्षा और अनुमतियाँ

- ब्रिज **कॉलर कोड सिग्नेचर** को सत्यापित करता है; TeamIDs की एक अनुमति‑सूची लागू होती है
  (Peekaboo होस्ट TeamID + OpenClaw ऐप TeamID)।
- अनुरोध ~10 सेकंड के बाद टाइम‑आउट हो जाते हैं।
- यदि आवश्यक अनुमतियाँ अनुपस्थित हैं, तो ब्रिज System Settings लॉन्च करने के बजाय
  एक स्पष्ट त्रुटि संदेश लौटाता है।

## स्नैपशॉट व्यवहार (स्वचालन)

स्नैपशॉट्स मेमोरी में संग्रहीत होते हैं और थोड़े समय बाद स्वचालित रूप से समाप्त हो जाते हैं।
यदि आपको अधिक समय तक रखने की आवश्यकता हो, तो क्लाइंट से पुनः कैप्चर करें।

## समस्या-निवारण

- यदि `peekaboo` “bridge client is not authorized” रिपोर्ट करता है, तो सुनिश्चित करें कि
  क्लाइंट सही तरीके से साइन किया गया है, या केवल **debug** मोड में
  `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` के साथ होस्ट चलाएँ।
- यदि कोई होस्ट नहीं मिलता है, तो होस्ट ऐप्स में से किसी एक (Peekaboo.app या OpenClaw.app)
  को खोलें और पुष्टि करें कि अनुमतियाँ प्रदान की गई हैं।
