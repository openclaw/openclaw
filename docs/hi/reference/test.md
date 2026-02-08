---
summary: "स्थानीय रूप से परीक्षण (vitest) कैसे चलाएँ और force/coverage मोड का उपयोग कब करें"
read_when:
  - परीक्षण चलाते या ठीक करते समय
title: "परीक्षण"
x-i18n:
  source_path: reference/test.md
  source_hash: 814cc52aae0788eb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:40Z
---

# परीक्षण

- पूर्ण परीक्षण किट (सूट्स, लाइव, Docker): [Testing](/help/testing)

- `pnpm test:force`: डिफ़ॉल्ट कंट्रोल पोर्ट को पकड़े हुए किसी भी शेष gateway प्रक्रिया को समाप्त करता है, फिर एक पृथक gateway पोर्ट के साथ पूरा Vitest सूट चलाता है ताकि सर्वर परीक्षण किसी चल रहे इंस्टेंस से टकराएँ नहीं। इसका उपयोग तब करें जब किसी पिछले gateway रन ने पोर्ट 18789 को व्यस्त छोड़ दिया हो।
- `pnpm test:coverage`: V8 कवरेज के साथ Vitest चलाता है। वैश्विक थ्रेशहोल्ड 70% lines/branches/functions/statements हैं। कवरेज में इंटीग्रेशन-भारी एंट्रीपॉइंट्स (CLI वायरिंग, gateway/telegram ब्रिज, webchat static server) शामिल नहीं हैं, ताकि लक्ष्य यूनिट-टेस्ट योग्य लॉजिक पर केंद्रित रहे।
- `pnpm test:e2e`: gateway एंड-टू-एंड स्मोक परीक्षण चलाता है (मल्टी-इंस्टेंस WS/HTTP/node पेयरिंग)।
- `pnpm test:live`: प्रदाता लाइव परीक्षण (minimax/zai) चलाता है। अनस्किप करने के लिए API कुंजियाँ और `LIVE=1` (या प्रदाता-विशिष्ट `*_LIVE_TEST=1`) आवश्यक हैं।

## मॉडल विलंबता बेंच (स्थानीय कुंजियाँ)

स्क्रिप्ट: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

उपयोग:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- वैकल्पिक env: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- डिफ़ॉल्ट प्रॉम्प्ट: “Reply with a single word: ok. No punctuation or extra text.”

अंतिम रन (2025-12-31, 20 रन):

- minimax median 1279ms (min 1114, max 2431)
- opus median 2454ms (min 1224, max 3170)

## ऑनबोर्डिंग E2E (Docker)

Docker वैकल्पिक है; यह केवल कंटेनरीकृत ऑनबोर्डिंग स्मोक परीक्षणों के लिए आवश्यक है।

एक साफ Linux कंटेनर में पूर्ण कोल्ड-स्टार्ट फ्लो:

```bash
scripts/e2e/onboard-docker.sh
```

यह स्क्रिप्ट pseudo-tty के माध्यम से इंटरैक्टिव विज़ार्ड को संचालित करती है, config/workspace/session फ़ाइलों की पुष्टि करती है, फिर gateway शुरू करती है और `openclaw health` चलाती है।

## QR इम्पोर्ट स्मोक (Docker)

यह सुनिश्चित करता है कि `qrcode-terminal` Docker में Node 22+ के तहत लोड हो:

```bash
pnpm test:docker:qr
```
