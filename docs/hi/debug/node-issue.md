---
summary: Node + tsx "__name is not a function" क्रैश के नोट्स और वैकल्पिक उपाय
read_when:
  - केवल Node वाले dev स्क्रिप्ट्स या watch मोड विफलताओं का डिबग करते समय
  - OpenClaw में tsx/esbuild लोडर क्रैश की जाँच करते समय
title: "Node + tsx क्रैश"
---

# Node + tsx "\_\_name is not a function" क्रैश

## सारांश

Node के साथ OpenClaw चलाने पर `tsx` के साथ स्टार्टअप में विफलता होती है और यह दिखाता है:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

12. यह dev scripts को Bun से `tsx` पर स्विच करने के बाद शुरू हुआ (commit `2871657e`, 2026-01-06)। 13. वही runtime path Bun के साथ काम करता था।

## परिवेश

- Node: v25.x (v25.3.0 पर देखा गया)
- tsx: 4.21.0
- OS: macOS (Node 25 चलाने वाले अन्य प्लेटफ़ॉर्म पर भी पुनरुत्पादन संभव)

## पुनरुत्पादन (केवल Node)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## रिपॉज़िटरी में न्यूनतम पुनरुत्पादन

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node संस्करण जाँच

- Node 25.3.0: विफल
- Node 22.22.0 (Homebrew `node@22`): विफल
- Node 24: यहाँ अभी इंस्टॉल नहीं; सत्यापन आवश्यक

## नोट्स / परिकल्पना

- 14. `tsx` TS/ESM को transform करने के लिए esbuild का उपयोग करता है। 15. esbuild का `keepNames` एक `__name` helper emit करता है और function definitions को `__name(...)` के साथ wrap करता है।
- क्रैश यह दर्शाता है कि रनटाइम पर `__name` मौजूद है लेकिन फ़ंक्शन नहीं है, जिसका अर्थ है कि Node 25 लोडर पथ में इस मॉड्यूल के लिए हेल्पर गायब है या ओवरराइट हो गया है।
- ऐसे ही `__name` हेल्पर से जुड़े मुद्दे अन्य esbuild उपभोक्ताओं में भी रिपोर्ट हुए हैं, जब हेल्पर गायब हो जाता है या पुनर्लेखित हो जाता है।

## रिग्रेशन इतिहास

- `2871657e` (2026-01-06): Bun को वैकल्पिक बनाने के लिए स्क्रिप्ट्स को Bun से tsx में बदला गया।
- उससे पहले (Bun पथ), `openclaw status` और `gateway:watch` काम कर रहे थे।

## वैकल्पिक उपाय

- dev स्क्रिप्ट्स के लिए Bun का उपयोग करें (वर्तमान अस्थायी रिवर्ट)।

- Node + tsc watch का उपयोग करें, फिर संकलित आउटपुट चलाएँ:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- स्थानीय रूप से पुष्टि की गई: Node 25 पर `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` काम करता है।

- यदि संभव हो तो TS लोडर में esbuild keepNames को अक्षम करें (यह `__name` हेल्पर के सम्मिलन को रोकता है); tsx वर्तमान में इसे एक्सपोज़ नहीं करता।

- Node LTS (22/24) को `tsx` के साथ परीक्षण करें ताकि पता चले कि यह समस्या केवल Node 25 तक सीमित है या नहीं।

## संदर्भ

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## अगले कदम

- Node 22/24 पर पुनरुत्पादन करके Node 25 रिग्रेशन की पुष्टि करें।
- `tsx` नाइटली का परीक्षण करें या यदि कोई ज्ञात रिग्रेशन हो तो पहले के संस्करण पर पिन करें।
- यदि Node LTS पर भी पुनरुत्पादन होता है, तो `__name` स्टैक ट्रेस के साथ एक न्यूनतम पुनरुत्पादन upstream में फ़ाइल करें।
