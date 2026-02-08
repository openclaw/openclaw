---
summary: "Kør OpenClaw med Ollama (lokal LLM-runtime)"
read_when:
  - Du vil køre OpenClaw med lokale modeller via Ollama
  - Du har brug for vejledning til opsætning og konfiguration af Ollama
title: "Ollama"
x-i18n:
  source_path: providers/ollama.md
  source_hash: 61f88017027beb20
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:41Z
---

# Ollama

Ollama er en lokal LLM-runtime, der gør det nemt at køre open source-modeller på din maskine. OpenClaw integrerer med Ollamas OpenAI-kompatible API og kan **automatisk finde værktøjskompatible modeller**, når du tilmelder dig med `OLLAMA_API_KEY` (eller en auth-profil) og ikke definerer en eksplicit `models.providers.ollama`-post.

## Hurtig start

1. Installér Ollama: [https://ollama.ai](https://ollama.ai)

2. Hent en model:

```bash
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
# or
ollama pull qwen2.5-coder:32b
# or
ollama pull deepseek-r1:32b
```

3. Aktivér Ollama for OpenClaw (enhver værdi virker; Ollama kræver ikke en rigtig nøgle):

```bash
# Set environment variable
export OLLAMA_API_KEY="ollama-local"

# Or configure in your config file
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Brug Ollama-modeller:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/gpt-oss:20b" },
    },
  },
}
```

## Model discovery (implicit udbyder)

Når du sætter `OLLAMA_API_KEY` (eller en auth-profil) og **ikke** definerer `models.providers.ollama`, finder OpenClaw modeller fra den lokale Ollama-instans på `http://127.0.0.1:11434`:

- Forespørger `/api/tags` og `/api/show`
- Beholder kun modeller, der rapporterer `tools`-kapabilitet
- Marker­er `reasoning`, når modellen rapporterer `thinking`
- Læser `contextWindow` fra `model_info["<arch>.context_length"]`, når det er tilgængeligt
- Sætter `maxTokens` til 10× kontekstvinduet
- Sætter alle omkostninger til `0`

Dette undgår manuelle modelposter, samtidig med at kataloget holdes på linje med Ollamas kapabiliteter.

For at se hvilke modeller der er tilgængelige:

```bash
ollama list
openclaw models list
```

For at tilføje en ny model skal du blot hente den med Ollama:

```bash
ollama pull mistral
```

Den nye model vil automatisk blive fundet og være klar til brug.

Hvis du sætter `models.providers.ollama` eksplicit, springes auto-discovery over, og du skal definere modeller manuelt (se nedenfor).

## Konfiguration

### Grundlæggende opsætning (implicit discovery)

Den enkleste måde at aktivere Ollama på er via en miljøvariabel:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### Eksplicit opsætning (manuelle modeller)

Brug eksplicit konfiguration når:

- Ollama kører på en anden vært/port.
- Du vil gennemtvinge specifikke kontekstvinduer eller modellister.
- Du vil inkludere modeller, der ikke rapporterer værktøjsunderstøttelse.

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

Hvis `OLLAMA_API_KEY` er sat, kan du udelade `apiKey` i udbyderposten, og OpenClaw vil udfylde den til tilgængelighedstjek.

### Brugerdefineret base-URL (eksplicit konfiguration)

Hvis Ollama kører på en anden vært eller port (eksplicit konfiguration deaktiverer auto-discovery, så definér modeller manuelt):

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

### Modelvalg

Når det er konfigureret, er alle dine Ollama-modeller tilgængelige:

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

## Avanceret

### Reasoning-modeller

OpenClaw markerer modeller som reasoning-kompatible, når Ollama rapporterer `thinking` i `/api/show`:

```bash
ollama pull deepseek-r1:32b
```

### Modelomkostninger

Ollama er gratis og kører lokalt, så alle modelomkostninger er sat til $0.

### Streaming-konfiguration

På grund af et [kendt problem](https://github.com/badlogic/pi-mono/issues/1205) i det underliggende SDK med Ollamas responsformat er **streaming deaktiveret som standard** for Ollama-modeller. Dette forhindrer korrupte svar, når der bruges værktøjskompatible modeller.

Når streaming er deaktiveret, leveres svar samlet (ikke-streaming-tilstand), hvilket undgår problemet, hvor indflettede indholds-/reasoning-deltaer forårsager forvansket output.

#### Genaktivér streaming (avanceret)

Hvis du vil genaktivere streaming for Ollama (kan give problemer med værktøjskompatible modeller):

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

#### Deaktivér streaming for andre udbydere

Du kan også deaktivere streaming for enhver udbyder efter behov:

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

### Kontekstvinduer

For auto-fundne modeller bruger OpenClaw det kontekstvindue, som Ollama rapporterer, når det er tilgængeligt; ellers bruges standarden `8192`. Du kan tilsidesætte `contextWindow` og `maxTokens` i eksplicit udbyderkonfiguration.

## Fejlfinding

### Ollama ikke registreret

Sørg for, at Ollama kører, og at du har sat `OLLAMA_API_KEY` (eller en auth-profil), og at du **ikke** har defineret en eksplicit `models.providers.ollama`-post:

```bash
ollama serve
```

Og at API’et er tilgængeligt:

```bash
curl http://localhost:11434/api/tags
```

### Ingen modeller tilgængelige

OpenClaw finder automatisk kun modeller, der rapporterer værktøjsunderstøttelse. Hvis din model ikke er på listen, kan du enten:

- Hente en værktøjskompatibel model, eller
- Definere modellen eksplicit i `models.providers.ollama`.

For at tilføje modeller:

```bash
ollama list  # See what's installed
ollama pull gpt-oss:20b  # Pull a tool-capable model
ollama pull llama3.3     # Or another model
```

### Forbindelse afvist

Kontrollér, at Ollama kører på den korrekte port:

```bash
# Check if Ollama is running
ps aux | grep ollama

# Or restart Ollama
ollama serve
```

### Korrupte svar eller værktøjsnavne i output

Hvis du ser forvanskede svar med værktøjsnavne (som `sessions_send`, `memory_get`) eller fragmenteret tekst, når du bruger Ollama-modeller, skyldes det et opstrøms SDK-problem med streaming-svar. **Dette er løst som standard** i den nyeste OpenClaw-version ved at deaktivere streaming for Ollama-modeller.

Hvis du manuelt har aktiveret streaming og oplever dette problem:

1. Fjern `streaming: true`-konfigurationen fra dine Ollama-modelposter, eller
2. Sæt eksplicit `streaming: false` for Ollama-modeller (se [Streaming-konfiguration](#streaming-configuration))

## Se også

- [Modeludbydere](/concepts/model-providers) – Overblik over alle udbydere
- [Modelvalg](/concepts/models) – Sådan vælger du modeller
- [Konfiguration](/gateway/configuration) – Fuld konfigurationsreference
