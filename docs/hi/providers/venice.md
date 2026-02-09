---
summary: "OpenClaw में Venice AI के गोपनीयता-केंद्रित मॉडलों का उपयोग करें"
read_when:
  - आप OpenClaw में गोपनीयता-केंद्रित इनफेरेंस चाहते हैं
  - आप Venice AI सेटअप मार्गदर्शन चाहते हैं
title: "Venice AI"
---

# Venice AI (Venice हाइलाइट)

**Venice** गोपनीयता-प्रथम इनफेरेंस के लिए हमारा प्रमुख Venice सेटअप है, जिसमें स्वामित्व वाले मॉडलों तक वैकल्पिक अनामीकृत पहुँच शामिल है।

Venice AI provides privacy-focused AI inference with support for uncensored models and access to major proprietary models through their anonymized proxy. All inference is private by default—no training on your data, no logging.

## OpenClaw में Venice क्यों

- **निजी इनफेरेंस** ओपन-सोर्स मॉडलों के लिए (कोई लॉगिंग नहीं)।
- **अनसेंसरड मॉडल** जब आपको उनकी आवश्यकता हो।
- **अनामीकृत पहुँच** स्वामित्व वाले मॉडलों (Opus/GPT/Gemini) तक, जब गुणवत्ता महत्वपूर्ण हो।
- OpenAI-संगत `/v1` एंडपॉइंट्स।

## गोपनीयता मोड

Venice दो गोपनीयता स्तर प्रदान करता है — सही मॉडल चुनने के लिए इन्हें समझना महत्वपूर्ण है:

| मोड            | विवरण                                                                                                                                                                   | मॉडल                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Private**    | पूरी तरह निजी। Prompts/responses are **never stored or logged**. Ephemeral.                                                             | Llama, Qwen, DeepSeek, Venice Uncensored, आदि |
| **Anonymized** | Proxied through Venice with metadata stripped. The underlying provider (OpenAI, Anthropic) sees anonymized requests. | Claude, GPT, Gemini, Grok, Kimi, MiniMax      |

## विशेषताएँ

- **गोपनीयता-केंद्रित**: "private" (पूर्णतः निजी) और "anonymized" (प्रॉक्सी) मोड में से चुनें
- **अनसेंसरड मॉडल**: सामग्री प्रतिबंधों के बिना मॉडलों तक पहुँच
- **प्रमुख मॉडलों की पहुँच**: Venice के अनामीकृत प्रॉक्सी के माध्यम से Claude, GPT-5.2, Gemini, Grok का उपयोग
- **OpenAI-संगत API**: आसान एकीकरण के लिए मानक `/v1` एंडपॉइंट्स
- **स्ट्रीमिंग**: ✅ सभी मॉडलों पर समर्थित
- **फ़ंक्शन कॉलिंग**: ✅ चयनित मॉडलों पर समर्थित (मॉडल क्षमताएँ देखें)
- **विज़न**: ✅ विज़न क्षमता वाले मॉडलों पर समर्थित
- **कोई कठोर रेट लिमिट नहीं**: अत्यधिक उपयोग पर फ़ेयर-यूज़ थ्रॉटलिंग लागू हो सकती है

## सेटअप

### 1. Get API Key

