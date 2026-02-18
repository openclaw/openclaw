---
summary: "Ollama (local LLM runtime) ဖြင့် OpenClaw ကို လည်ပတ်ရန်"
read_when:
  - Ollama မှတစ်ဆင့် local မော်ဒယ်များဖြင့် OpenClaw ကို လည်ပတ်လိုပါက
  - Ollama ကို တပ်ဆင်ခြင်းနှင့် ဖွဲ့စည်းပြင်ဆင်ခြင်းအတွက် လမ်းညွှန်ချက်များ လိုအပ်ပါက
title: "Ollama"
---

# Ollama

Ollama is a local LLM runtime that makes it easy to run open-source models on your machine. OpenClaw integrates with Ollama's OpenAI-compatible API and can **auto-discover tool-capable models** when you opt in with `OLLAMA_API_KEY` (or an auth profile) and do not define an explicit `models.providers.ollama` entry.

## Quick start

1. Ollama ကို ထည့်သွင်းတပ်ဆင်ပါ: [https://ollama.ai](https://ollama.ai)

2. မော်ဒယ်တစ်ခုကို pull လုပ်ပါ:

```bash
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
# or
ollama pull qwen2.5-coder:32b
# or
ollama pull deepseek-r1:32b
```

3. OpenClaw အတွက် Ollama ကို ဖွင့်ပါ (တန်ဖိုးမည်သည့်အရာမဆို ရပါသည်; Ollama သည် အမှန်တကယ် API key မလိုအပ်ပါ):

```bash
# Set environment variable
export OLLAMA_API_KEY="ollama-local"

# Or configure in your config file
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Ollama မော်ဒယ်များကို အသုံးပြုပါ:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/gpt-oss:20b" },
    },
  },
}
```

## Model discovery (implicit provider)

`OLLAMA_API_KEY` (သို့မဟုတ် auth profile) ကို သတ်မှတ်ထားပြီး **`models.providers.ollama` ကို မသတ်မှတ်ထားပါက**, OpenClaw သည် `http://127.0.0.1:11434` ရှိ local Ollama instance မှ မော်ဒယ်များကို ရှာဖွေတွေ့ရှိပါသည်-

- `/api/tags` နှင့် `/api/show` ကို query လုပ်သည်
- `tools` စွမ်းဆောင်ရည်ကို အစီရင်ခံသော မော်ဒယ်များကိုသာ ထားရှိသည်
- မော်ဒယ်က `thinking` ကို အစီရင်ခံပါက `reasoning` ဟု မှတ်သားသည်
- ရရှိနိုင်ပါက `model_info["<arch>.context_length"]` မှ `contextWindow` ကို ဖတ်ယူသည်
- `maxTokens` ကို context window ၏ 10× အဖြစ် သတ်မှတ်သည်
- ကုန်ကျစရိတ်အားလုံးကို `0` အဖြစ် သတ်မှတ်သည်

ဤနည်းလမ်းသည် မော်ဒယ်များကို လက်ဖြင့် ထည့်သွင်းရန် မလိုအပ်ဘဲ Ollama ၏ စွမ်းဆောင်ရည်များနှင့် ကိုက်ညီသော catalog ကို ထိန်းသိမ်းနိုင်စေသည်။

ရရှိနိုင်သော မော်ဒယ်များကို ကြည့်ရန်-

```bash
ollama list
openclaw models list
```

မော်ဒယ်အသစ်တစ်ခု ထည့်ရန် Ollama ဖြင့် pull လုပ်ရုံသာ လိုအပ်ပါသည်-

```bash
ollama pull mistral
```

မော်ဒယ်အသစ်သည် အလိုအလျောက် ရှာဖွေတွေ့ရှိပြီး အသုံးပြုနိုင်လာမည် ဖြစ်သည်။

`models.providers.ollama` ကို တိတိကျကျ သတ်မှတ်ထားပါက auto-discovery ကို ကျော်လွှားပြီး မော်ဒယ်များကို လက်ဖြင့် သတ်မှတ်ရပါမည် (အောက်တွင် ကြည့်ပါ)။

## Configuration

### Basic setup (implicit discovery)

Ollama ကို ဖွင့်ရန် အလွယ်ဆုံးနည်းမှာ environment variable ကို အသုံးပြုခြင်း ဖြစ်သည်-

```bash
export OLLAMA_API_KEY="ollama-local"
```

### Explicit setup (manual models)

အောက်ပါအခြေအနေများတွင် explicit config ကို အသုံးပြုပါ-

- Ollama သည် အခြား ဟို့စ်/port တွင် လည်ပတ်နေပါက
- သီးခြား context window များ သို့မဟုတ် မော်ဒယ်စာရင်းများကို အတင်းအကျပ် သတ်မှတ်လိုပါက
- tool support ကို အစီရင်မခံသော မော်ဒယ်များကို ထည့်သွင်းလိုပါက

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

`OLLAMA_API_KEY` ကို သတ်မှတ်ထားပါက provider entry ထဲတွင် `apiKey` ကို ချန်လှပ်နိုင်ပြီး OpenClaw က availability စစ်ဆေးရန် အလိုအလျောက် ဖြည့်ပေးမည် ဖြစ်သည်။

### Custom base URL (explicit config)

Ollama ကို မတူညီသော ဟို့စ် သို့မဟုတ် port တွင် လည်ပတ်နေပါက (explicit config သည် auto-discovery ကို ပိတ်ထားသောကြောင့် မော်ဒယ်များကို လက်ဖြင့် သတ်မှတ်ရပါမည်)-

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

### Model selection

ဖွဲ့စည်းပြင်ဆင်ပြီးပါက သင့် Ollama မော်ဒယ်များအားလုံးကို အသုံးပြုနိုင်ပါသည်-

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

## Advanced

### Reasoning models

Ollama က `/api/show` အတွင်း `thinking` ကို အစီရင်ခံပါက OpenClaw သည် မော်ဒယ်များကို reasoning-capable ဟု မှတ်သားပါသည်-

```bash
ollama pull deepseek-r1:32b
```

### Model Costs

Ollama သည် အခမဲ့ဖြစ်ပြီး local တွင် လည်ပတ်သောကြောင့် မော်ဒယ်ကုန်ကျစရိတ်အားလုံးကို $0 အဖြစ် သတ်မှတ်ထားပါသည်။

### Streaming Configuration

Due to a [known issue](https://github.com/badlogic/pi-mono/issues/1205) in the underlying SDK with Ollama's response format, **streaming is disabled by default** for Ollama models. This prevents corrupted responses when using tool-capable models.

streaming ကို ပိတ်ထားသောအခါ response များကို တစ်ခါတည်း (non-streaming mode) ဖြင့် ပို့ဆောင်မည် ဖြစ်ပြီး content/reasoning deltas များ ပေါင်းသွားကာ output မပျက်စီးစေရန် ကူညီပါသည်။

#### Streaming ကို ပြန်ဖွင့်ခြင်း (Advanced)

Ollama အတွက် streaming ကို ပြန်ဖွင့်လိုပါက (tool-capable မော်ဒယ်များတွင် ပြဿနာ ဖြစ်နိုင်ပါသည်)-

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

#### အခြား Provider များအတွက် Streaming ကို ပိတ်ခြင်း

လိုအပ်ပါက မည်သည့် provider မဆို streaming ကို ပိတ်နိုင်ပါသည်-

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

### Context windows

For auto-discovered models, OpenClaw uses the context window reported by Ollama when available, otherwise it defaults to `8192`. You can override `contextWindow` and `maxTokens` in explicit provider config.

## Troubleshooting

### Ollama ကို မတွေ့ရှိနိုင်ခြင်း

Ollama လည်ပတ်နေကြောင်းနှင့် `OLLAMA_API_KEY` (သို့မဟုတ် auth profile) ကို သတ်မှတ်ထားကြောင်း၊ ထို့အပြင် တိတိကျကျ `models.providers.ollama` ကို မသတ်မှတ်ထားကြောင်း သေချာစစ်ဆေးပါ-

```bash
ollama serve
```

API ကို ဝင်ရောက်အသုံးပြုနိုင်ကြောင်းလည်း စစ်ဆေးပါ-

```bash
curl http://localhost:11434/api/tags
```

### မော်ဒယ်များ မရရှိနိုင်ခြင်း

OpenClaw only auto-discovers models that report tool support. If your model isn't listed, either:

- tool-capable မော်ဒယ်တစ်ခုကို pull လုပ်ပါ၊ သို့မဟုတ်
- `models.providers.ollama` တွင် မော်ဒယ်ကို လက်ဖြင့် သတ်မှတ်ပါ။

မော်ဒယ်များ ထည့်ရန်-

```bash
ollama list  # See what's installed
ollama pull gpt-oss:20b  # Pull a tool-capable model
ollama pull llama3.3     # Or another model
```

### Connection refused

Ollama သည် မှန်ကန်သော port တွင် လည်ပတ်နေကြောင်း စစ်ဆေးပါ-

```bash
# Check if Ollama is running
ps aux | grep ollama

# Or restart Ollama
ollama serve
```

### Response များ ပျက်စီးခြင်း သို့မဟုတ် output ထဲတွင် tool အမည်များ ပေါ်လာခြင်း

If you see garbled responses containing tool names (like `sessions_send`, `memory_get`) or fragmented text when using Ollama models, this is due to an upstream SDK issue with streaming responses. **This is fixed by default** in the latest OpenClaw version by disabling streaming for Ollama models.

သင် streaming ကို လက်ဖြင့် ဖွင့်ထားပြီး ဤပြဿနာကို ကြုံတွေ့ပါက-

1. သင့် Ollama မော်ဒယ် entry များမှ `streaming: true` configuration ကို ဖယ်ရှားပါ၊ သို့မဟုတ်
2. Ollama မော်ဒယ်များအတွက် `streaming: false` ကို တိတိကျကျ သတ်မှတ်ပါ ([Streaming Configuration](#streaming-configuration) ကို ကြည့်ပါ)

## See Also

- [Model Providers](/concepts/model-providers) - provider အားလုံး၏ အနှစ်ချုပ်
- [Model Selection](/concepts/models) - မော်ဒယ်များကို မည်သို့ ရွေးချယ်ရမည်
- [Configuration](/gateway/configuration) - ဖွဲ့စည်းပြင်ဆင်ခြင်း အပြည့်အစုံ
