---
summary: "Brug Venice AI’s privatlivsfokuserede modeller i OpenClaw"
read_when:
  - Du vil have privatlivsfokuseret inferens i OpenClaw
  - Du vil have vejledning til opsætning af Venice AI
title: "Venice AI"
---

# Venice AI (Venice-højdepunkt)

**Venice** er vores fremhævede Venice-opsætning til privacy-first inferens med valgfri anonymiseret adgang til proprietære modeller.

Venice AI giver privatlivets fred fokuseret AI inferens med støtte til ucensurerede modeller og adgang til store proprietære modeller gennem deres anonymiserede proxy. Al inferens er som standard privat – ingen træning i dine data, ingen logning.

## Hvorfor Venice i OpenClaw

- **Privat inferens** for open source-modeller (ingen logning).
- **Ucensurerede modeller**, når du har brug for dem.
- **Anonymiseret adgang** til proprietære modeller (Opus/GPT/Gemini), når kvalitet er afgørende.
- OpenAI-kompatible `/v1`-endpoints.

## Privatlivstilstande

Venice tilbyder to privatlivsniveauer — det er afgørende at forstå dem for at vælge den rette model:

| Tilstand         | Beskrivelse                                                                                                                                                                     | Modeller                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Privat**       | Fuldt privat. Forslag/svar er **aldrig gemt eller logget**. Flygtig.                                                            | Llama, Qwen, DeepSeek, Venice Uncensored m.fl. |
| **Anonymiseret** | Tilpasset gennem Venedig med metadata strippet. Den underliggende udbyder (OpenAI, Anthropic) ser anonymiserede anmodninger. | Claude, GPT, Gemini, Grok, Kimi, MiniMax                                       |

## Funktioner

- **Privatlivsfokuseret**: Vælg mellem "privat" (fuldt privat) og "anonymiseret" (proxy) tilstande
- **Ucensurerede modeller**: Adgang til modeller uden indholdsbegrænsninger
- **Adgang til store modeller**: Brug Claude, GPT-5.2, Gemini, Grok via Venices anonymiserede proxy
- **OpenAI-kompatibelt API**: Standard `/v1`-endpoints for nem integration
- **Streaming**: ✅ Understøttet på alle modeller
- **Function calling**: ✅ Understøttet på udvalgte modeller (tjek modelkapaciteter)
- **Vision**: ✅ Understøttet på modeller med vision-kapacitet
- **Ingen hårde rate limits**: Fair-use-begrænsning kan forekomme ved ekstrem brug

## Opsætning

### 1. Get API Key

