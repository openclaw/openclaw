---
summary: "Stable, beta, और dev चैनल: अर्थवत्ता, स्विचिंग, और टैगिंग"
read_when:
  - आप stable/beta/dev के बीच स्विच करना चाहते हैं
  - आप prereleases को टैग या प्रकाशित कर रहे हैं
title: "Development Channels"
---

# Development चैनल

अंतिम अपडेट: 2026-01-21

OpenClaw तीन अपडेट चैनल प्रदान करता है:

- **stable**: npm dist-tag `latest`.
- **beta**: npm dist-tag `beta` (परीक्षणाधीन बिल्ड).
- npm dist-tag: `dev` (जब publish किया जाता है)। Beta और dev builds में macOS ऐप रिलीज़ **शामिल न भी हो** सकती है।

हम बिल्ड **beta** में भेजते हैं, उनका परीक्षण करते हैं, फिर **जाँचे-परखे बिल्ड को `latest` में प्रमोट करते हैं**
बिना संस्करण संख्या बदले — npm इंस्टॉल के लिए dist-tags ही सत्य का स्रोत हैं।

## चैनल स्विच करना

Git checkout:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` नवीनतम मिलान टैग को checkout करता है (अक्सर वही टैग).
- `dev` `main` पर स्विच करता है और upstream पर rebase करता है।

npm/pnpm global install:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

यह संबंधित npm dist-tag (`latest`, `beta`, `dev`) के माध्यम से अपडेट करता है।

जब आप `--channel` के साथ **स्पष्ट रूप से** चैनल स्विच करते हैं, तो OpenClaw
इंस्टॉल विधि को भी संरेखित करता है:

- `dev` git checkout सुनिश्चित करता है (डिफ़ॉल्ट `~/openclaw`, `OPENCLAW_GIT_DIR` के साथ override),
  उसे अपडेट करता है, और उसी checkout से global CLI इंस्टॉल करता है।
- `stable`/`beta` मिलान dist-tag का उपयोग करके npm से इंस्टॉल करता है।

सुझाव: यदि आप stable + dev को समानांतर रखना चाहते हैं, तो दो clones रखें और अपने Gateway (गेटवे) को stable वाले की ओर निर्देशित करें।

## Plugins और चैनल

जब आप `openclaw update` के साथ चैनल स्विच करते हैं, तो OpenClaw plugin स्रोतों को भी sync करता है:

- `dev` git checkout से bundled plugins को प्राथमिकता देता है।
- `stable` और `beta` npm-इंस्टॉल किए गए plugin पैकेजों को पुनर्स्थापित करते हैं।

## टैगिंग की सर्वोत्तम प्रथाएँ

- जिन रिलीज़ पर आप git checkouts को लैंड कराना चाहते हैं, उन्हें टैग करें (`vYYYY.M.D` या `vYYYY.M.D-<patch>`)।
- टैग्स को immutable रखें: किसी टैग को कभी न स्थानांतरित करें और न ही पुनः उपयोग करें।
- npm dist-tags npm इंस्टॉल के लिए सत्य का स्रोत बने रहते हैं:
  - `latest` → stable
  - `beta` → candidate build
  - `dev` → main snapshot (वैकल्पिक)

## macOS ऐप उपलब्धता

यह ठीक है: Docker **optional** है।

- git टैग और npm dist-tag फिर भी प्रकाशित किए जा सकते हैं।
- रिलीज़ नोट्स या changelog में “इस beta के लिए कोई macOS बिल्ड नहीं” स्पष्ट रूप से उल्लेख करें।
