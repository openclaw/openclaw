---
summary: "OpenClaw macOS रिलीज़ चेकलिस्ट (Sparkle फ़ीड, पैकेजिंग, साइनिंग)"
read_when:
  - OpenClaw macOS रिलीज़ को काटते या सत्यापित करते समय
  - Sparkle ऐपकास्ट या फ़ीड एसेट्स को अपडेट करते समय
title: "macOS रिलीज़"
x-i18n:
  source_path: platforms/mac/release.md
  source_hash: 98d6640ae4ea9cc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:31Z
---

# OpenClaw macOS रिलीज़ (Sparkle)

यह ऐप अब Sparkle ऑटो-अपडेट्स के साथ शिप होता है। रिलीज़ बिल्ड्स को Developer ID से साइन किया जाना चाहिए, ज़िप किया जाना चाहिए, और साइन किए गए ऐपकास्ट एंट्री के साथ प्रकाशित किया जाना चाहिए।

## पूर्वापेक्षाएँ

- Developer ID Application प्रमाणपत्र इंस्टॉल हो (उदाहरण: `Developer ID Application: <Developer Name> (<TEAMID>)`)।
- Sparkle निजी कुंजी का पथ पर्यावरण में `SPARKLE_PRIVATE_KEY_FILE` के रूप में सेट हो (आपकी Sparkle ed25519 निजी कुंजी का पथ; सार्वजनिक कुंजी Info.plist में एम्बेडेड होती है)। यदि यह गायब है, तो `~/.profile` जाँचें।
- यदि आप Gatekeeper-सुरक्षित DMG/zip वितरण चाहते हैं, तो `xcrun notarytool` के लिए Notary क्रेडेंशियल्स (कीचेन प्रोफ़ाइल या API कुंजी)।
  - हम `openclaw-notary` नाम की Keychain प्रोफ़ाइल का उपयोग करते हैं, जो आपके शेल प्रोफ़ाइल में App Store Connect API कुंजी पर्यावरण चरों से बनाई गई है:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- `pnpm` निर्भरताएँ इंस्टॉल हों (`pnpm install --config.node-linker=hoisted`)।
- Sparkle टूल्स SwiftPM के माध्यम से `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` पर स्वचालित रूप से फ़ेच होते हैं (`sign_update`, `generate_appcast`, आदि)।

## बिल्ड और पैकेज

टिप्पणियाँ:

- `APP_BUILD` का मैपिंग `CFBundleVersion`/`sparkle:version` से होता है; इसे संख्यात्मक और मोनोटोनिक रखें (`-beta` नहीं), अन्यथा Sparkle इसे समान के रूप में तुलना करता है।
- डिफ़ॉल्ट रूप से वर्तमान आर्किटेक्चर (`$(uname -m)`) का उपयोग होता है। रिलीज़/यूनिवर्सल बिल्ड्स के लिए `BUILD_ARCHS="arm64 x86_64"` सेट करें (या `BUILD_ARCHS=all`)।
- रिलीज़ आर्टिफ़ैक्ट्स (zip + DMG + नोटराइज़ेशन) के लिए `scripts/package-mac-dist.sh` का उपयोग करें। लोकल/डेव पैकेजिंग के लिए `scripts/package-mac-app.sh` का उपयोग करें।

```bash
# From repo root; set release IDs so Sparkle feed is enabled.
# APP_BUILD must be numeric + monotonic for Sparkle compare.
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.6 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# Zip for distribution (includes resource forks for Sparkle delta support)
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.6.zip

# Optional: also build a styled DMG for humans (drag to /Applications)
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.6.dmg

# Recommended: build + notarize/staple zip + DMG
# First, create a keychain profile once:
#   xcrun notarytool store-credentials "openclaw-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.6 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

# Optional: ship dSYM alongside the release
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.2.6.dSYM.zip
```

## ऐपकास्ट एंट्री

Sparkle द्वारा फ़ॉर्मैटेड HTML नोट्स रेंडर करने के लिए रिलीज़ नोट जेनरेटर का उपयोग करें:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

यह `CHANGELOG.md` से HTML रिलीज़ नोट्स जेनरेट करता है ([`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh) के माध्यम से) और उन्हें ऐपकास्ट एंट्री में एम्बेड करता है।
प्रकाशन के समय अपडेट किए गए `appcast.xml` को रिलीज़ एसेट्स (zip + dSYM) के साथ कमिट करें।

## प्रकाशित करें और सत्यापित करें

- टैग `v2026.2.6` के लिए GitHub रिलीज़ में `OpenClaw-2026.2.6.zip` (और `OpenClaw-2026.2.6.dSYM.zip`) अपलोड करें।
- सुनिश्चित करें कि रॉ ऐपकास्ट URL बेक्ड फ़ीड से मेल खाता है: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`।
- सैनीटी जाँच:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` 200 लौटाता है।
  - एसेट्स अपलोड के बाद `curl -I <enclosure url>` 200 लौटाता है।
  - किसी पिछले सार्वजनिक बिल्ड पर, About टैब से “Check for Updates…” चलाएँ और सत्यापित करें कि Sparkle नया बिल्ड साफ़-सुथरे तरीके से इंस्टॉल करता है।

पूर्णता की परिभाषा: साइन किया हुआ ऐप + ऐपकास्ट प्रकाशित हों, पुराने इंस्टॉल किए गए संस्करण से अपडेट फ़्लो काम करे, और रिलीज़ एसेट्स GitHub रिलीज़ से संलग्न हों।
