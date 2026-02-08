---
summary: "Patakbuhin ang OpenClaw gamit ang Ollama (lokal na LLM runtime)"
read_when:
  - Gusto mong patakbuhin ang OpenClaw gamit ang mga lokal na model sa pamamagitan ng Ollama
  - Kailangan mo ng gabay sa setup at konpigurasyon ng Ollama
title: "Ollama"
x-i18n:
  source_path: providers/ollama.md
  source_hash: 61f88017027beb20
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:57Z
---

# Ollama

Ang Ollama ay isang lokal na LLM runtime na nagpapadali sa pagpapatakbo ng mga open-source na model sa iyong machine. Nakikipag-integrate ang OpenClaw sa OpenAI-compatible API ng Ollama at maaaring **awtomatikong mag-discover ng mga model na may kakayahang gumamit ng tool** kapag nag-opt in ka gamit ang `OLLAMA_API_KEY` (o isang auth profile) at hindi ka nagde-define ng tahasang `models.providers.ollama` na entry.

## Mabilis na pagsisimula

1. I-install ang Ollama: [https://ollama.ai](https://ollama.ai)

2. Mag-pull ng model:

```bash
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
# or
ollama pull qwen2.5-coder:32b
# or
ollama pull deepseek-r1:32b
```

3. I-enable ang Ollama para sa OpenClaw (kahit anong value ay gagana; hindi nangangailangan ang Ollama ng totoong key):

```bash
# Set environment variable
export OLLAMA_API_KEY="ollama-local"

# Or configure in your config file
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Gamitin ang mga Ollama model:

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

Kapag itinakda mo ang `OLLAMA_API_KEY` (o isang auth profile) at **hindi** nagde-define ng `models.providers.ollama`, dini-discover ng OpenClaw ang mga model mula sa lokal na Ollama instance sa `http://127.0.0.1:11434`:

- Kinukuwery ang `/api/tags` at `/api/show`
- Pinananatili lamang ang mga model na nag-uulat ng kakayahang `tools`
- Minamarkahan ang `reasoning` kapag nag-uulat ang model ng `thinking`
- Binabasa ang `contextWindow` mula sa `model_info["<arch>.context_length"]` kapag available
- Itinatakda ang `maxTokens` sa 10× ng context window
- Itinatakda ang lahat ng gastos sa `0`

Iniiwasan nito ang manu-manong paglalagay ng model habang pinananatiling naka-align ang catalog sa mga kakayahan ng Ollama.

Para makita kung anong mga model ang available:

```bash
ollama list
openclaw models list
```

Para magdagdag ng bagong model, i-pull lang ito gamit ang Ollama:

```bash
ollama pull mistral
```

Ang bagong model ay awtomatikong madi-discover at magiging handang gamitin.

Kung tahasan mong itinakda ang `models.providers.ollama`, lalaktawan ang auto-discovery at kailangan mong mag-define ng mga model nang manu-mano (tingnan sa ibaba).

## Konpigurasyon

### Basic setup (implicit discovery)

Ang pinakasimpleng paraan para i-enable ang Ollama ay sa pamamagitan ng environment variable:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### Explicit setup (manual models)

Gumamit ng explicit config kapag:

- Ang Ollama ay tumatakbo sa ibang host/port.
- Gusto mong pilitin ang partikular na context window o listahan ng model.
- Gusto mong isama ang mga model na hindi nag-uulat ng tool support.

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

Kung itinakda ang `OLLAMA_API_KEY`, maaari mong alisin ang `apiKey` sa provider entry at pupunan ito ng OpenClaw para sa mga availability check.

### Custom base URL (explicit config)

Kung tumatakbo ang Ollama sa ibang host o port (dinidisable ng explicit config ang auto-discovery, kaya manu-manong i-define ang mga model):

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

### Pagpili ng model

Kapag naka-configure na, available na ang lahat ng iyong Ollama model:

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

### Mga reasoning model

Minamarkahan ng OpenClaw ang mga model bilang may kakayahang mag-reason kapag nag-uulat ang Ollama ng `thinking` sa `/api/show`:

```bash
ollama pull deepseek-r1:32b
```

### Mga Gastos ng Model

Libre ang Ollama at lokal na tumatakbo, kaya ang lahat ng gastos ng model ay nakatakda sa $0.

### Konpigurasyon ng Streaming

Dahil sa isang [kilalang isyu](https://github.com/badlogic/pi-mono/issues/1205) sa underlying SDK na may kinalaman sa response format ng Ollama, **naka-disable ang streaming bilang default** para sa mga Ollama model. Pinipigilan nito ang mga sirang response kapag gumagamit ng mga model na may kakayahang gumamit ng tool.

Kapag naka-disable ang streaming, ang mga response ay ipinapadala nang sabay-sabay (non-streaming mode), na umiiwas sa isyu kung saan ang magkahalong content/reasoning deltas ay nagdudulot ng magulong output.

#### Muling i-enable ang Streaming (Advanced)

Kung gusto mong muling i-enable ang streaming para sa Ollama (maaaring magdulot ng isyu sa mga model na may kakayahang gumamit ng tool):

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

#### I-disable ang Streaming para sa Ibang Provider

Maaari mo ring i-disable ang streaming para sa anumang provider kung kinakailangan:

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

### Mga context window

Para sa mga auto-discovered na model, ginagamit ng OpenClaw ang context window na iniulat ng Ollama kapag available, kung hindi ay nagde-default ito sa `8192`. Maaari mong i-override ang `contextWindow` at `maxTokens` sa explicit provider config.

## Pag-troubleshoot

### Hindi natukoy ang Ollama

Tiyaking tumatakbo ang Ollama at na itinakda mo ang `OLLAMA_API_KEY` (o isang auth profile), at **hindi** ka nag-define ng tahasang `models.providers.ollama` na entry:

```bash
ollama serve
```

At tiyaking naa-access ang API:

```bash
curl http://localhost:11434/api/tags
```

### Walang available na mga model

Awtomatikong dini-discover lamang ng OpenClaw ang mga model na nag-uulat ng tool support. Kung hindi nakalista ang iyong model, maaari mong:

- Mag-pull ng model na may tool support, o
- I-define ang model nang tahasan sa `models.providers.ollama`.

Para magdagdag ng mga model:

```bash
ollama list  # See what's installed
ollama pull gpt-oss:20b  # Pull a tool-capable model
ollama pull llama3.3     # Or another model
```

### Connection refused

Suriin na tumatakbo ang Ollama sa tamang port:

```bash
# Check if Ollama is running
ps aux | grep ollama

# Or restart Ollama
ollama serve
```

### Sirang mga response o mga pangalan ng tool sa output

Kung nakakakita ka ng magulong mga response na may kasamang mga pangalan ng tool (tulad ng `sessions_send`, `memory_get`) o pira-pirasong teksto kapag gumagamit ng mga Ollama model, ito ay dahil sa isang upstream SDK issue sa streaming responses. **Naayos na ito bilang default** sa pinakabagong bersyon ng OpenClaw sa pamamagitan ng pag-disable ng streaming para sa mga Ollama model.

Kung manu-mano mong in-enable ang streaming at naranasan ang isyung ito:

1. Alisin ang konpigurasyong `streaming: true` mula sa iyong mga Ollama model entry, o
2. Tahasang itakda ang `streaming: false` para sa mga Ollama model (tingnan ang [Konpigurasyon ng Streaming](#streaming-configuration))

## Tingnan din

- [Model Providers](/concepts/model-providers) - Pangkalahatang-ideya ng lahat ng provider
- [Model Selection](/concepts/models) - Paano pumili ng mga model
- [Configuration](/gateway/configuration) - Buong reference ng config