1. Tilmeld dig på [venice.ai](https://venice.ai)
2. Gå til **Settings → API Keys → Create new key**
3. Kopiér din API-nøgle (format: `vapi_xxxxxxxxxxxx`)

### 2) Konfigurér OpenClaw

**Mulighed A: Miljøvariabel**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Mulighed B: Interaktiv opsætning (anbefalet)**

```bash
openclaw onboard --auth-choice venice-api-key
```

Dette vil:

1. Spørge efter din API-nøgle (eller bruge eksisterende `VENICE_API_KEY`)
2. Vise alle tilgængelige Venice-modeller
3. Lade dig vælge din standardmodel
4. Konfigurere udbyderen automatisk

**Mulighed C: Ikke-interaktiv**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. Verificér Opsætning

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## Modelvalg

Efter opsætning, OpenClaw viser alle tilgængelige Venedig modeller. Vælg baseret på dine behov:

- **Standard (vores valg)**: `venice/llama-3.3-70b` for privat, afbalanceret ydeevne.
- **Bedste samlede kvalitet**: `venice/claude-opus-45` til krævende opgaver (Opus er fortsat den stærkeste).
- **Privatliv**: Vælg "private" modeller for fuldt privat inferens.
- **Kapabilitet**: Vælg "anonymiserede" modeller for adgang til Claude, GPT, Gemini via Venices proxy.

Skift din standardmodel når som helst:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

List alle tilgængelige modeller:

```bash
openclaw models list | grep venice
```

## Konfigurer via `openclaw configure`

1. Kør `openclaw configure`
2. Vælg **Model/auth**
3. Vælg **Venice AI**

## Hvilken model skal jeg bruge?

| Brugsscenarie                   | Anbefalet model                  | Hvorfor                                         |
| ------------------------------- | -------------------------------- | ----------------------------------------------- |
| **Generel chat**                | `llama-3.3-70b`                  | God allround, fuldt privat                      |
| **Bedste samlede kvalitet**     | `claude-opus-45`                 | Opus er fortsat den stærkeste til svære opgaver |
| **Privatliv + Claude-kvalitet** | `claude-opus-45`                 | Bedste ræsonnering via anonymiseret proxy       |
| **Kodning**                     | `qwen3-coder-480b-a35b-instruct` | Kodeoptimeret, 262k kontekst                    |
| **Vision-opgaver**              | `qwen3-vl-235b-a22b`             | Bedste private vision-model                     |
| **Ucensureret**                 | `venice-uncensored`              | Ingen indholdsbegrænsninger                     |
| **Hurtig + billig**             | `qwen3-4b`                       | Letvægts, stadig kapabel                        |
| **Kompleks ræsonnering**        | `deepseek-v3.2`                  | Stærk ræsonnering, privat                       |

## Tilgængelige modeller (25 i alt)

### Private modeller (15) — Fuldt private, ingen logning

| Model-ID                         | Navn                                       | Kontekst (tokens) | Funktioner               |
| -------------------------------- | ------------------------------------------ | ------------------------------------ | ------------------------ |
| `llama-3.3-70b`                  | Llama 3.3 70B              | 131k                                 | Generel                  |
| `llama-3.2-3b`                   | Llama 3.2 3B               | 131k                                 | Hurtig, letvægts         |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B    | 131k                                 | Komplekse opgaver        |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking                        | 131k                                 | Ræsonnering              |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct                        | 131k                                 | Generel                  |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B                           | 262k                                 | Kode                     |
| `qwen3-next-80b`                 | Qwen3 Next 80B                             | 262k                                 | Generel                  |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B                              | 262k                                 | Vision                   |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k                                  | Hurtig, ræsonnering      |
| `deepseek-v3.2`                  | DeepSeek V3.2              | 163k                                 | Ræsonnering              |
| `venice-uncensored`              | Venice Uncensored                          | 32k                                  | Ucensureret              |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k                                 | Vision                   |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct                       | 202k                                 | Vision                   |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B                        | 131k                                 | Generel                  |
| `zai-org-glm-4.7`                | GLM 4.7                    | 202k                                 | Ræsonnering, flersproget |

### Anonymiserede modeller (10) — Via Venice-proxy

| Model-ID                 | Original                          | Kontekst (tokens) | Funktioner          |
| ------------------------ | --------------------------------- | ------------------------------------ | ------------------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k                                 | Ræsonnering, vision |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k                                 | Ræsonnering, vision |
| `openai-gpt-52`          | GPT-5.2           | 262k                                 | Ræsonnering         |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k                                 | Ræsonnering, vision |
| `gemini-3-pro-preview`   | Gemini 3 Pro                      | 202k                                 | Ræsonnering, vision |
| `gemini-3-flash-preview` | Gemini 3 Flash                    | 262k                                 | Ræsonnering, vision |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k                                 | Ræsonnering, vision |
| `grok-code-fast-1`       | Grok Code Fast 1                  | 262k                                 | Ræsonnering, kode   |
| `kimi-k2-thinking`       | Kimi K2 Thinking                  | 262k                                 | Ræsonnering         |
| `minimax-m21`            | MiniMax M2.1      | 202k                                 | Ræsonnering         |

## Model Discovery

OpenClaw opdager automatisk modeller fra Venedig API, når `VENICE_API_KEY` er sat. Hvis API'en ikke er tilgængelig, falder den tilbage til et statisk katalog.

`/models`-endpointet er offentligt (ingen auth kræves for listning), men inferens kræver en gyldig API-nøgle.

## Streaming & værktøjsunderstøttelse

| Funktion             | Understøttelse                                                                 |
| -------------------- | ------------------------------------------------------------------------------ |
| **Streaming**        | ✅ Alle modeller                                                                |
| **Function calling** | ✅ De fleste modeller (tjek `supportsFunctionCalling` i API) |
| **Vision/Billeder**  | ✅ Modeller markeret med "Vision"-funktionen                                    |
| **JSON-tilstand**    | ✅ Understøttet via `response_format`                                           |

## Priser

Venedig bruger et kreditbaseret system. Check [venice.ai/pricing](https://venice.ai/pricing) for aktuelle satser:

- **Private modeller**: Generelt lavere pris
- **Anonymiserede modeller**: Ligner direkte API-priser + et lille Venice-gebyr

## Sammenligning: Venice vs. direkte API

| Aspekt          | Venice (anonymiseret) | Direkte API          |
| --------------- | ---------------------------------------- | -------------------- |
| **Privatliv**   | Metadata fjernet, anonymiseret           | Din konto er knyttet |
| **Latency**     | +10–50 ms (proxy)     | Direkte              |
| **Funktioner**  | De fleste funktioner understøttet        | Alle funktioner      |
| **Fakturering** | Venice-kreditter                         | Udbyderfakturering   |

## Brugseksempler

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

## Fejlfinding

### API-nøgle genkendes ikke

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

Sørg for, at nøglen starter med `vapi_`.

### Model ikke tilgængelig

Venedig model katalog opdateringer dynamisk. Kør 'openclaw modelliste' for at se aktuelt tilgængelige modeller. Nogle modeller kan være midlertidigt offline.

### Forbindelsesproblemer

Venice API er på `https://api.venice.ai/api/v1`. Sørg for, at dit netværk tillader HTTPS-forbindelser.

## Eksempel på konfigurationsfil

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
- [API-dokumentation](https://docs.venice.ai)
- [Priser](https://venice.ai/pricing)
- [Status](https://status.venice.ai)
