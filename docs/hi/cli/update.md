---
summary: "CLI संदर्भ `openclaw update` के लिए (सुरक्षित-सा स्रोत अपडेट + Gateway का स्वचालित पुनःआरंभ)"
read_when:
  - आप किसी source checkout को सुरक्षित रूप से अपडेट करना चाहते हैं
  - आपको `--update` संक्षिप्त व्यवहार को समझने की आवश्यकता है
title: "update"
---

# `openclaw update`

OpenClaw को सुरक्षित रूप से अपडेट करें और stable/beta/dev चैनलों के बीच स्विच करें।

यदि आपने **npm/pnpm** के माध्यम से इंस्टॉल किया है (ग्लोबल इंस्टॉल, कोई git मेटाडेटा नहीं), तो अपडेट [Updating](/install/updating) में बताए गए पैकेज मैनेजर फ़्लो के माध्यम से होते हैं।

## Usage

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Options

- `--no-restart`: सफल अपडेट के बाद Gateway सेवा को पुनःआरंभ करना छोड़ें।
- `--channel <stable|beta|dev>`: अपडेट चैनल सेट करें (git + npm; विन्यास में स्थायी)।
- `--tag <dist-tag|version>`: केवल इस अपडेट के लिए npm dist-tag या संस्करण को ओवरराइड करें।
- `--json`: मशीन-पठनीय `UpdateRunResult` JSON प्रिंट करें।
- `--timeout <seconds>`: प्रति-चरण टाइमआउट (डिफ़ॉल्ट 1200s)।

Note: डाउनग्रेड के लिए पुष्टि आवश्यक है क्योंकि पुराने संस्करण विन्यास को तोड़ सकते हैं।

## `update status`

सक्रिय अपडेट चैनल + git टैग/ब्रांच/SHA (source checkouts के लिए) दिखाएँ, साथ ही अपडेट उपलब्धता भी।

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options:

- `--json`: मशीन-पठनीय स्थिति JSON प्रिंट करें।
- `--timeout <seconds>`: जाँच के लिए टाइमआउट (डिफ़ॉल्ट 3s)।

## `update wizard`

17. अपडेट चैनल चुनने और अपडेट के बाद Gateway को रीस्टार्ट करना है या नहीं इसकी पुष्टि करने के लिए इंटरैक्टिव फ़्लो (डिफ़ॉल्ट रीस्टार्ट है)। 18. यदि आप git checkout के बिना `dev` चुनते हैं, तो यह एक बनाने की पेशकश करता है।

## What it does

जब आप चैनल को स्पष्ट रूप से स्विच करते हैं (`--channel ...`), तो OpenClaw
इंस्टॉल विधि को भी संरेखित रखता है:

- `dev` → git checkout सुनिश्चित करता है (डिफ़ॉल्ट: `~/openclaw`, `OPENCLAW_GIT_DIR` के साथ ओवरराइड करें),
  उसे अपडेट करता है, और उसी checkout से ग्लोबल CLI इंस्टॉल करता है।
- `stable`/`beta` → मेल खाते dist-tag का उपयोग करके npm से इंस्टॉल करता है।

## Git checkout flow

Channels:

- `stable`: नवीनतम non-beta टैग checkout करें, फिर build + doctor।
- `beta`: नवीनतम `-beta` टैग checkout करें, फिर build + doctor।
- `dev`: `main` checkout करें, फिर fetch + rebase।

High-level:

1. साफ worktree की आवश्यकता है (कोई uncommitted परिवर्तन नहीं)।
2. चयनित चैनल (टैग या ब्रांच) पर स्विच करता है।
3. upstream से fetch करता है (केवल dev)।
4. केवल dev: temp worktree में preflight lint + TypeScript build; यदि tip विफल हो, तो नवीनतम साफ build खोजने के लिए 10 commits तक पीछे जाता है।
5. चयनित commit पर rebase करता है (केवल dev)।
6. निर्भरताएँ इंस्टॉल करता है (pnpm प्राथमिक; npm fallback)।
7. build करता है + Control UI build करता है।
8. अंतिम “safe update” जाँच के रूप में `openclaw doctor` चलाता है।
9. सक्रिय चैनल के साथ प्लगइन्स सिंक करता है (dev में bundled extensions; stable/beta में npm) और npm-इंस्टॉल किए गए प्लगइन्स को अपडेट करता है।

## `--update` shorthand

`openclaw --update` को `openclaw update` में पुनर्लिखित किया जाता है (shells और launcher scripts के लिए उपयोगी)।

## See also

- `openclaw doctor` (git checkouts पर पहले update चलाने की पेशकश करता है)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
