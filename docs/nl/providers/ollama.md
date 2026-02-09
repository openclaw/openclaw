---
summary: "OpenClaw uitvoeren met Ollama (lokale LLM-runtime)"
read_when:
  - Je wilt OpenClaw uitvoeren met lokale modellen via Ollama
  - Je hebt begeleiding nodig bij het opzetten en configureren van Ollama
title: "Ollama"
---

# Ollama

Ollama is een lokale LLM-runtime die het eenvoudig maakt om open-sourcemodellen op je eigen machine te draaien. OpenClaw integreert met de OpenAI-compatibele API van Ollama en kan **tool-geschikte modellen automatisch ontdekken** wanneer je dit inschakelt met `OLLAMA_API_KEY` (of een auth-profiel) en geen expliciete `models.providers.ollama`-vermelding definieert.

## Snelle start

1. Installeer Ollama: [https://ollama.ai](https://ollama.ai)

2. Haal een model op:

```bash
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
# or
ollama pull qwen2.5-coder:32b
# or
ollama pull deepseek-r1:32b
```

3. Schakel Ollama in voor OpenClaw (elke waarde werkt; Ollama vereist geen echte sleutel):

```bash
# Set environment variable
export OLLAMA_API_KEY="ollama-local"

# Or configure in your config file
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Gebruik Ollama-modellen:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/gpt-oss:20b" },
    },
  },
}
```

## Model discovery (impliciete provider)

Wanneer je `OLLAMA_API_KEY` instelt (of een auth-profiel) en **geen** `models.providers.ollama` definieert, ontdekt OpenClaw modellen van de lokale Ollama-instantie op `http://127.0.0.1:11434`:

- Vraagt `/api/tags` en `/api/show` op
- Behoudt alleen modellen die `tools`-capability rapporteren
- Markeert `reasoning` wanneer het model `thinking` rapporteert
- Leest `contextWindow` uit `model_info["<arch>.context_length"]` wanneer beschikbaar
- Stelt `maxTokens` in op 10× het contextvenster
- Stelt alle kosten in op `0`

Dit voorkomt handmatige modelvermeldingen terwijl de catalogus in lijn blijft met de mogelijkheden van Ollama.

Om te zien welke modellen beschikbaar zijn:

```bash
ollama list
openclaw models list
```

Om een nieuw model toe te voegen, haal je het eenvoudig op met Ollama:

```bash
ollama pull mistral
```

Het nieuwe model wordt automatisch ontdekt en is beschikbaar voor gebruik.

Als je `models.providers.ollama` expliciet instelt, wordt automatische discovery overgeslagen en moet je modellen handmatig definiëren (zie hieronder).

## Configuratie

### Basisinstallatie (impliciete discovery)

De eenvoudigste manier om Ollama in te schakelen is via een omgevingsvariabele:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### Expliciete installatie (handmatige modellen)

Gebruik expliciete config wanneer:

- Ollama op een andere host/poort draait.
- Je specifieke contextvensters of modellijsten wilt afdwingen.
- Je modellen wilt opnemen die geen tool-ondersteuning rapporteren.

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

Als `OLLAMA_API_KEY` is ingesteld, kun je `apiKey` in de providervermelding weglaten en zal OpenClaw deze invullen voor beschikbaarheidscontroles.

### Aangepaste base-URL (expliciete config)

Als Ollama op een andere host of poort draait (expliciete config schakelt automatische discovery uit, dus definieer modellen handmatig):

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

### Modelselectie

Na configuratie zijn al je Ollama-modellen beschikbaar:

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

## Geavanceerd

### Redeneermodellen

OpenClaw markeert modellen als redeneer-geschikt wanneer Ollama `thinking` rapporteert in `/api/show`:

```bash
ollama pull deepseek-r1:32b
```

### Modelkosten

Ollama is gratis en draait lokaal, dus alle modelkosten zijn ingesteld op $0.

### Streamingconfiguratie

Vanwege een [bekend probleem](https://github.com/badlogic/pi-mono/issues/1205) in de onderliggende SDK met het responsformaat van Ollama, is **streaming standaard uitgeschakeld** voor Ollama-modellen. Dit voorkomt corrupte responses bij het gebruik van tool-geschikte modellen.

Wanneer streaming is uitgeschakeld, worden responses in één keer geleverd (niet-streamingmodus), wat het probleem voorkomt waarbij verweven content-/redeneer-delta’s tot onleesbare uitvoer leiden.

#### Streaming opnieuw inschakelen (geavanceerd)

Als je streaming voor Ollama opnieuw wilt inschakelen (kan problemen veroorzaken met tool-geschikte modellen):

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

#### Streaming uitschakelen voor andere providers

Je kunt streaming ook uitschakelen voor elke provider indien nodig:

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

### Context vensters

Voor automatisch ontdekte modellen gebruikt OpenClaw het contextvenster dat door Ollama wordt gerapporteerd wanneer beschikbaar; anders wordt standaard `8192` gebruikt. Je kunt `contextWindow` en `maxTokens` overschrijven in expliciete providerconfig.

## Problemen oplossen

### Ollama niet gedetecteerd

Zorg ervoor dat Ollama draait en dat je `OLLAMA_API_KEY` (of een auth-profiel) hebt ingesteld, en dat je **geen** expliciete `models.providers.ollama`-vermelding hebt gedefinieerd:

```bash
ollama serve
```

En dat de API toegankelijk is:

```bash
curl http://localhost:11434/api/tags
```

### Geen modellen beschikbaar

OpenClaw ontdekt automatisch alleen modellen die tool-ondersteuning rapporteren. Als je model niet wordt weergegeven, doe dan een van de volgende dingen:

- Haal een tool-geschikt model op, of
- Definieer het model expliciet in `models.providers.ollama`.

Om modellen toe te voegen:

```bash
ollama list  # See what's installed
ollama pull gpt-oss:20b  # Pull a tool-capable model
ollama pull llama3.3     # Or another model
```

### Verbinding geweigerd

Controleer of Ollama op de juiste poort draait:

```bash
# Check if Ollama is running
ps aux | grep ollama

# Or restart Ollama
ollama serve
```

### Corrupte responses of toolnamen in de uitvoer

Als je onleesbare responses ziet met toolnamen (zoals `sessions_send`, `memory_get`) of gefragmenteerde tekst bij het gebruik van Ollama-modellen, komt dit door een upstream SDK-probleem met streamingresponses. **Dit is standaard opgelost** in de nieuwste OpenClaw-versie door streaming voor Ollama-modellen uit te schakelen.

Als je streaming handmatig hebt ingeschakeld en dit probleem ervaart:

1. Verwijder de `streaming: true`-configuratie uit je Ollama-modelvermeldingen, of
2. Stel `streaming: false` expliciet in voor Ollama-modellen (zie [Streamingconfiguratie](#streamingconfiguratie))

## Zie ook

- [Model Providers](/concepts/model-providers) - Overzicht van alle providers
- [Model Selection](/concepts/models) - Hoe je modellen kiest
- [Configuration](/gateway/configuration) - Volledige configreferentie
