---
summary: "Gebruik privacygerichte modellen van Venice AI in OpenClaw"
read_when:
  - Je wilt privacygerichte inferentie in OpenClaw
  - Je wilt begeleide installatie van Venice AI
title: "Venice AI"
---

# Venice AI (Venice-highlight)

**Venice** is onze uitgelichte Venice-configuratie voor privacy-first inferentie met optionele geanonimiseerde toegang tot propriëtaire modellen.

Venice AI biedt privacygerichte AI-inferentie met ondersteuning voor ongecensureerde modellen en toegang tot grote propriëtaire modellen via hun geanonimiseerde proxy. Alle inferentie is standaard privé — geen training op je data, geen logging.

## Waarom Venice in OpenClaw

- **Privé-inferentie** voor open-sourcemodellen (geen logging).
- **Ongecensureerde modellen** wanneer je die nodig hebt.
- **Geanonimiseerde toegang** tot propriëtaire modellen (Opus/GPT/Gemini) wanneer kwaliteit telt.
- OpenAI-compatibele `/v1`-endpoints.

## Privacy-modi

Venice biedt twee privacyniveaus — dit begrijpen is essentieel voor het kiezen van je model:

| Modus              | Beschrijving                                                                                                                                                                    | Modellen                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Privé**          | Volledig privé. Prompts/antwoorden worden **nooit opgeslagen of gelogd**. Ephemeral.                                            | Llama, Qwen, DeepSeek, Venice Uncensored, enz. |
| **Geanonimiseerd** | Via Venice geproxied met verwijderde metadata. De onderliggende provider (OpenAI, Anthropic) ziet geanonimiseerde verzoeken. | Claude, GPT, Gemini, Grok, Kimi, MiniMax                       |

## Functies

- **Privacygericht**: Kies tussen de modi "privé" (volledig privé) en "geanonimiseerd" (geproxied)
- **Ongecensureerde modellen**: Toegang tot modellen zonder inhoudsbeperkingen
- **Toegang tot grote modellen**: Gebruik Claude, GPT-5.2, Gemini, Grok via de geanonimiseerde proxy van Venice
- **OpenAI-compatibele API**: Standaard `/v1`-endpoints voor eenvoudige integratie
- **Streaming**: ✅ Ondersteund op alle modellen
- **Function calling**: ✅ Ondersteund op geselecteerde modellen (controleer modelmogelijkheden)
- **Vision**: ✅ Ondersteund op modellen met vision-capaciteit
- **Geen harde rate limits**: Fair-use-throttling kan van toepassing zijn bij extreem gebruik

## Installatie

### 1. Verkrijg een API-sleutel