1. [venice.ai](https://venice.ai) पर साइन अप करें
2. **Settings → API Keys → Create new key** पर जाएँ
3. अपनी API कुंजी कॉपी करें (फ़ॉर्मैट: `vapi_xxxxxxxxxxxx`)

### 2) Configure OpenClaw

**विकल्प A: पर्यावरण चर**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**विकल्प B: इंटरैक्टिव सेटअप (अनुशंसित)**

```bash
openclaw onboard --auth-choice venice-api-key
```

यह करेगा:

1. आपकी API कुंजी के लिए पूछेगा (या मौजूदा `VENICE_API_KEY` का उपयोग करेगा)
2. सभी उपलब्ध Venice मॉडल दिखाएगा
3. आपको अपना डिफ़ॉल्ट मॉडल चुनने देगा
4. प्रदाता को स्वचालित रूप से कॉन्फ़िगर करेगा

**विकल्प C: नॉन-इंटरैक्टिव**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. Verify Setup

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## मॉडल चयन

After setup, OpenClaw shows all available Venice models. Pick based on your needs:

- **डिफ़ॉल्ट (हमारी पसंद)**: निजी, संतुलित प्रदर्शन के लिए `venice/llama-3.3-70b`।
- **सर्वोत्तम समग्र गुणवत्ता**: कठिन कार्यों के लिए `venice/claude-opus-45` (Opus अब भी सबसे शक्तिशाली है)।
- **गोपनीयता**: पूर्णतः निजी इनफेरेंस के लिए "private" मॉडल चुनें।
- **क्षमता**: Venice के प्रॉक्सी के माध्यम से Claude, GPT, Gemini तक पहुँच के लिए "anonymized" मॉडल चुनें।

कभी भी अपना डिफ़ॉल्ट मॉडल बदलें:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

सभी उपलब्ध मॉडल सूचीबद्ध करें:

```bash
openclaw models list | grep venice
```

## `openclaw configure` के माध्यम से कॉन्फ़िगर करें

1. `openclaw configure` चलाएँ
2. **Model/auth** चुनें
3. **Venice AI** चुनें

## मुझे कौन सा मॉडल उपयोग करना चाहिए?

| उपयोग मामला                    | अनुशंसित मॉडल                    | कारण                                          |
| ------------------------------ | -------------------------------- | --------------------------------------------- |
| **सामान्य चैट**                | `llama-3.3-70b`                  | अच्छा सर्वांगीण, पूर्णतः निजी                 |
| **सर्वोत्तम समग्र गुणवत्ता**   | `claude-opus-45`                 | कठिन कार्यों के लिए Opus सबसे मजबूत           |
| **गोपनीयता + Claude गुणवत्ता** | `claude-opus-45`                 | अनामीकृत प्रॉक्सी के माध्यम से सर्वोत्तम तर्क |
| **कोडिंग**                     | `qwen3-coder-480b-a35b-instruct` | कोड-अनुकूलित, 262k संदर्भ                     |
| **विज़न कार्य**                | `qwen3-vl-235b-a22b`             | सर्वोत्तम निजी विज़न मॉडल                     |
| **अनसेंसरड**                   | `venice-uncensored`              | कोई सामग्री प्रतिबंध नहीं                     |
| **तेज़ + सस्ता**               | `qwen3-4b`                       | हल्का, फिर भी सक्षम                           |
| **जटिल तर्क**                  | `deepseek-v3.2`                  | मजबूत तर्क, निजी                              |

## उपलब्ध मॉडल (कुल 25)

### Private मॉडल (15) — पूर्णतः निजी, कोई लॉगिंग नहीं

| मॉडल ID                          | नाम                                        | संदर्भ (टोकन) | विशेषताएँ     |
| -------------------------------- | ------------------------------------------ | -------------------------------- | ------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B              | 131k                             | सामान्य       |
| `llama-3.2-3b`                   | Llama 3.2 3B               | 131k                             | तेज़, हल्का   |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B    | 131k                             | जटिल कार्य    |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking                        | 131k                             | तर्क          |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct                        | 131k                             | सामान्य       |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B                           | 262k                             | कोड           |
| `qwen3-next-80b`                 | Qwen3 Next 80B                             | 262k                             | सामान्य       |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B                              | 262k                             | विज़न         |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k                              | तेज़, तर्क    |
| `deepseek-v3.2`                  | DeepSeek V3.2              | 163k                             | तर्क          |
| `venice-uncensored`              | Venice Uncensored                          | 32k                              | अनसेंसरड      |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k                             | विज़न         |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct                       | 202k                             | विज़न         |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B                        | 131k                             | सामान्य       |
| `zai-org-glm-4.7`                | GLM 4.7                    | 202k                             | तर्क, बहुभाषी |

### Anonymized मॉडल (10) — Venice प्रॉक्सी के माध्यम से

| मॉडल ID                  | मूल                               | संदर्भ (टोकन) | विशेषताएँ   |
| ------------------------ | --------------------------------- | -------------------------------- | ----------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k                             | तर्क, विज़न |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k                             | तर्क, विज़न |
| `openai-gpt-52`          | GPT-5.2           | 262k                             | तर्क        |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k                             | तर्क, विज़न |
| `gemini-3-pro-preview`   | Gemini 3 Pro                      | 202k                             | तर्क, विज़न |
| `gemini-3-flash-preview` | Gemini 3 Flash                    | 262k                             | तर्क, विज़न |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k                             | तर्क, विज़न |
| `grok-code-fast-1`       | Grok Code Fast 1                  | 262k                             | तर्क, कोड   |
| `kimi-k2-thinking`       | Kimi K2 Thinking                  | 262k                             | तर्क        |
| `minimax-m21`            | MiniMax M2.1      | 202k                             | तर्क        |

## मॉडल डिस्कवरी

OpenClaw automatically discovers models from the Venice API when `VENICE_API_KEY` is set. If the API is unreachable, it falls back to a static catalog.

`/models` एंडपॉइंट सार्वजनिक है (सूची के लिए प्रमाणीकरण आवश्यक नहीं), लेकिन इनफेरेंस के लिए मान्य API कुंजी आवश्यक है।

## स्ट्रीमिंग और टूल समर्थन

| फ़ीचर              | समर्थन                                                                       |
| ------------------ | ---------------------------------------------------------------------------- |
| **स्ट्रीमिंग**     | ✅ सभी मॉडल                                                                   |
| **फ़ंक्शन कॉलिंग** | ✅ अधिकांश मॉडल (`supportsFunctionCalling` API में जाँचें) |
| **विज़न/छवियाँ**   | ✅ "Vision" फ़ीचर वाले मॉडल                                                   |
| **JSON मोड**       | ✅ `response_format` के माध्यम से समर्थित                                     |

## मूल्य निर्धारण

Venice uses a credit-based system. Check [venice.ai/pricing](https://venice.ai/pricing) for current rates:

- **Private मॉडल**: सामान्यतः कम लागत
- **Anonymized मॉडल**: प्रत्यक्ष API मूल्य निर्धारण के समान + छोटा Venice शुल्क

## तुलना: Venice बनाम Direct API

| पहलू         | Venice (Anonymized) | Direct API       |
| ------------ | -------------------------------------- | ---------------- |
| **गोपनीयता** | मेटाडेटा हटाया गया, अनामीकृत           | आपका खाता लिंक्ड |
| **लेटेंसी**  | +10-50ms (प्रॉक्सी) | प्रत्यक्ष        |
| **फ़ीचर**    | अधिकांश फ़ीचर समर्थित                  | पूर्ण फ़ीचर      |
| **बिलिंग**   | Venice क्रेडिट                         | प्रदाता बिलिंग   |

## उपयोग उदाहरण

```bash
# Use default private model
openclaw chat --model venice/llama-3.3-70b

# Use Claude via Venice (anonymized)
openclaw chat --model venice/claude-opus-45

# Use uncensored model
openclaw chat --model venice/venice-uncensored

# Use vision model with image
openclaw chat --model venice/qwen3-vl-235b-a22b

# Use coding model
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## समस्या-निवारण

### API कुंजी पहचानी नहीं गई

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

सुनिश्चित करें कि कुंजी `vapi_` से शुरू होती है।

### मॉडल उपलब्ध नहीं

The Venice model catalog updates dynamically. Run `openclaw models list` to see currently available models. Some models may be temporarily offline.

### कनेक्शन समस्याएँ

Venice API is at `https://api.venice.ai/api/v1`. सुनिश्चित करें कि आपका network HTTPS connections की अनुमति देता है।

## कॉन्फ़िग फ़ाइल उदाहरण

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/llama-3.3-70b" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## लिंक

- [Venice AI](https://venice.ai)
- [API Documentation](https://docs.venice.ai)
- [Pricing](https://venice.ai/pricing)
- [Status](https://status.venice.ai)
