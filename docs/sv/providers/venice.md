---
summary: "Använd Venice AI:s integritetsfokuserade modeller i OpenClaw"
read_when:
  - Du vill ha integritetsfokuserad inferens i OpenClaw
  - Du vill ha vägledning för konfiguration av Venice AI
title: "Venice AI"
---

# Venice AI (Venice-höjdpunkt)

**Venice** är vår utvalda Venice-konfiguration för integritetsförst inferens med valfri anonymiserad åtkomst till proprietära modeller.

Venice AI ger integritetsfokuserad AI-inferens med stöd för ocensurerade modeller och tillgång till stora egenutvecklade modeller genom deras anonymiserade proxy. All inferens är privat som standard – ingen utbildning på dina data, ingen loggning.

## Varför Venice i OpenClaw

- **Privat inferens** för open source-modeller (ingen loggning).
- **Ocensurerade modeller** när du behöver dem.
- **Anonymiserad åtkomst** till proprietära modeller (Opus/GPT/Gemini) när kvalitet är avgörande.
- OpenAI-kompatibla `/v1`-endpoints.

## Integritetslägen

Venice erbjuder två integritetsnivåer – att förstå dessa är avgörande för att välja rätt modell:

| Läge             | Beskrivning                                                                                                                                                                                                               | Modeller                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Privat**       | Helt privat. Fråga / svar är **aldrig lagrade eller loggade**. Flyktig.                                                                                                   | Llama, Qwen, DeepSeek, Venice Uncensored m.fl. |
| **Anonymiserat** | Proxied through Venice with metadata stripped. (Automatic Copy) Den underliggande leverantören (OpenAI, Anthropic) ser anonymiserade förfrågningar. | Claude, GPT, Gemini, Grok, Kimi, MiniMax                                       |

## Funktioner

- **Integritetsfokuserat**: Välj mellan ”privat” (helt privat) och ”anonymiserat” (proxat) läge
- **Ocensurerade modeller**: Åtkomst till modeller utan innehållsbegränsningar
- **Åtkomst till stora modeller**: Använd Claude, GPT-5.2, Gemini, Grok via Venices anonymiserade proxy
- **OpenAI-kompatibelt API**: Standard `/v1`-endpoints för enkel integration
- **Streaming**: ✅ Stöds på alla modeller
- **Function calling**: ✅ Stöds på utvalda modeller (kontrollera modellkapabiliteter)
- **Vision**: ✅ Stöds på modeller med vision-kapacitet
- **Inga hårda hastighetsgränser**: Fair-use-begränsning kan tillämpas vid extrem användning

## Konfigurering

### 1. Get API Key

