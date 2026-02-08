---
summary: "Gamitin ang mga modelong nakatuon sa privacy ng Venice AI sa OpenClaw"
read_when:
  - Gusto mo ng inference na nakatuon sa privacy sa OpenClaw
  - Gusto mo ng gabay sa setup ng Venice AI
title: "Venice AI"
x-i18n:
  source_path: providers/venice.md
  source_hash: 2453a6ec3a715c24
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:03Z
---

# Venice AI (Venice highlight)

Ang **Venice** ay ang aming highlight na Venice setup para sa privacy-first inference na may opsyonal na anonymized na access sa mga proprietary na modelo.

Nagbibigay ang Venice AI ng AI inference na nakatuon sa privacy, na may suporta para sa uncensored na mga modelo at access sa mga pangunahing proprietary na modelo sa pamamagitan ng kanilang anonymized proxy. Lahat ng inference ay pribado bilang default—walang training sa iyong data, walang logging.

## Bakit Venice sa OpenClaw

- **Pribadong inference** para sa mga open-source na modelo (walang logging).
- **Uncensored na mga modelo** kapag kailangan mo ang mga ito.
- **Anonymized na access** sa mga proprietary na modelo (Opus/GPT/Gemini) kapag mahalaga ang kalidad.
- Mga endpoint na compatible sa OpenAI na `/v1`.

## Mga Mode ng Privacy

Nag-aalok ang Venice ng dalawang antas ng privacy — mahalagang maunawaan ito para makapili ng tamang modelo:

| Mode           | Paglalarawan                                                                                                                             | Mga Modelo                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Private**    | Ganap na pribado. Ang mga prompt/response ay **hindi kailanman iniimbak o nilolog**. Ephemeral.                                          | Llama, Qwen, DeepSeek, Venice Uncensored, atbp. |
| **Anonymized** | Dinadaan sa Venice na may tinanggal na metadata. Ang underlying provider (OpenAI, Anthropic) ay nakakakita ng anonymized na mga request. | Claude, GPT, Gemini, Grok, Kimi, MiniMax        |

## Mga Tampok

- **Nakatuon sa privacy**: Pumili sa pagitan ng "private" (ganap na pribado) at "anonymized" (proxied) na mga mode
- **Uncensored na mga modelo**: Access sa mga modelong walang content restrictions
- **Access sa pangunahing mga modelo**: Gumamit ng Claude, GPT-5.2, Gemini, Grok sa pamamagitan ng anonymized proxy ng Venice
- **OpenAI-compatible API**: Standard na mga endpoint na `/v1` para sa madaling integration
- **Streaming**: ✅ Supported sa lahat ng modelo
- **Function calling**: ✅ Supported sa piling mga modelo (tingnan ang kakayahan ng modelo)
- **Vision**: ✅ Supported sa mga modelong may vision capability
- **Walang hard rate limits**: Maaaring mag-apply ang fair-use throttling para sa sobrang paggamit

## Setup

### 1. Kumuha ng API Key

