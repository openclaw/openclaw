---
summary: "Ollama (स्थानीय LLM रनटाइम) के साथ OpenClaw चलाएँ"
read_when:
  - आप Ollama के माध्यम से स्थानीय मॉडलों के साथ OpenClaw चलाना चाहते हैं
  - आपको Ollama की सेटअप और विन्यास संबंधी मार्गदर्शन चाहिए
title: "Ollama"
---

# Ollama

Ollama is a local LLM runtime that makes it easy to run open-source models on your machine. OpenClaw integrates with Ollama's OpenAI-compatible API and can **auto-discover tool-capable models** when you opt in with `OLLAMA_API_KEY` (or an auth profile) and do not define an explicit `models.providers.ollama` entry.

## त्वरित प्रारंभ

1. Ollama इंस्टॉल करें: [https://ollama.ai](https://ollama.ai)

2. एक मॉडल पुल करें:

```bash
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
# or
ollama pull qwen2.5-coder:32b
# or
ollama pull deepseek-r1:32b
```

3. OpenClaw के लिए Ollama सक्षम करें (कोई भी मान काम करेगा; Ollama को वास्तविक कुंजी की आवश्यकता नहीं होती):

```bash
# Set environment variable
export OLLAMA_API_KEY="ollama-local"

# Or configure in your config file
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Ollama मॉडलों का उपयोग करें:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/gpt-oss:20b" },
    },
  },
}
```

## मॉडल डिस्कवरी (अप्रत्यक्ष प्रदाता)

जब आप `OLLAMA_API_KEY` (या किसी auth प्रोफ़ाइल) सेट करते हैं और **`models.providers.ollama` परिभाषित नहीं** करते, तो OpenClaw स्थानीय Ollama इंस्टेंस से `http://127.0.0.1:11434` पर मॉडलों की खोज करता है:

- `/api/tags` और `/api/show` को क्वेरी करता है
- केवल उन मॉडलों को रखता है जो `tools` क्षमता रिपोर्ट करते हैं
- जब मॉडल `thinking` रिपोर्ट करता है तो `reasoning` को चिह्नित करता है
- उपलब्ध होने पर `model_info["<arch>.context_length"]` से `contextWindow` पढ़ता है
- `maxTokens` को कॉन्टेक्स्ट विंडो के 10× पर सेट करता है
- सभी लागतों को `0` पर सेट करता है

यह Ollama की क्षमताओं के साथ कैटलॉग को संरेखित रखते हुए मैन्युअल मॉडल प्रविष्टियों से बचाता है।

उपलब्ध मॉडलों को देखने के लिए:

```bash
ollama list
openclaw models list
```

नया मॉडल जोड़ने के लिए, बस Ollama के साथ उसे पुल करें:

```bash
ollama pull mistral
```

नया मॉडल स्वतः खोजा जाएगा और उपयोग के लिए उपलब्ध होगा।

यदि आप `models.providers.ollama` को स्पष्ट रूप से सेट करते हैं, तो स्वतः-डिस्कवरी छोड़ दी जाती है और आपको मॉडलों को मैन्युअल रूप से परिभाषित करना होगा (नीचे देखें)।

## विन्यास

### बेसिक सेटअप (अप्रत्यक्ष डिस्कवरी)

Ollama को सक्षम करने का सबसे सरल तरीका पर्यावरण चर के माध्यम से है:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### स्पष्ट सेटअप (मैन्युअल मॉडल)

जब निम्न स्थितियाँ हों, तब स्पष्ट विन्यास का उपयोग करें:

- Ollama किसी अन्य होस्ट/पोर्ट पर चलता हो।
- आप विशिष्ट कॉन्टेक्स्ट विंडो या मॉडल सूचियाँ बाध्य करना चाहते हों।
- आप ऐसे मॉडल शामिल करना चाहते हों जो टूल समर्थन रिपोर्ट नहीं करते।

```json5
{
  models: {
    providers: {
      ollama: {
        // Use a host that includes /v1 for OpenAI-compatible APIs
        baseUrl: "http://ollama-host:11434/v1",
        apiKey: "ollama-local",
        api: "openai-completions",
        models: [
          {
            id: "gpt-oss:20b",
            name: "GPT-OSS 20B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 8192 * 10
          }
        ]
      }
    }
  }
}
```

यदि `OLLAMA_API_KEY` सेट है, तो आप प्रदाता प्रविष्टि में `apiKey` को छोड़ सकते हैं और OpenClaw उपलब्धता जाँच के लिए उसे भर देगा।

### कस्टम बेस URL (स्पष्ट विन्यास)

यदि Ollama किसी अलग होस्ट या पोर्ट पर चल रहा है (स्पष्ट विन्यास स्वतः-डिस्कवरी को अक्षम करता है, इसलिए मॉडलों को मैन्युअल रूप से परिभाषित करें):

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434/v1",
      },
    },
  },
}
```

### मॉडल चयन

एक बार विन्यस्त होने पर, आपके सभी Ollama मॉडल उपलब्ध होते हैं:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/gpt-oss:20b",
        fallbacks: ["ollama/llama3.3", "ollama/qwen2.5-coder:32b"],
      },
    },
  },
}
```

