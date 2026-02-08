---
summary: "पैकेजिंग स्क्रिप्ट्स द्वारा उत्पन्न macOS डिबग बिल्ड्स के लिए साइनिंग चरण"
read_when:
  - mac डिबग बिल्ड्स का निर्माण या साइनिंग करते समय
title: "macOS साइनिंग"
x-i18n:
  source_path: platforms/mac/signing.md
  source_hash: 403b92f9a0ecdb7c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:33Z
---

# mac साइनिंग (डिबग बिल्ड्स)

यह ऐप आम तौर पर [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) से बनाया जाता है, जो अब:

- एक स्थिर डिबग बंडल आइडेंटिफ़ायर सेट करता है: `ai.openclaw.mac.debug`
- उसी बंडल आईडी के साथ Info.plist लिखता है ( `BUNDLE_ID=...` के माध्यम से ओवरराइड करें)
- मुख्य बाइनरी और ऐप बंडल को साइन करने के लिए [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) को कॉल करता है, ताकि macOS हर रीबिल्ड को उसी साइन किए गए बंडल के रूप में माने और TCC अनुमतियाँ (नोटिफ़िकेशन, एक्सेसिबिलिटी, स्क्रीन रिकॉर्डिंग, माइक्रोफ़ोन, स्पीच) बनाए रखे। स्थिर अनुमतियों के लिए वास्तविक साइनिंग आइडेंटिटी का उपयोग करें; ad-hoc वैकल्पिक है और नाज़ुक है (देखें [macOS permissions](/platforms/mac/permissions)).
- डिफ़ॉल्ट रूप से `CODESIGN_TIMESTAMP=auto` का उपयोग करता है; यह Developer ID सिग्नेचर्स के लिए विश्वसनीय टाइमस्टैम्प सक्षम करता है। टाइमस्टैम्पिंग छोड़ने के लिए (ऑफ़लाइन डिबग बिल्ड्स) `CODESIGN_TIMESTAMP=off` सेट करें।
- Info.plist में बिल्ड मेटाडेटा इंजेक्ट करता है: `OpenClawBuildTimestamp` (UTC) और `OpenClawGitCommit` (शॉर्ट हैश), ताकि About पैन बिल्ड, git, और डिबग/रिलीज़ चैनल दिखा सके।
- **पैकेजिंग के लिए Node 22+ आवश्यक है**: स्क्रिप्ट TS बिल्ड्स और Control UI बिल्ड चलाती है।
- पर्यावरण से `SIGN_IDENTITY` पढ़ता है। हमेशा अपने सर्टिफ़िकेट से साइन करने के लिए अपने शेल rc में `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (या आपका Developer ID Application cert) जोड़ें। ad-hoc साइनिंग के लिए `ALLOW_ADHOC_SIGNING=1` या `SIGN_IDENTITY="-"` के माध्यम से स्पष्ट opt-in आवश्यक है (अनुमति परीक्षण के लिए अनुशंसित नहीं)।
- साइनिंग के बाद Team ID ऑडिट चलाता है और यदि ऐप बंडल के भीतर कोई भी Mach-O किसी भिन्न Team ID से साइन हो तो विफल हो जाता है। बायपास करने के लिए `SKIP_TEAM_ID_CHECK=1` सेट करें।

## उपयोग

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Ad-hoc साइनिंग नोट

`SIGN_IDENTITY="-"` (ad-hoc) के साथ साइन करते समय, स्क्रिप्ट स्वचालित रूप से **Hardened Runtime** (`--options runtime`) को अक्षम कर देती है। यह आवश्यक है ताकि ऐप एम्बेडेड फ़्रेमवर्क्स (जैसे Sparkle) लोड करने का प्रयास करते समय क्रैश न करे, जो समान Team ID साझा नहीं करते। ad-hoc सिग्नेचर्स TCC अनुमति स्थायित्व को भी तोड़ देते हैं; रिकवरी चरणों के लिए [macOS permissions](/platforms/mac/permissions) देखें।

## About के लिए बिल्ड मेटाडेटा

`package-mac-app.sh` बंडल पर निम्न मुहर लगाता है:

- `OpenClawBuildTimestamp`: पैकेज समय पर ISO8601 UTC
- `OpenClawGitCommit`: शॉर्ट git हैश (या अनुपलब्ध होने पर `unknown`)

About टैब इन कुंजियों को पढ़कर संस्करण, बिल्ड तिथि, git कमिट, और यह कि क्या यह डिबग बिल्ड है ( `#if DEBUG` के माध्यम से) दिखाता है। कोड परिवर्तन के बाद इन मानों को ताज़ा करने के लिए पैकेजर चलाएँ।

## क्यों

TCC अनुमतियाँ बंडल आइडेंटिफ़ायर _और_ कोड सिग्नेचर से जुड़ी होती हैं। बदलते UUIDs के साथ असाइन किए गए डिबग बिल्ड्स macOS को हर रीबिल्ड के बाद अनुदान भूलने का कारण बन रहे थे। बाइनरीज़ को साइन करना (डिफ़ॉल्ट रूप से ad-hoc) और एक स्थिर बंडल आईडी/पाथ (`dist/OpenClaw.app`) बनाए रखना, बिल्ड्स के बीच अनुदानों को संरक्षित करता है, जो VibeTunnel दृष्टिकोण से मेल खाता है।
