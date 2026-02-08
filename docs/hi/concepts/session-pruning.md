---
summary: "सेशन प्रूनिंग: संदर्भ फुलाव कम करने के लिए टूल-रिज़ल्ट ट्रिमिंग"
read_when:
  - आप टूल आउटपुट से LLM संदर्भ वृद्धि को कम करना चाहते हैं
  - आप agents.defaults.contextPruning को ट्यून कर रहे हैं
x-i18n:
  source_path: concepts/session-pruning.md
  source_hash: 9b0aa2d1abea7050
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:13Z
---

# Session Pruning

Session pruning प्रत्येक LLM कॉल से ठीक पहले इन‑मेमोरी संदर्भ से **पुराने टूल परिणामों** को ट्रिम करता है। यह ऑन‑डिस्क सेशन इतिहास को **रीराइट नहीं** करता (`*.jsonl`)।

## When it runs

- जब `mode: "cache-ttl"` सक्षम हो और सेशन के लिए पिछली Anthropic कॉल `ttl` से अधिक पुरानी हो।
- केवल उस अनुरोध के लिए मॉडल को भेजे गए संदेशों को प्रभावित करता है।
- केवल Anthropic API कॉल्स (और OpenRouter Anthropic मॉडल) के लिए सक्रिय।
- सर्वोत्तम परिणामों के लिए, `ttl` को अपने मॉडल `cacheControlTtl` से मिलाएँ।
- प्रून के बाद, TTL विंडो रीसेट हो जाती है ताकि बाद के अनुरोध `ttl` के फिर से समाप्त होने तक कैश बनाए रखें।

## Smart defaults (Anthropic)

- **OAuth या setup-token** प्रोफ़ाइल्स: `cache-ttl` प्रूनिंग सक्षम करें और हार्टबीट को `1h` पर सेट करें।
- **API key** प्रोफ़ाइल्स: `cache-ttl` प्रूनिंग सक्षम करें, हार्टबीट को `30m` पर सेट करें, और Anthropic मॉडल्स पर डिफ़ॉल्ट `cacheControlTtl` को `1h` पर रखें।
- यदि आप इनमें से किसी भी मान को स्पष्ट रूप से सेट करते हैं, तो OpenClaw उन्हें **ओवरराइड नहीं** करता।

## What this improves (cost + cache behavior)

- **Why prune:** Anthropic प्रॉम्प्ट कैशिंग केवल TTL के भीतर लागू होती है। यदि कोई सेशन TTL से आगे निष्क्रिय रहता है, तो अगला अनुरोध पहले ट्रिम किए बिना पूरे प्रॉम्प्ट को फिर से कैश करता है।
- **What gets cheaper:** प्रूनिंग TTL समाप्त होने के बाद उस पहले अनुरोध के लिए **cacheWrite** आकार को कम करती है।
- **Why the TTL reset matters:** एक बार प्रूनिंग चलने पर, कैश विंडो रीसेट हो जाती है, इसलिए फॉलो‑अप अनुरोध पूरे इतिहास को फिर से कैश करने के बजाय ताज़ा कैश किए गए प्रॉम्प्ट का पुनः उपयोग कर सकते हैं।
- **What it does not do:** प्रूनिंग टोकन नहीं जोड़ती या लागत को “डबल” नहीं करती; यह केवल उस पहले पोस्ट‑TTL अनुरोध पर क्या कैश होगा, उसे बदलती है।

## What can be pruned

- केवल `toolResult` संदेश।
- उपयोगकर्ता + सहायक संदेशों को **कभी** संशोधित नहीं किया जाता।
- अंतिम `keepLastAssistants` सहायक संदेश संरक्षित रहते हैं; उस कटऑफ़ के बाद के टूल परिणाम प्रून नहीं किए जाते।
- यदि कटऑफ़ स्थापित करने के लिए पर्याप्त सहायक संदेश नहीं हैं, तो प्रूनिंग छोड़ी जाती है।
- **इमेज ब्लॉक्स** वाले टूल परिणाम छोड़े जाते हैं (कभी ट्रिम/क्लियर नहीं किए जाते)।

## Context window estimation

प्रूनिंग अनुमानित संदर्भ विंडो का उपयोग करती है (अक्षर ≈ टोकन × 4)। बेस विंडो इस क्रम में तय होती है:

1. `models.providers.*.models[].contextWindow` ओवरराइड।
2. मॉडल परिभाषा `contextWindow` (मॉडल रजिस्ट्री से)।
3. डिफ़ॉल्ट `200000` टोकन।

यदि `agents.defaults.contextTokens` सेट है, तो इसे निर्धारित विंडो पर एक कैप (min) के रूप में माना जाता है।

## Mode

### cache-ttl

- प्रूनिंग केवल तब चलती है जब पिछली Anthropic कॉल `ttl` से अधिक पुरानी हो (डिफ़ॉल्ट `5m`)।
- जब यह चलती है: पहले जैसा ही सॉफ्ट‑ट्रिम + हार्ड‑क्लियर व्यवहार।

## Soft vs hard pruning

- **Soft-trim**: केवल ओवरसाइज़्ड टूल परिणामों के लिए।
  - हेड + टेल रखता है, `...` सम्मिलित करता है, और मूल आकार के साथ एक नोट जोड़ता है।
  - इमेज ब्लॉक्स वाले परिणामों को छोड़ देता है।
- **Hard-clear**: पूरे टूल परिणाम को `hardClear.placeholder` से बदल देता है।

## Tool selection

- `tools.allow` / `tools.deny` `*` वाइल्डकार्ड्स का समर्थन करते हैं।
- डिनाई की प्राथमिकता होती है।
- मिलान केस‑इनसेंसिटिव है।
- खाली allow सूची => सभी टूल्स अनुमत।

## Interaction with other limits

- बिल्ट‑इन टूल्स पहले से ही अपने आउटपुट को ट्रंकेट करते हैं; सेशन प्रूनिंग एक अतिरिक्त परत है जो लंबे समय तक चलने वाली चैट्स को मॉडल संदर्भ में अत्यधिक टूल आउटपुट जमा होने से रोकती है।
- कम्पैक्शन अलग है: कम्पैक्शन सारांश बनाकर स्थायी करता है, प्रूनिंग प्रति अनुरोध क्षणिक होती है। देखें [/concepts/compaction](/concepts/compaction)।

## Defaults (when enabled)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## Examples

Default (off):

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

Enable TTL-aware pruning:

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

Restrict pruning to specific tools:

```json5
{
  agent: {
    contextPruning: {
      mode: "cache-ttl",
      tools: { allow: ["exec", "read"], deny: ["*image*"] },
    },
  },
}
```

See config reference: [Gateway Configuration](/gateway/configuration)