1. Registrera dig på [venice.ai](https://venice.ai)
2. Gå till **Settings → API Keys → Create new key**
3. Kopiera din API-nyckel (format: `vapi_xxxxxxxxxxxx`)

### 2) Konfigurera OpenClaw

**Alternativ A: Miljövariabel**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Alternativ B: Interaktiv konfiguration (rekommenderas)**

```bash
openclaw onboard --auth-choice venice-api-key
```

Detta kommer att:

1. Be om din API-nyckel (eller använda befintlig `VENICE_API_KEY`)
2. Visa alla tillgängliga Venice-modeller
3. Låta dig välja din standardmodell
4. Konfigurera leverantören automatiskt

**Alternativ C: Icke-interaktiv**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. Verifiera installation

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## Modellval

Efter installationen visar OpenClaw alla tillgängliga modeller i Venedig. Välj baserat på dina behov:

- **Standard (vårt val)**: `venice/llama-3.3-70b` för privat, balanserad prestanda.
- **Bästa totala kvalitet**: `venice/claude-opus-45` för krävande uppgifter (Opus är fortfarande starkast).
- **Integritet**: Välj ”privata” modeller för helt privat inferens.
- **Kapacitet**: Välj ”anonymiserade” modeller för åtkomst till Claude, GPT, Gemini via Venices proxy.

Ändra din standardmodell när som helst:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

Lista alla tillgängliga modeller:

```bash
openclaw models list | grep venice
```

## Konfigurera via `openclaw configure`

1. Kör `openclaw configure`
2. Välj **Model/auth**
3. Välj **Venice AI**

## Vilken modell ska jag använda?

| Användningsfall                  | Rekommenderad modell             | Varför                                           |
| -------------------------------- | -------------------------------- | ------------------------------------------------ |
| **Allmän chatt**                 | `llama-3.3-70b`                  | Bra allround, helt privat                        |
| **Bästa totala kvalitet**        | `claude-opus-45`                 | Opus är fortfarande starkast för svåra uppgifter |
| **Integritet + Claude-kvalitet** | `claude-opus-45`                 | Bästa resonemang via anonymiserad proxy          |
| **Kodning**                      | `qwen3-coder-480b-a35b-instruct` | Kodoptimerad, 262k kontext                       |
| **Vision-uppgifter**             | `qwen3-vl-235b-a22b`             | Bästa privata vision-modell                      |
| **Ocensurerad**                  | `venice-uncensored`              | Inga innehållsbegränsningar                      |
| **Snabb + billig**               | `qwen3-4b`                       | Lättviktig men kapabel                           |
| **Komplext resonemang**          | `deepseek-v3.2`                  | Starkt resonemang, privat                        |

## Tillgängliga modeller (25 totalt)

### Privata modeller (15) — Helt privata, ingen loggning

| Modell-ID                        | Namn                                       | Kontext (token) | Funktioner              |
| -------------------------------- | ------------------------------------------ | ---------------------------------- | ----------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B              | 131k                               | Allmänt                 |
| `llama-3.2-3b`                   | Llama 3.2 3B               | 131k                               | Snabb, lättviktig       |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B    | 131k                               | Komplexa uppgifter      |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking                        | 131k                               | Resonemang              |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct                        | 131k                               | Allmänt                 |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B                           | 262k                               | Kod                     |
| `qwen3-next-80b`                 | Qwen3 Next 80B                             | 262k                               | Allmänt                 |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B                              | 262k                               | Vision                  |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k                                | Snabb, resonemang       |
| `deepseek-v3.2`                  | DeepSeek V3.2              | 163k                               | Resonemang              |
| `venice-uncensored`              | Venice Uncensored                          | 32k                                | Ocensurerad             |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k                               | Vision                  |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct                       | 202k                               | Vision                  |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B                        | 131k                               | Allmänt                 |
| `zai-org-glm-4.7`                | GLM 4.7                    | 202k                               | Resonemang, flerspråkig |

### Anonymiserade modeller (10) — Via Venice-proxy

| Modell-ID                | Original                          | Kontext (token) | Funktioner         |
| ------------------------ | --------------------------------- | ---------------------------------- | ------------------ |
| `claude-opus-45`         | Claude Opus 4.5   | 202k                               | Resonemang, vision |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k                               | Resonemang, vision |
| `openai-gpt-52`          | GPT-5.2           | 262k                               | Resonemang         |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k                               | Resonemang, vision |
| `gemini-3-pro-preview`   | Gemini 3 Pro                      | 202k                               | Resonemang, vision |
| `gemini-3-flash-preview` | Gemini 3 Flash                    | 262k                               | Resonemang, vision |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k                               | Resonemang, vision |
| `grok-code-fast-1`       | Grok Code Fast 1                  | 262k                               | Resonemang, kod    |
| `kimi-k2-thinking`       | Kimi K2 Thinking                  | 262k                               | Resonemang         |
| `minimax-m21`            | MiniMax M2.1      | 202k                               | Resonemang         |

## Model Discovery

OpenClaw upptäcker automatiskt modeller från Venedig API när `VENICE_API_KEY` är satt. Om API:et inte kan nås, faller det tillbaka till en statisk katalog.

`/models`-endpointen är publik (ingen autentisering krävs för listning), men inferens kräver en giltig API-nyckel.

## Streaming och verktygsstöd

| Funktion             | Stöd                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------- |
| **Streaming**        | ✅ Alla modeller                                                                       |
| **Function calling** | ✅ De flesta modeller (kontrollera `supportsFunctionCalling` i API) |
| **Vision/Bilder**    | ✅ Modeller markerade med funktionen ”Vision”                                          |
| **JSON-läge**        | ✅ Stöds via `response_format`                                                         |

## Prissättning

Venedig använder ett kreditbaserat system. Kontrollera [venice.ai/pricing](https://venice.ai/pricing) för aktuella priser:

- **Privata modeller**: Generellt lägre kostnad
- **Anonymiserade modeller**: Liknar direkt API-prissättning + en liten Venice-avgift

## Jämförelse: Venice vs direkt API

| Aspekt          | Venice (anonymiserat) | Direkt API                |
| --------------- | ---------------------------------------- | ------------------------- |
| **Integritet**  | Metadata borttagen, anonymiserad         | Ditt konto kopplat        |
| **Latens**      | +10–50 ms (proxy)     | Direkt                    |
| **Funktioner**  | De flesta funktioner stöds               | Fullständiga funktioner   |
| **Fakturering** | Venice-krediter                          | Leverantörens fakturering |

## Användningsexempel

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

## Felsökning

### API-nyckel känns inte igen

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

Säkerställ att nyckeln börjar med `vapi_`.

### Modell ej tillgänglig

Venedigs modellkatalog uppdateras dynamiskt. Kör "openclaw models list" för att se tillgängliga modeller. Vissa modeller kan vara tillfälligt offline.

### Anslutningsproblem

Venedig API är på `https://api.venice.ai/api/v1`. Se till att ditt nätverk tillåter HTTPS-anslutningar.

## Exempel på konfigfil

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

## Länkar

- [Venice AI](https://venice.ai)
- [API-dokumentation](https://docs.venice.ai)
- [Prissättning](https://venice.ai/pricing)
- [Status](https://status.venice.ai)
