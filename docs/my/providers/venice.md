---
summary: "OpenClaw တွင် Venice AI ၏ ကိုယ်ရေးလုံခြုံမှုကို အဓိကထားသော မော်ဒယ်များကို အသုံးပြုပါ"
read_when:
  - OpenClaw တွင် ကိုယ်ရေးလုံခြုံမှုကို အဓိကထားသော inference ကို လိုအပ်ပါက
  - Venice AI ကို တပ်ဆင်ပြင်ဆင်ရန် လမ်းညွှန်လိုအပ်ပါက
title: "Venice AI"
x-i18n:
  source_path: providers/venice.md
  source_hash: 2453a6ec3a715c24
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:11Z
---

# Venice AI (Venice highlight)

**Venice** သည် ကိုယ်ရေးလုံခြုံမှုကို ဦးစားပေးသည့် inference အတွက် OpenClaw တွင် အထူးအလေးပေးထားသော Venice setup ဖြစ်ပြီး၊ proprietary မော်ဒယ်များကို အမည်မဖော်ထားသော အဝင်အထွက်ဖြင့် အသုံးပြုနိုင်ရန် ရွေးချယ်စရာ ပါဝင်သည်။

Venice AI သည် uncensored မော်ဒယ်များကို ထောက်ပံ့ပေးပြီး၊ အမည်မဖော်ထားသော proxy မှတဆင့် အဓိက proprietary မော်ဒယ်များကို အသုံးပြုနိုင်စေရန် ကိုယ်ရေးလုံခြုံမှုကို အဓိကထားသော AI inference ကို ပံ့ပိုးပေးသည်။ Inference အားလုံးသည် ပုံမှန်အားဖြင့် ကိုယ်ရေးလုံခြုံထားပြီး—သင့်ဒေတာဖြင့် သင်ကြားခြင်း မရှိ၊ မှတ်တမ်းတင်ခြင်း မရှိပါ။

## Why Venice in OpenClaw

- **Private inference** — open-source မော်ဒယ်များအတွက် (logging မရှိ)
- **Uncensored models** — လိုအပ်သည့်အခါ အသုံးပြုနိုင်
- **Anonymized access** — အရည်အသွေး အရေးကြီးသည့်အခါ proprietary မော်ဒယ်များ (Opus/GPT/Gemini) ကို အသုံးပြုနိုင်
- OpenAI-compatible `/v1` endpoints

## Privacy Modes

Venice သည် ကိုယ်ရေးလုံခြုံမှု အဆင့်နှစ်မျိုးကို ပေးထားပြီး — မော်ဒယ်ရွေးချယ်ရာတွင် ယင်းကို နားလည်ထားခြင်း အရေးကြီးသည်။

| Mode           | Description                                                                                                                                    | Models                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Private**    | အပြည့်အဝ ကိုယ်ရေးလုံခြုံ။ Prompt/Response များကို **မည်သည့်အခါမျှ မသိမ်းဆည်း၊ မမှတ်တမ်းတင်** ပါ။ ယာယီသာ ဖြစ်သည်။                               | Llama, Qwen, DeepSeek, Venice Uncensored, etc. |
| **Anonymized** | Venice မှတဆင့် proxy လုပ်ပြီး metadata ကို ဖယ်ရှားထားသည်။ အောက်ခံ provider (OpenAI, Anthropic) သည် အမည်မဖော်ထားသော request များကိုသာ မြင်ရသည်။ | Claude, GPT, Gemini, Grok, Kimi, MiniMax       |

## Features

- **Privacy-focused**: "private" (အပြည့်အဝ ကိုယ်ရေးလုံခြုံ) နှင့် "anonymized" (proxy ဖြင့်) မုဒ်များအကြား ရွေးချယ်နိုင်
- **Uncensored models**: အကြောင်းအရာ ကန့်သတ်ချက်မရှိသော မော်ဒယ်များကို အသုံးပြုနိုင်
- **Major model access**: Venice ၏ anonymized proxy မှတဆင့် Claude, GPT-5.2, Gemini, Grok ကို အသုံးပြုနိုင်
- **OpenAI-compatible API**: လွယ်ကူစွာ ပေါင်းစည်းနိုင်ရန် စံ `/v1` endpoints
- **Streaming**: ✅ မော်ဒယ်အားလုံးတွင် ထောက်ပံ့ထားသည်
- **Function calling**: ✅ မော်ဒယ်အချို့တွင် ထောက်ပံ့ထားသည် (မော်ဒယ် စွမ်းရည်များကို စစ်ဆေးပါ)
- **Vision**: ✅ Vision စွမ်းရည် ပါဝင်သည့် မော်ဒယ်များတွင် ထောက်ပံ့ထားသည်
- **No hard rate limits**: အလွန်အမင်း အသုံးပြုပါက fair-use throttling အသုံးပြုနိုင်သည်

## Setup

