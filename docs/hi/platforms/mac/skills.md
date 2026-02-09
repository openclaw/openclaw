---
summary: "macOS के लिए Skills सेटिंग्स UI और Gateway-समर्थित स्थिति"
read_when:
  - macOS Skills सेटिंग्स UI को अपडेट करते समय
  - Skills गेटिंग या इंस्टॉल व्यवहार में बदलाव करते समय
title: "Skills"
---

# Skills (macOS)

macOS ऐप Gateway के माध्यम से OpenClaw Skills प्रस्तुत करता है; यह Skills को स्थानीय रूप से पार्स नहीं करता।

## Data source

- `skills.status` (gateway) सभी Skills के साथ पात्रता और अनुपस्थित आवश्यकताएँ लौटाता है
  (जिसमें बंडल किए गए Skills के लिए allowlist ब्लॉक्स शामिल हैं)।
- आवश्यकताएँ प्रत्येक `SKILL.md` में `metadata.openclaw.requires` से व्युत्पन्न की जाती हैं।

## Install actions

- `metadata.openclaw.install` इंस्टॉल विकल्पों (brew/node/go/uv) को परिभाषित करता है।
- ऐप Gateway होस्ट पर इंस्टॉलर चलाने के लिए `skills.install` को कॉल करता है।
- Gateway तब केवल एक पसंदीदा इंस्टॉलर प्रदर्शित करता है जब कई प्रदान किए गए हों
  (उपलब्ध होने पर brew, अन्यथा `skills.install` से node manager, डिफ़ॉल्ट npm)।

## Env/API keys

- The app stores keys in `~/.openclaw/openclaw.json` under `skills.entries.<skillKey>`.
- `skills.update` द्वारा `enabled`, `apiKey`, और `env` को पैच किया जाता है।

## Remote mode

- इंस्टॉल + विन्यास अपडेट Gateway होस्ट पर होते हैं (स्थानीय Mac पर नहीं)।
