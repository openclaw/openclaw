---
summary: "संदर्भ: प्रदाता-विशिष्ट ट्रांसक्रिप्ट सैनिटाइजेशन और मरम्मत नियम"
read_when:
  - आप ट्रांसक्रिप्ट संरचना से जुड़े प्रदाता अनुरोध अस्वीकरणों का डिबग कर रहे हों
  - आप ट्रांसक्रिप्ट सैनिटाइजेशन या टूल-कॉल मरम्मत लॉजिक बदल रहे हों
  - आप प्रदाताओं के बीच टूल-कॉल आईडी असंगतियों की जाँच कर रहे हों
title: "ट्रांसक्रिप्ट स्वच्छता"
---

# ट्रांसक्रिप्ट स्वच्छता (प्रदाता सुधार)

यह दस्तावेज़ रन से पहले ट्रांसक्रिप्ट्स पर लागू किए गए **प्रोवाइडर-विशिष्ट सुधारों** का वर्णन करता है
(मॉडल कॉन्टेक्स्ट बनाना)। These are **in-memory** adjustments used to satisfy strict
provider requirements. These hygiene steps do **not** rewrite the stored JSONL transcript
on disk; however, a separate session-file repair pass may rewrite malformed JSONL files
by dropping invalid lines before the session is loaded. When a repair occurs, the original
file is backed up alongside the session file.

दायरे में शामिल हैं:

- टूल कॉल आईडी सैनिटाइजेशन
- टूल कॉल इनपुट सत्यापन
- टूल परिणाम युग्मन की मरम्मत
- टर्न सत्यापन / क्रम निर्धारण
- विचार हस्ताक्षर (thought signature) की सफ़ाई
- इमेज पेलोड सैनिटाइजेशन

यदि आपको ट्रांसक्रिप्ट भंडारण के विवरण चाहिए, तो देखें:

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## यह कहाँ चलता है

सारी ट्रांसक्रिप्ट स्वच्छता एम्बेडेड रनर में केंद्रीकृत है:

- नीति चयन: `src/agents/transcript-policy.ts`
- सैनिटाइजेशन/मरम्मत का अनुप्रयोग: `sanitizeSessionHistory` में `src/agents/pi-embedded-runner/google.ts`

यह नीति `provider`, `modelApi`, और `modelId` का उपयोग करके तय करती है कि क्या लागू करना है।

ट्रांसक्रिप्ट स्वच्छता से अलग, सत्र फ़ाइलों को लोड से पहले (यदि आवश्यक हो) मरम्मत किया जाता है:

- `repairSessionFileIfNeeded` में `src/agents/session-file-repair.ts`
- `run/attempt.ts` और `compact.ts` (एम्बेडेड रनर) से कॉल किया जाता है

---

## वैश्विक नियम: इमेज सैनिटाइजेशन

प्रदाता-पक्षीय अस्वीकरण को आकार सीमाओं के कारण रोकने के लिए इमेज पेलोड हमेशा सैनिटाइज किए जाते हैं
(अत्यधिक बड़े base64 इमेज को डाउनस्केल/रीकम्प्रेस करना)।

इम्प्लीमेंटेशन:

- `sanitizeSessionMessagesImages` में `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` में `src/agents/tool-images.ts`

---

## वैश्विक नियम: विकृत टूल कॉल

Assistant tool-call blocks that are missing both `input` and `arguments` are dropped
before model context is built. This prevents provider rejections from partially
persisted tool calls (for example, after a rate limit failure).

इम्प्लीमेंटेशन:

- `sanitizeToolCallInputs` में `src/agents/session-transcript-repair.ts`
- `sanitizeSessionHistory` में `src/agents/pi-embedded-runner/google.ts` पर लागू

---

## प्रदाता मैट्रिक्स (वर्तमान व्यवहार)

**OpenAI / OpenAI Codex**

- केवल इमेज सैनिटाइजेशन।
- OpenAI Responses/Codex में मॉडल स्विच पर, अनाथ reasoning हस्ताक्षर हटाए जाते हैं (वे standalone reasoning आइटम जिनके बाद कोई content ब्लॉक नहीं होता)।
- टूल कॉल आईडी सैनिटाइजेशन नहीं।
- टूल परिणाम युग्मन की मरम्मत नहीं।
- टर्न सत्यापन या पुनःक्रमण नहीं।
- सिंथेटिक टूल परिणाम नहीं।
- thought signature स्ट्रिपिंग नहीं।

**Google (Generative AI / Gemini CLI / Antigravity)**

- टूल कॉल आईडी सैनिटाइजेशन: सख्त अल्फ़ान्यूमेरिक।
- टूल परिणाम युग्मन की मरम्मत और सिंथेटिक टूल परिणाम।
- टर्न सत्यापन (Gemini-शैली टर्न वैकल्पन)।
- Google टर्न ऑर्डरिंग सुधार (यदि इतिहास असिस्टेंट से शुरू होता है तो एक छोटा user bootstrap जोड़ना)।
- Antigravity Claude: thinking हस्ताक्षरों को सामान्यीकृत करना; बिना हस्ताक्षर वाले thinking ब्लॉक हटाना।

**Anthropic / Minimax (Anthropic-संगत)**

- टूल परिणाम युग्मन की मरम्मत और सिंथेटिक टूल परिणाम।
- टर्न सत्यापन (सख्त वैकल्पन को संतुष्ट करने के लिए लगातार user टर्न को मर्ज करना)।

**Mistral (मॉडल-आईडी आधारित पहचान सहित)**

- टूल कॉल आईडी सैनिटाइजेशन: strict9 (अल्फ़ान्यूमेरिक लंबाई 9)।

**OpenRouter Gemini**

- thought signature की सफ़ाई: गैर-base64 `thought_signature` मानों को हटाना (base64 को बनाए रखना)।

**अन्य सभी**

- केवल इमेज सैनिटाइजेशन।

---

## ऐतिहासिक व्यवहार (2026.1.22 से पहले)

2026.1.22 रिलीज़ से पहले, OpenClaw ने ट्रांसक्रिप्ट स्वच्छता की कई परतें लागू की थीं:

- एक **transcript-sanitize extension** हर संदर्भ निर्माण पर चलता था और यह कर सकता था:
  - टूल उपयोग/परिणाम युग्मन की मरम्मत।
  - टूल कॉल आईडी को सैनिटाइज करना (एक गैर-सख्त मोड सहित जो `_`/`-` को संरक्षित करता था)।
- रनर ने भी प्रदाता-विशिष्ट सैनिटाइजेशन किया, जिससे काम की पुनरावृत्ति हुई।
- प्रदाता नीति के बाहर अतिरिक्त म्यूटेशन हुए, जिनमें शामिल थे:
  - स्थायित्व से पहले असिस्टेंट टेक्स्ट से `<final>` टैग हटाना।
  - खाली असिस्टेंट त्रुटि टर्न हटाना।
  - टूल कॉल के बाद असिस्टेंट सामग्री को ट्रिम करना।

This complexity caused cross-provider regressions (notably `openai-responses`
`call_id|fc_id` pairing). The 2026.1.22 cleanup removed the extension, centralized
logic in the runner, and made OpenAI **no-touch** beyond image sanitization.