1. Mag-sign up sa [venice.ai](https://venice.ai)
2. Pumunta sa **Settings → API Keys → Create new key**
3. Kopyahin ang iyong API key (format: `vapi_xxxxxxxxxxxx`)

### 2. I-configure ang OpenClaw

**Opsyon A: Environment Variable**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Opsyon B: Interactive Setup (Inirerekomenda)**

```bash
openclaw onboard --auth-choice venice-api-key
```

Ito ay:

1. Hihingi ng iyong API key (o gagamit ng umiiral na `VENICE_API_KEY`)
2. Magpapakita ng lahat ng available na Venice models
3. Hahayaan kang pumili ng iyong default na modelo
4. Awtomatikong iko-configure ang provider

**Opsyon C: Non-interactive**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. I-verify ang Setup

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## Pagpili ng Modelo

Pagkatapos ng setup, ipinapakita ng OpenClaw ang lahat ng available na Venice models. Pumili batay sa iyong pangangailangan:

- **Default (aming rekomendasyon)**: `venice/llama-3.3-70b` para sa pribado at balanseng performance.
- **Pinakamahusay na overall quality**: `venice/claude-opus-45` para sa mahihirap na gawain (nanatiling pinakamalakas ang Opus).
- **Privacy**: Piliin ang mga "private" na modelo para sa ganap na pribadong inference.
- **Capability**: Piliin ang mga "anonymized" na modelo para ma-access ang Claude, GPT, Gemini sa pamamagitan ng proxy ng Venice.

Baguhin ang iyong default na modelo anumang oras:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

Ilista ang lahat ng available na modelo:

```bash
openclaw models list | grep venice
```

## I-configure sa pamamagitan ng `openclaw configure`

1. Patakbuhin ang `openclaw configure`
2. Piliin ang **Model/auth**
3. Piliin ang **Venice AI**

## Aling Modelo ang Dapat Kong Gamitin?

| Use Case                        | Inirerekomendang Modelo          | Bakit                                                         |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------- |
| **Pangkalahatang chat**         | `llama-3.3-70b`                  | Maganda sa lahat, ganap na pribado                            |
| **Pinakamahusay na quality**    | `claude-opus-45`                 | Nanatiling pinakamalakas ang Opus para sa mahihirap na gawain |
| **Privacy + kalidad ng Claude** | `claude-opus-45`                 | Pinakamahusay na reasoning sa pamamagitan ng anonymized proxy |
| **Coding**                      | `qwen3-coder-480b-a35b-instruct` | Code-optimized, 262k context                                  |
| **Mga vision task**             | `qwen3-vl-235b-a22b`             | Pinakamahusay na pribadong vision model                       |
| **Uncensored**                  | `venice-uncensored`              | Walang content restrictions                                   |
| **Mabilis + mura**              | `qwen3-4b`                       | Magaang, pero may kakayahan pa rin                            |
| **Complex reasoning**           | `deepseek-v3.2`                  | Malakas na reasoning, pribado                                 |

## Mga Available na Modelo (Kabuuang 25)

### Mga Private Model (15) — Ganap na Pribado, Walang Logging

| Model ID                         | Pangalan                | Context (tokens) | Mga Tampok              |
| -------------------------------- | ----------------------- | ---------------- | ----------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B           | 131k             | General                 |
| `llama-3.2-3b`                   | Llama 3.2 3B            | 131k             | Mabilis, magaang        |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B | 131k             | Complex na gawain       |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking     | 131k             | Reasoning               |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct     | 131k             | General                 |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B        | 262k             | Code                    |
| `qwen3-next-80b`                 | Qwen3 Next 80B          | 262k             | General                 |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B           | 262k             | Vision                  |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k              | Mabilis, reasoning      |
| `deepseek-v3.2`                  | DeepSeek V3.2           | 163k             | Reasoning               |
| `venice-uncensored`              | Venice Uncensored       | 32k              | Uncensored              |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k             | Vision                  |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct    | 202k             | Vision                  |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B     | 131k             | General                 |
| `zai-org-glm-4.7`                | GLM 4.7                 | 202k             | Reasoning, multilingual |

### Mga Anonymized Model (10) — Sa pamamagitan ng Venice Proxy

| Model ID                 | Orihinal          | Context (tokens) | Mga Tampok        |
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

Awtomatikong dini-discover ng OpenClaw ang mga modelo mula sa Venice API kapag naka-set ang `VENICE_API_KEY`. Kung hindi maabot ang API, babalik ito sa isang static na catalog.

Ang endpoint na `/models` ay public (walang auth na kailangan para sa listing), ngunit ang inference ay nangangailangan ng valid na API key.

## Streaming at Tool Support

| Tampok               | Suporta                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| **Streaming**        | ✅ Lahat ng modelo                                                        |
| **Function calling** | ✅ Karamihan ng mga modelo (tingnan ang `supportsFunctionCalling` sa API) |
| **Vision/Images**    | ✅ Mga modelong may markang "Vision" na tampok                            |
| **JSON mode**        | ✅ Supported sa pamamagitan ng `response_format`                          |

## Presyo

Gumagamit ang Venice ng credit-based na sistema. Tingnan ang [venice.ai/pricing](https://venice.ai/pricing) para sa kasalukuyang mga rate:

- **Mga private model**: Karaniwang mas mababa ang gastos
- **Mga anonymized model**: Katulad ng direktang API pricing + maliit na bayad ng Venice

## Paghahambing: Venice vs Direktang API

| Aspeto       | Venice (Anonymized)                | Direktang API              |
| ------------ | ---------------------------------- | -------------------------- |
| **Privacy**  | Tinanggal ang metadata, anonymized | Nakakabit sa iyong account |
| **Latency**  | +10-50ms (proxy)                   | Direkta                    |
| **Features** | Karamihan ng tampok ay supported   | Buong features             |
| **Billing**  | Venice credits                     | Billing ng provider        |

## Mga Halimbawa ng Paggamit

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

## Pag-troubleshoot

### Hindi nakikilala ang API key

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

Tiyaking nagsisimula ang key sa `vapi_`.

### Hindi available ang modelo

Dynamic na nag-a-update ang Venice model catalog. Patakbuhin ang `openclaw models list` para makita ang mga kasalukuyang available na modelo. Maaaring pansamantalang offline ang ilang modelo.

### Mga isyu sa koneksyon

Ang Venice API ay nasa `https://api.venice.ai/api/v1`. Tiyaking pinapayagan ng iyong network ang HTTPS connections.

## Halimbawa ng config file

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

## Mga Link

- [Venice AI](https://venice.ai)
- [API Documentation](https://docs.venice.ai)
- [Pricing](https://venice.ai/pricing)
- [Status](https://status.venice.ai)