### 1. Get API Key

1. [venice.ai](https://venice.ai) တွင် စာရင်းသွင်းပါ
2. **Settings → API Keys → Create new key** သို့ သွားပါ
3. သင့် API key ကို ကူးယူပါ (ဖော်မတ်: `vapi_xxxxxxxxxxxx`)

### 2. Configure OpenClaw

**Option A: Environment Variable**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Option B: Interactive Setup (Recommended)**

```bash
openclaw onboard --auth-choice venice-api-key
```

ဤလုပ်ငန်းစဉ်သည် အောက်ပါအရာများကို လုပ်ဆောင်ပါမည် —

1. သင့် API key ကို မေးမြန်းပါ (သို့မဟုတ် ရှိပြီးသား `VENICE_API_KEY` ကို အသုံးပြုပါ)
2. ရရှိနိုင်သော Venice မော်ဒယ်များအားလုံးကို ပြသပါ
3. သင့် default မော်ဒယ်ကို ရွေးချယ်နိုင်စေပါ
4. provider ကို အလိုအလျောက် ပြင်ဆင်ပေးပါ

**Option C: Non-interactive**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. Verify Setup

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## Model Selection

Setup ပြီးနောက် OpenClaw သည် ရရှိနိုင်သော Venice မော်ဒယ်များအားလုံးကို ပြသပါမည်။ သင့်လိုအပ်ချက်အလိုက် ရွေးချယ်ပါ —

- **Default (our pick)**: `venice/llama-3.3-70b` — private ဖြစ်ပြီး စွမ်းဆောင်ရည်ညီမျှ
- **Best overall quality**: `venice/claude-opus-45` — ခက်ခဲသော လုပ်ငန်းများအတွက် (Opus သည် အားအကောင်းဆုံး ဖြစ်ဆဲ)
- **Privacy**: အပြည့်အဝ ကိုယ်ရေးလုံခြုံမှုအတွက် "private" မော်ဒယ်များကို ရွေးချယ်ပါ
- **Capability**: Venice proxy မှတဆင့် Claude, GPT, Gemini ကို အသုံးပြုရန် "anonymized" မော်ဒယ်များကို ရွေးချယ်ပါ

Default မော်ဒယ်ကို မည်သည့်အချိန်မဆို ပြောင်းလဲနိုင်သည် —

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

ရရှိနိုင်သော မော်ဒယ်များအားလုံးကို စာရင်းပြရန် —

```bash
openclaw models list | grep venice
```

## Configure via `openclaw configure`

1. `openclaw configure` ကို လုပ်ဆောင်ပါ
2. **Model/auth** ကို ရွေးပါ
3. **Venice AI** ကို ရွေးပါ

## Which Model Should I Use?

| Use Case                     | Recommended Model                | Why                                                     |
| ---------------------------- | -------------------------------- | ------------------------------------------------------- |
| **General chat**             | `llama-3.3-70b`                  | အထွေထွေ အသုံးပြုရန် ကောင်းပြီး အပြည့်အဝ ကိုယ်ရေးလုံခြုံ |
| **Best overall quality**     | `claude-opus-45`                 | ခက်ခဲသော လုပ်ငန်းများအတွက် Opus သည် အားအကောင်းဆုံး      |
| **Privacy + Claude quality** | `claude-opus-45`                 | anonymized proxy မှတဆင့် အကောင်းဆုံး reasoning          |
| **Coding**                   | `qwen3-coder-480b-a35b-instruct` | Code အတွက် အကောင်းဆုံး၊ 262k context                    |
| **Vision tasks**             | `qwen3-vl-235b-a22b`             | အကောင်းဆုံး private vision မော်ဒယ်                      |
| **Uncensored**               | `venice-uncensored`              | အကြောင်းအရာ ကန့်သတ်ချက် မရှိ                            |
| **Fast + cheap**             | `qwen3-4b`                       | ပေါ့ပါးပြီး စွမ်းရည်ကောင်း                              |
| **Complex reasoning**        | `deepseek-v3.2`                  | reasoning အားကောင်းပြီး private                         |

## Available Models (25 Total)

### Private Models (15) — Fully Private, No Logging

| Model ID                         | Name                    | Context (tokens) | Features                |
| -------------------------------- | ----------------------- | ---------------- | ----------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B           | 131k             | General                 |
| `llama-3.2-3b`                   | Llama 3.2 3B            | 131k             | Fast, lightweight       |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B | 131k             | Complex tasks           |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking     | 131k             | Reasoning               |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct     | 131k             | General                 |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B        | 262k             | Code                    |
| `qwen3-next-80b`                 | Qwen3 Next 80B          | 262k             | General                 |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B           | 262k             | Vision                  |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k              | Fast, reasoning         |
| `deepseek-v3.2`                  | DeepSeek V3.2           | 163k             | Reasoning               |
| `venice-uncensored`              | Venice Uncensored       | 32k              | Uncensored              |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k             | Vision                  |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct    | 202k             | Vision                  |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B     | 131k             | General                 |
| `zai-org-glm-4.7`                | GLM 4.7                 | 202k             | Reasoning, multilingual |

### Anonymized Models (10) — Via Venice Proxy

| Model ID                 | Original          | Context (tokens) | Features          |
| ------------------------ | ----------------- | ---------------- | ----------------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k             | Reasoning, vision |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k             | Reasoning, vision |
| `openai-gpt-52`          | GPT-5.2           | 262k             | Reasoning         |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k             | Reasoning, vision |
| `gemini-3-pro-preview`   | Gemini 3 Pro      | 202k             | Reasoning, vision |
| `gemini-3-flash-preview` | Gemini 3 Flash    | 262k             | Reasoning, vision |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k             | Reasoning, vision |
| `grok-code-fast-1`       | Grok Code Fast 1  | 262k             | Reasoning, code   |
| `kimi-k2-thinking`       | Kimi K2 Thinking  | 262k             | Reasoning         |
| `minimax-m21`            | MiniMax M2.1      | 202k             | Reasoning         |

## Model Discovery

`VENICE_API_KEY` ကို သတ်မှတ်ထားပါက OpenClaw သည် Venice API မှ မော်ဒယ်များကို အလိုအလျောက် ရှာဖွေတွေ့ရှိပါသည်။ API ကို မရောက်ရှိနိုင်ပါက static catalog သို့ ပြန်လည် လဲလှယ်အသုံးပြုပါမည်။

`/models` endpoint သည် အများပြည်သူ အသုံးပြုနိုင်သည် (စာရင်းပြရန် auth မလိုအပ်) ဖြစ်သော်လည်း inference ပြုလုပ်ရန် မှန်ကန်သော API key လိုအပ်ပါသည်။

## Streaming & Tool Support

| Feature              | Support                                                             |
| -------------------- | ------------------------------------------------------------------- |
| **Streaming**        | ✅ မော်ဒယ်အားလုံး                                                   |
| **Function calling** | ✅ မော်ဒယ်အများစု (`supportsFunctionCalling` ကို API တွင် စစ်ဆေးပါ) |
| **Vision/Images**    | ✅ "Vision" feature အမှတ်အသား ပါသော မော်ဒယ်များ                     |
| **JSON mode**        | ✅ `response_format` မှတဆင့် ထောက်ပံ့ထားသည်                         |

## Pricing

Venice သည် credit-based စနစ်ကို အသုံးပြုသည်။ လက်ရှိ နှုန်းထားများအတွက် [venice.ai/pricing](https://venice.ai/pricing) ကို စစ်ဆေးပါ —

- **Private models**: ယေဘုယျအားဖြင့် ကုန်ကျစရိတ် နိမ့်
- **Anonymized models**: တိုက်ရိုက် API စျေးနှုန်းနှင့် ဆင်တူပြီး Venice အခကြေးငွေ အနည်းငယ် ပေါင်းထည့်ထားသည်

## Comparison: Venice vs Direct API

| Aspect       | Venice (Anonymized)               | Direct API                   |
| ------------ | --------------------------------- | ---------------------------- |
| **Privacy**  | Metadata ဖယ်ရှားပြီး အမည်မဖော်ထား | သင့်အကောင့်နှင့် ချိတ်ဆက်ထား |
| **Latency**  | +10-50ms (proxy)                  | တိုက်ရိုက်                   |
| **Features** | အင်္ဂါရပ် အများစု ထောက်ပံ့ထား     | အင်္ဂါရပ် အပြည့်အစုံ         |
| **Billing**  | Venice credits                    | Provider billing             |

## Usage Examples

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

## Troubleshooting

### API key not recognized

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

Key သည် `vapi_` ဖြင့် စတင်ကြောင်း သေချာစေပါ။

### Model not available

Venice မော်ဒယ် catalog သည် dynamic ဖြစ်ပြီး အဆက်မပြတ် အပ်ဒိတ်လုပ်နေပါသည်။ လက်ရှိ ရရှိနိုင်သော မော်ဒယ်များကို ကြည့်ရန် `openclaw models list` ကို လုပ်ဆောင်ပါ။ မော်ဒယ်အချို့သည် ယာယီ အော့ဖ်လိုင်း ဖြစ်နိုင်ပါသည်။

### Connection issues

Venice API သည် `https://api.venice.ai/api/v1` တွင် ရှိပါသည်။ သင့်ကွန်ယက်မှ HTTPS ချိတ်ဆက်မှုများကို ခွင့်ပြုထားကြောင်း သေချာစေပါ။

## Config file example

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

## Links

- [Venice AI](https://venice.ai)
- [API Documentation](https://docs.venice.ai)
- [Pricing](https://venice.ai/pricing)
- [Status](https://status.venice.ai)