## उन्नत

### तर्क (Reasoning) मॉडल

जब Ollama `/api/show` में `thinking` रिपोर्ट करता है, तो OpenClaw मॉडलों को तर्क-सक्षम के रूप में चिह्नित करता है:

```bash
ollama pull deepseek-r1:32b
```

### मॉडल लागत

Ollama निःशुल्क है और स्थानीय रूप से चलता है, इसलिए सभी मॉडल लागतें $0 पर सेट होती हैं।

### स्ट्रीमिंग विन्यास

Due to a [known issue](https://github.com/badlogic/pi-mono/issues/1205) in the underlying SDK with Ollama's response format, **streaming is disabled by default** for Ollama models. This prevents corrupted responses when using tool-capable models.

जब स्ट्रीमिंग अक्षम होती है, तो प्रतिक्रियाएँ एक साथ (नॉन-स्ट्रीमिंग मोड) में दी जाती हैं, जिससे वह समस्या टल जाती है जहाँ इंटरलीव्ड कंटेंट/रीज़निंग डेल्टा के कारण आउटपुट बिगड़ जाता है।

#### स्ट्रीमिंग पुनः सक्षम करें (उन्नत)

यदि आप Ollama के लिए स्ट्रीमिंग पुनः सक्षम करना चाहते हैं (टूल-सक्षम मॉडलों के साथ समस्याएँ हो सकती हैं):

```json5
{
  agents: {
    defaults: {
      models: {
        "ollama/gpt-oss:20b": {
          streaming: true,
        },
      },
    },
  },
}
```

#### अन्य प्रदाताओं के लिए स्ट्रीमिंग अक्षम करें

यदि आवश्यकता हो, तो आप किसी भी प्रदाता के लिए स्ट्रीमिंग अक्षम कर सकते हैं:

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-4": {
          streaming: false,
        },
      },
    },
  },
}
```

### कॉन्टेक्स्ट विंडो

For auto-discovered models, OpenClaw uses the context window reported by Ollama when available, otherwise it defaults to `8192`. You can override `contextWindow` and `maxTokens` in explicit provider config.

## समस्या-निवारण

### Ollama का पता नहीं चल रहा

सुनिश्चित करें कि Ollama चल रहा है और आपने `OLLAMA_API_KEY` (या किसी auth प्रोफ़ाइल) सेट किया है, और आपने कोई स्पष्ट `models.providers.ollama` प्रविष्टि **परिभाषित नहीं** की है:

```bash
ollama serve
```

और यह कि API सुलभ है:

```bash
curl http://localhost:11434/api/tags
```

### कोई मॉडल उपलब्ध नहीं

OpenClaw only auto-discovers models that report tool support. If your model isn't listed, either:

- टूल-सक्षम मॉडल पुल करें, या
- `models.providers.ollama` में मॉडल को स्पष्ट रूप से परिभाषित करें।

मॉडल जोड़ने के लिए:

```bash
ollama list  # See what's installed
ollama pull gpt-oss:20b  # Pull a tool-capable model
ollama pull llama3.3     # Or another model
```

### कनेक्शन अस्वीकृत

जाँचें कि Ollama सही पोर्ट पर चल रहा है:

```bash
# Check if Ollama is running
ps aux | grep ollama

# Or restart Ollama
ollama serve
```

### आउटपुट में भ्रष्ट प्रतिक्रियाएँ या टूल नाम

If you see garbled responses containing tool names (like `sessions_send`, `memory_get`) or fragmented text when using Ollama models, this is due to an upstream SDK issue with streaming responses. **This is fixed by default** in the latest OpenClaw version by disabling streaming for Ollama models.

यदि आपने मैन्युअल रूप से स्ट्रीमिंग सक्षम की है और यह समस्या अनुभव करते हैं:

1. अपनी Ollama मॉडल प्रविष्टियों से `streaming: true` विन्यास हटाएँ, या
2. Ollama मॉडलों के लिए स्पष्ट रूप से `streaming: false` सेट करें (देखें [स्ट्रीमिंग विन्यास](#streaming-configuration))

## यह भी देखें

- [Model Providers](/concepts/model-providers) - सभी प्रदाताओं का अवलोकन
- [Model Selection](/concepts/models) - मॉडल कैसे चुनें
- [Configuration](/gateway/configuration) - पूर्ण विन्यास संदर्भ