1. Meld je aan op [venice.ai](https://venice.ai)
2. Ga naar **Settings → API Keys → Create new key**
3. Kopieer je API-sleutel (indeling: `vapi_xxxxxxxxxxxx`)

### 2) OpenClaw configureren

**Optie A: Omgevingsvariabele**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Optie B: Interactieve installatie (aanbevolen)**

```bash
openclaw onboard --auth-choice venice-api-key
```

Dit zal:

1. Vragen om je API-sleutel (of de bestaande `VENICE_API_KEY` gebruiken)
2. Alle beschikbare Venice-modellen tonen
3. Je laten kiezen wat je standaardmodel is
4. De provider automatisch configureren

**Optie C: Niet-interactief**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. Installatie verifiëren

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## Modelselectie

Na de installatie toont OpenClaw alle beschikbare Venice-modellen. Kies op basis van je behoeften:

- **Standaard (onze keuze)**: `venice/llama-3.3-70b` voor privé, gebalanceerde prestaties.
- **Beste algehele kwaliteit**: `venice/claude-opus-45` voor zware taken (Opus blijft het sterkst).
- **Privacy**: Kies "privé"-modellen voor volledig privé-inferentie.
- **Capaciteit**: Kies "geanonimiseerde" modellen om via de proxy van Venice toegang te krijgen tot Claude, GPT, Gemini.

Wijzig je standaardmodel op elk moment:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

Lijst alle beschikbare modellen:

```bash
openclaw models list | grep venice
```

## Configureren via `openclaw configure`

1. Voer `openclaw configure` uit
2. Selecteer **Model/auth**
3. Kies **Venice AI**

## Welk model moet ik gebruiken?

| Gebruiksscenario               | Aanbevolen model                 | Waarom                                           |
| ------------------------------ | -------------------------------- | ------------------------------------------------ |
| **Algemene chat**              | `llama-3.3-70b`                  | Goede allrounder, volledig privé                 |
| **Beste algehele kwaliteit**   | `claude-opus-45`                 | Opus blijft het sterkst voor zware taken         |
| **Privacy + Claude-kwaliteit** | `claude-opus-45`                 | Beste redeneervermogen via geanonimiseerde proxy |
| **Coderen**                    | `qwen3-coder-480b-a35b-instruct` | Code-geoptimaliseerd, 262k context               |
| **Vision-taken**               | `qwen3-vl-235b-a22b`             | Beste privé vision-model                         |
| **Ongecensureerd**             | `venice-uncensored`              | Geen inhoudsbeperkingen                          |
| **Snel + goedkoop**            | `qwen3-4b`                       | Lichtgewicht, nog steeds capabel                 |
| **Complex redeneren**          | `deepseek-v3.2`                  | Sterk redeneervermogen, privé                    |

## Beschikbare modellen (25 totaal)

### Privémodellen (15) — Volledig privé, geen logging

| Model-ID                         | Naam                                       | Context (tokens) | Functies           |
| -------------------------------- | ------------------------------------------ | ----------------------------------- | ------------------ |
| `llama-3.3-70b`                  | Llama 3.3 70B              | 131k                                | Algemeen           |
| `llama-3.2-3b`                   | Llama 3.2 3B               | 131k                                | Snel, lichtgewicht |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B    | 131k                                | Complexe taken     |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking                        | 131k                                | Redeneren          |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct                        | 131k                                | Algemeen           |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B                           | 262k                                | Code               |
| `qwen3-next-80b`                 | Qwen3 Next 80B                             | 262k                                | Algemeen           |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B                              | 262k                                | Vision             |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k                                 | Snel, redeneren    |
| `deepseek-v3.2`                  | DeepSeek V3.2              | 163k                                | Redeneren          |
| `venice-uncensored`              | Venice Uncensored                          | 32k                                 | Ongecensureerd     |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k                                | Vision             |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct                       | 202k                                | Vision             |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B                        | 131k                                | Algemeen           |
| `zai-org-glm-4.7`                | GLM 4.7                    | 202k                                | Reden, meertalig   |

### Geanonimiseerde modellen (10) — Via Venice-proxy

| Model-ID                 | Oorspronkelijk                    | Context (tokens) | Functies          |
| ------------------------ | --------------------------------- | ----------------------------------- | ----------------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k                                | Redeneren, vision |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k                                | Redeneren, vision |
| `openai-gpt-52`          | GPT-5.2           | 262k                                | Redeneren         |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k                                | Redeneren, vision |
| `gemini-3-pro-preview`   | Gemini 3 Pro                      | 202k                                | Redeneren, vision |
| `gemini-3-flash-preview` | Gemini 3 Flash                    | 262k                                | Redeneren, vision |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k                                | Redeneren, vision |
| `grok-code-fast-1`       | Grok Code Fast 1                  | 262k                                | Redeneren, code   |
| `kimi-k2-thinking`       | Kimi K2 Thinking                  | 262k                                | Redeneren         |
| `minimax-m21`            | MiniMax M2.1      | 202k                                | Redeneren         |

## Model Discovery

OpenClaw ontdekt automatisch modellen via de Venice API wanneer `VENICE_API_KEY` is ingesteld. Als de API onbereikbaar is, valt het terug op een statische catalogus.

Het `/models`-endpoint is openbaar (geen authenticatie nodig voor lijsten), maar inferentie vereist een geldige API-sleutel.

## Streaming & tool-ondersteuning

| Functie              | Ondersteuning                                                                         |
| -------------------- | ------------------------------------------------------------------------------------- |
| **Streaming**        | ✅ Alle modellen                                                                       |
| **Function calling** | ✅ De meeste modellen (controleer `supportsFunctionCalling` in API) |
| **Vision/Images**    | ✅ Modellen gemarkeerd met de functie "Vision"                                         |
| **JSON-modus**       | ✅ Ondersteund via `response_format`                                                   |

## Prijzen

Venice gebruikt een creditsysteem. Bekijk [venice.ai/pricing](https://venice.ai/pricing) voor actuele tarieven:

- **Privémodellen**: Over het algemeen lagere kosten
- **Geanonimiseerde modellen**: Vergelijkbaar met directe API-prijzen + een kleine Venice-toeslag

## Vergelijking: Venice vs Directe API

| Aspect         | Venice (geanonimiseerd) | Directe API              |
| -------------- | ------------------------------------------ | ------------------------ |
| **Privacy**    | Metadata verwijderd, geanonimiseerd        | Je account gekoppeld     |
| **Latency**    | +10–50 ms (proxy)       | Direct                   |
| **Functies**   | Meeste functies ondersteund                | Volledige functies       |
| **Facturatie** | Venice-credits                             | Facturatie door provider |

## Gebruiksvoorbeelden

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

## Problemen oplossen

### API-sleutel niet herkend

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

Zorg ervoor dat de sleutel begint met `vapi_`.

### Model niet beschikbaar

De Venice-modelcatalogus wordt dynamisch bijgewerkt. Voer `openclaw models list` uit om de momenteel beschikbare modellen te zien. Sommige modellen kunnen tijdelijk offline zijn.

### Verbindingsproblemen

De Venice API bevindt zich op `https://api.venice.ai/api/v1`. Zorg ervoor dat je netwerk HTTPS-verbindingen toestaat.

## Voorbeeld van configbestand

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
- [API-documentatie](https://docs.venice.ai)
- [Prijzen](https://venice.ai/pricing)
- [Status](https://status.venice.ai)
