---
summary: "npm + macOS ऐप के लिए चरण-दर-चरण रिलीज़ चेकलिस्ट"
read_when:
  - नया npm रिलीज़ काटते समय
  - नया macOS ऐप रिलीज़ काटते समय
  - प्रकाशित करने से पहले मेटाडेटा सत्यापित करते समय
---

# रिलीज़ चेकलिस्ट (npm + macOS)

Use `pnpm` (Node 22+) from the repo root. टैग/पब्लिश करने से पहले वर्किंग ट्री को साफ रखें।

## ऑपरेटर ट्रिगर

जब ऑपरेटर “release” कहे, तो तुरंत यह प्रीफ़्लाइट करें (जब तक अवरुद्ध न हों, अतिरिक्त प्रश्न न पूछें):

- इस दस्तावेज़ और `docs/platforms/mac/release.md` को पढ़ें।
- `~/.profile` से env लोड करें और पुष्टि करें कि `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect वेरिएबल्स सेट हैं (SPARKLE_PRIVATE_KEY_FILE को `~/.profile` में होना चाहिए)।
- आवश्यकता होने पर `~/Library/CloudStorage/Dropbox/Backup/Sparkle` से Sparkle कुंजियों का उपयोग करें।

1. **संस्करण एवं मेटाडेटा**

- [ ] `package.json` संस्करण बढ़ाएँ (उदा., `2026.1.29`)।
- [ ] एक्सटेंशन पैकेज संस्करणों + चेंजलॉग्स को संरेखित करने के लिए `pnpm plugins:sync` चलाएँ।
- [ ] CLI/संस्करण स्ट्रिंग्स अपडेट करें: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) और [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts) में Baileys यूज़र एजेंट।
- [ ] पैकेज मेटाडेटा (name, description, repository, keywords, license) की पुष्टि करें और यह भी कि `bin` मैप `openclaw` के लिए [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) की ओर इशारा करता है।
- [ ] यदि निर्भरताएँ बदली हैं, तो `pnpm install` चलाएँ ताकि `pnpm-lock.yaml` अद्यतन रहे।

2. **बिल्ड एवं आर्टिफ़ैक्ट्स**

- [ ] यदि A2UI इनपुट बदले हैं, तो `pnpm canvas:a2ui:bundle` चलाएँ और किसी भी अद्यतन [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js) को कमिट करें।
- [ ] `pnpm run build` (यह `dist/` को पुनः उत्पन्न करता है)।
- [ ] सत्यापित करें कि npm पैकेज `files` में सभी आवश्यक `dist/*` फ़ोल्डर शामिल हैं (विशेष रूप से हेडलेस नोड + ACP CLI के लिए `dist/node-host/**` और `dist/acp/**`)।
- [ ] पुष्टि करें कि `dist/build-info.json` मौजूद है और इसमें अपेक्षित `commit` हैश शामिल है (CLI बैनर npm इंस्टॉल के लिए इसका उपयोग करता है)।
- [ ] वैकल्पिक: बिल्ड के बाद `npm pack --pack-destination /tmp`; टारबॉल की सामग्री का निरीक्षण करें और GitHub रिलीज़ के लिए इसे संभालकर रखें (इसे **कमिट न करें**)।

3. **चेंजलॉग एवं दस्तावेज़**

- [ ] `CHANGELOG.md` को उपयोगकर्ता-उन्मुख मुख्य बिंदुओं के साथ अपडेट करें (यदि फ़ाइल न हो तो बनाएँ); प्रविष्टियाँ संस्करण के अनुसार सख्ती से अवरोही रखें।
- [ ] सुनिश्चित करें कि README के उदाहरण/फ़्लैग वर्तमान CLI व्यवहार से मेल खाते हों (विशेषकर नए कमांड या विकल्प)।

4. **सत्यापन**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (या यदि कवरेज आउटपुट चाहिए तो `pnpm test:coverage`)
- [ ] `pnpm release:check` (npm pack सामग्री का सत्यापन)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker इंस्टॉल स्मोक टेस्ट, त्वरित मार्ग; रिलीज़ से पहले अनिवार्य)
  - यदि तत्काल पिछला npm रिलीज़ ज्ञात रूप से टूटा हुआ है, तो प्रीइंस्टॉल चरण के लिए `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` या `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` सेट करें।
- [ ] (वैकल्पिक) पूर्ण इंस्टॉलर स्मोक (नॉन-रूट + CLI कवरेज जोड़ता है): `pnpm test:install:smoke`
- [ ] (वैकल्पिक) इंस्टॉलर E2E (Docker, `curl -fsSL https://openclaw.ai/install.sh | bash` चलाता है, ऑनबोर्ड करता है, फिर वास्तविक टूल कॉल्स चलाता है):
  - `pnpm test:install:e2e:openai` (इसके लिए `OPENAI_API_KEY` आवश्यक)
  - `pnpm test:install:e2e:anthropic` (इसके लिए `ANTHROPIC_API_KEY` आवश्यक)
  - `pnpm test:install:e2e` (दोनों कुंजियाँ आवश्यक; दोनों प्रदाता चलाता है)
- [ ] (वैकल्पिक) यदि आपके परिवर्तन सेंड/रिसीव पाथ को प्रभावित करते हैं, तो वेब Gateway का स्पॉट-चेक करें।

5. **macOS ऐप (Sparkle)**

- [ ] macOS ऐप को बिल्ड + साइन करें, फिर वितरण के लिए ज़िप करें।
- [ ] Sparkle ऐपकास्ट उत्पन्न करें (HTML नोट्स [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh) के माध्यम से) और `appcast.xml` अपडेट करें।
- [ ] GitHub रिलीज़ से संलग्न करने के लिए ऐप ज़िप (और वैकल्पिक dSYM ज़िप) तैयार रखें।
- [ ] सटीक कमांड्स और आवश्यक env वेरिएबल्स के लिए [macOS release](/platforms/mac/release) का पालन करें।
  - `APP_BUILD` संख्यात्मक + मोनोटोनिक होना चाहिए (कोई `-beta` नहीं) ताकि Sparkle संस्करणों की सही तुलना कर सके।
  - यदि नोटराइज़ कर रहे हैं, तो App Store Connect API env वेरिएबल्स से बनाए गए `openclaw-notary` कीचेन प्रोफ़ाइल का उपयोग करें (देखें [macOS release](/platforms/mac/release))।

6. **प्रकाशित करें (npm)**

- [ ] पुष्टि करें कि git स्थिति साफ़ है; आवश्यकता अनुसार कमिट और पुश करें।
- [ ] आवश्यकता होने पर `npm login` (2FA सत्यापित करें)।
- [ ] `npm publish --access public` (प्री-रिलीज़ के लिए `--tag beta` का उपयोग करें)।
- [ ] रजिस्ट्री सत्यापित करें: `npm view openclaw version`, `npm view openclaw dist-tags`, और `npx -y openclaw@X.Y.Z --version` (या `--help`)।

### समस्या-निवारण (2.0.0-beta2 रिलीज़ से नोट्स)

- **npm pack/publish अटक जाता है या बहुत बड़ा टारबॉल बनाता है**: `dist/OpenClaw.app` में मौजूद macOS ऐप बंडल (और रिलीज़ ज़िप्स) पैकेज में शामिल हो जाते हैं। `package.json` के `files` के ज़रिये पब्लिश सामग्री को व्हाइटलिस्ट करके ठीक करें (dist सबडायरेक्टरीज़, docs, skills शामिल करें; ऐप बंडल्स को बाहर रखें)। `npm pack --dry-run` से पुष्टि करें कि `dist/OpenClaw.app` सूचीबद्ध नहीं है।
- **dist-tags के लिए npm auth web लूप**: OTP प्रॉम्प्ट पाने के लिए लेगेसी auth का उपयोग करें:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx` सत्यापन `ECOMPROMISED: Lock compromised` के साथ विफल**: ताज़ा कैश के साथ पुनः प्रयास करें:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **देर से किए गए फ़िक्स के बाद टैग को रीपॉइंट करना आवश्यक**: टैग को फ़ोर्स-अपडेट करें और पुश करें, फिर सुनिश्चित करें कि GitHub रिलीज़ एसेट्स अभी भी मेल खाते हों:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub रिलीज़ + ऐपकास्ट**

- [ ] टैग करें और पुश करें: `git tag vX.Y.Z && git push origin vX.Y.Z` (या `git push --tags`)।
- [ ] `vX.Y.Z` के लिए GitHub रिलीज़ बनाएँ/रीफ़्रेश करें, **शीर्षक `openclaw X.Y.Z`** के साथ (सिर्फ़ टैग नहीं); बॉडी में उस संस्करण का **पूरा** चेंजलॉग सेक्शन (Highlights + Changes + Fixes) इनलाइन शामिल होना चाहिए (कोई खाली लिंक नहीं), और **बॉडी के अंदर शीर्षक दोहराया नहीं जाना चाहिए**।
- [ ] आर्टिफ़ैक्ट्स संलग्न करें: `npm pack` टारबॉल (वैकल्पिक), `OpenClaw-X.Y.Z.zip`, और `OpenClaw-X.Y.Z.dSYM.zip` (यदि उत्पन्न हुआ हो)।
- [ ] अद्यतन `appcast.xml` को कमिट करें और पुश करें (Sparkle main से फ़ीड करता है)।
- [ ] एक साफ़ अस्थायी डायरेक्टरी से (कोई `package.json` नहीं), इंस्टॉल/CLI एंट्रीपॉइंट्स के काम करने की पुष्टि के लिए `npx -y openclaw@X.Y.Z send --help` चलाएँ।
- [ ] रिलीज़ नोट्स की घोषणा/साझा करें।

## प्लगइन पब्लिश स्कोप (npm)

हम केवल **मौजूदा npm प्लगइन्स** को `@openclaw/*` स्कोप के तहत पब्लिश करते हैं। बंडल्ड
प्लगइन्स जो npm पर नहीं हैं, वे **केवल डिस्क-ट्री** में रहते हैं (फिर भी `extensions/**` में शिप किए जाते हैं)।

सूची निकालने की प्रक्रिया:

1. `npm search @openclaw --json` चलाएँ और पैकेज नाम कैप्चर करें।
2. `extensions/*/package.json` नामों से तुलना करें।
3. केवल **इंटरसेक्शन** (जो पहले से npm पर हैं) प्रकाशित करें।

वर्तमान npm प्लगइन सूची (आवश्यकतानुसार अपडेट करें):

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

रिलीज़ नोट्स में **नए वैकल्पिक बंडल्ड प्लगइन्स** का भी उल्लेख होना चाहिए जो **डिफ़ॉल्ट रूप से सक्षम नहीं** हैं (उदाहरण: `tlon`)।
