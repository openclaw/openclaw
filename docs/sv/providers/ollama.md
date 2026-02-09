---
summary: "Kör OpenClaw med Ollama (lokal LLM‑runtime)"
read_when:
  - Du vill köra OpenClaw med lokala modeller via Ollama
  - Du behöver vägledning för installation och konfiguration av Ollama
title: "Ollama"
---

# Ollama

Ollama är en lokal LLM runtime som gör det enkelt att köra open-source modeller på din maskin. OpenClaw integrerar med Ollamas OpenAI-kompatibla API och kan **automatiskt upptäcka verktygskompatibla modeller** när du väljer in med `OLLAMA_API_KEY` (eller en auth profil) och definierar inte en explicit `modell. roviders.ollama`-post.

## Snabbstart

1. Installera Ollama: [https://ollama.ai](https://ollama.ai)

2. Hämta en modell:

```bash
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
# or
ollama pull qwen2.5-coder:32b
# or
ollama pull deepseek-r1:32b
```

3. Aktivera Ollama för OpenClaw (valfritt värde fungerar; Ollama kräver ingen riktig nyckel):

```bash
# Set environment variable
export OLLAMA_API_KEY="ollama-local"

# Or configure in your config file
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Använd Ollama‑modeller:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/gpt-oss:20b" },
    },
  },
}
```

## Modellupptäckt (implicit leverantör)

När du sätter `OLLAMA_API_KEY` (eller en autentiseringsprofil) och **inte** definierar `models.providers.ollama`, upptäcker OpenClaw modeller från den lokala Ollama‑instansen på `http://127.0.0.1:11434`:

- Frågar `/api/tags` och `/api/show`
- Behåller endast modeller som rapporterar kapaciteten `tools`
- Markerar `reasoning` när modellen rapporterar `thinking`
- Läser `contextWindow` från `model_info["<arch>.context_length"]` när tillgängligt
- Sätter `maxTokens` till 10× kontextfönstret
- Sätter alla kostnader till `0`

Detta undviker manuella modellposter samtidigt som katalogen hålls i linje med Ollamas kapabiliteter.

För att se vilka modeller som är tillgängliga:

```bash
ollama list
openclaw models list
```

För att lägga till en ny modell, hämta den helt enkelt med Ollama:

```bash
ollama pull mistral
```

Den nya modellen kommer automatiskt att upptäckas och bli tillgänglig att använda.

Om du sätter `models.providers.ollama` explicit hoppas auto‑upptäckt över och du måste definiera modeller manuellt (se nedan).

## Konfiguration

### Grundläggande konfiguration (implicit upptäckt)

Det enklaste sättet att aktivera Ollama är via en miljövariabel:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### Explicit konfiguration (manuella modeller)

Använd explicit konfig när:

- Ollama körs på en annan värd/port.
- Du vill tvinga specifika kontextfönster eller modellistor.
- Du vill inkludera modeller som inte rapporterar verktygsstöd.

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

Om `OLLAMA_API_KEY` är satt kan du utelämna `apiKey` i leverantörsposten och OpenClaw fyller i den för tillgänglighetskontroller.

### Anpassad bas‑URL (explicit konfig)

Om Ollama körs på en annan värd eller port (explicit konfig inaktiverar auto‑upptäckt, så definiera modeller manuellt):

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

### Modellval

När konfigurationen är klar är alla dina Ollama‑modeller tillgängliga:

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

## Avancerat

### Resonemangsmodeller

OpenClaw markerar modeller som resonemangskapabla när Ollama rapporterar `thinking` i `/api/show`:

```bash
ollama pull deepseek-r1:32b
```

### Modellkostnader

Ollama är gratis och körs lokalt, så alla modellkostnader sätts till $0.

### Strömningskonfiguration

På grund av ett [känt problem](https://github.com/badlogic/pi-mono/issues/1205) i det underliggande SDK med Ollamas svarsformat, inaktiveras **strömning som standard** för Ollama-modeller. Detta förhindrar skadade svar vid användning av verktygsburna modeller.

När strömning är inaktiverad levereras svaren i ett stycke (icke‑strömmande läge), vilket undviker problemet där sammanflätade innehålls‑/resonemangsdelar orsakar förvrängt utdata.

#### Återaktivera strömning (avancerat)

Om du vill återaktivera strömning för Ollama (kan orsaka problem med verktygskapabla modeller):

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

#### Inaktivera strömning för andra leverantörer

Du kan också inaktivera strömning för valfri leverantör vid behov:

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

### Kontextfönster

För auto-upptäckta modeller använder OpenClaw kontextfönstret som rapporterats av Ollama när det är tillgängligt, annars är standardinställningen `8192`. Du kan åsidosätta `contextWindow` och `maxTokens` i explicit provider config.

## Felsökning

### Ollama upptäcks inte

Se till att Ollama körs och att du har satt `OLLAMA_API_KEY` (eller en autentiseringsprofil), och att du **inte** har definierat en explicit `models.providers.ollama`‑post:

```bash
ollama serve
```

Och att API:t är åtkomligt:

```bash
curl http://localhost:11434/api/tags
```

### Inga modeller tillgängliga

OpenClaw upptäcker endast modeller som rapporterar verktygsstöd. Om din modell inte är listad, antingen:

- Hämta en verktygskapabel modell, eller
- Definiera modellen explicit i `models.providers.ollama`.

För att lägga till modeller:

```bash
ollama list  # See what's installed
ollama pull gpt-oss:20b  # Pull a tool-capable model
ollama pull llama3.3     # Or another model
```

### Anslutning nekad

Kontrollera att Ollama körs på rätt port:

```bash
# Check if Ollama is running
ps aux | grep ollama

# Or restart Ollama
ollama serve
```

### Korrupta svar eller verktygsnamn i utdata

Om du ser förvanskade svar med verktygsnamn (som `sessions_send`, `memory_get`) eller fragmenterad text vid användning av Ollama-modeller, detta beror på ett uppströms SDK-problem med strömningssvar. **Detta rättas som standard** i den senaste OpenClaw-versionen genom att inaktivera strömning för Ollama-modeller.

Om du manuellt har aktiverat strömning och upplever detta problem:

1. Ta bort konfigurationen `streaming: true` från dina Ollama‑modellposter, eller
2. Sätt `streaming: false` explicit för Ollama‑modeller (se [Strömningskonfiguration](#strömningskonfiguration))

## Se även

- [Model Providers](/concepts/model-providers) – Översikt över alla leverantörer
- [Model Selection](/concepts/models) – Hur du väljer modeller
- [Configuration](/gateway/configuration) – Fullständig konfigreferens
