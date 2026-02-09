---
summary: "स्थानीय रूप से परीक्षण (vitest) कैसे चलाएँ और force/coverage मोड का उपयोग कब करें"
read_when:
  - परीक्षण चलाते या ठीक करते समय
title: "परीक्षण"
---

# परीक्षण

- पूर्ण परीक्षण किट (सूट्स, लाइव, Docker): [Testing](/help/testing)

- `pnpm test:force`: Kills any lingering gateway process holding the default control port, then runs the full Vitest suite with an isolated gateway port so server tests don’t collide with a running instance. Use this when a prior gateway run left port 18789 occupied.

- `pnpm test:coverage`: Runs Vitest with V8 coverage. Global thresholds are 70% lines/branches/functions/statements. Coverage excludes integration-heavy entrypoints (CLI wiring, gateway/telegram bridges, webchat static server) to keep the target focused on unit-testable logic.

- `pnpm test:e2e`: gateway एंड-टू-एंड स्मोक परीक्षण चलाता है (मल्टी-इंस्टेंस WS/HTTP/node पेयरिंग)।

- `pnpm test:live`: Runs provider live tests (minimax/zai). Requires API keys and `LIVE=1` (or provider-specific `*_LIVE_TEST=1`) to unskip.

## मॉडल विलंबता बेंच (स्थानीय कुंजियाँ)

स्क्रिप्ट: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

उपयोग:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- वैकल्पिक env: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Default prompt: “Reply with a single word: ok. No punctuation or extra text.”

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
