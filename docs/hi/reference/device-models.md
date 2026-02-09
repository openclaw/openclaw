---
summary: "macOS ऐप में उपयोगकर्ता‑अनुकूल नामों के लिए OpenClaw किस प्रकार Apple डिवाइस मॉडल पहचानकर्ताओं को प्रदान करता है।"
read_when:
  - डिवाइस मॉडल पहचानकर्ता मैपिंग या NOTICE/लाइसेंस फ़ाइलों को अपडेट करते समय
  - Instances UI डिवाइस नामों को कैसे प्रदर्शित करता है, इसमें परिवर्तन करते समय
title: "डिवाइस मॉडल डेटाबेस"
---

# डिवाइस मॉडल डेटाबेस (उपयोगकर्ता‑अनुकूल नाम)

आज दो पैटर्न उपयोग में हैं।

यह मैपिंग JSON के रूप में यहाँ vendored है:

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## डेटा स्रोत

वर्तमान में हम MIT‑लाइसेंस प्राप्त रिपॉज़िटरी से मैपिंग vendor करते हैं:

- `kyle-seongwoo-jun/apple-device-identifiers`

बिल्ड को निर्धारक रखने के लिए, JSON फ़ाइलें विशिष्ट upstream कमिट्स पर पिन की जाती हैं (जो `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` में दर्ज हैं)।

## डेटाबेस अपडेट करना

1. जिन upstream कमिट्स पर आप पिन करना चाहते हैं, उन्हें चुनें (एक iOS के लिए, एक macOS के लिए)।
2. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` में कमिट हैश अपडेट करें।
3. उन कमिट्स पर पिन की गई JSON फ़ाइलें फिर से डाउनलोड करें:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. सुनिश्चित करें कि `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` अभी भी upstream से मेल खाता है (यदि upstream लाइसेंस बदलता है तो उसे बदलें)।
5. सत्यापित करें कि macOS ऐप साफ़ तरीके से बिल्ड होता है (कोई चेतावनी नहीं):

```bash
swift build --package-path apps/macos
```
