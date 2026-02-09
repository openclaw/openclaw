---
summary: "„Nutzen Sie die datenschutzorientierten Modelle von Venice AI in OpenClaw“"
read_when:
  - Sie möchten datenschutzorientierte Inferenz in OpenClaw
  - Sie möchten Anleitungen zur Einrichtung von Venice AI
title: "„Venice AI“"
---

# Venice AI (Venice-Highlight)

**Venice** ist unser hervorgehobenes Venice-Setup für Privacy-first-Inferenz mit optionalem anonymisiertem Zugriff auf proprietäre Modelle.

Venice AI bietet datenschutzorientierte KI-Inferenz mit Unterstützung für unzensierte Modelle sowie Zugriff auf große proprietäre Modelle über einen anonymisierten Proxy. Alle Inferenzvorgänge sind standardmäßig privat — kein Training mit Ihren Daten, keine Protokollierung.

## Warum Venice in OpenClaw

- **Private Inferenz** für Open-Source-Modelle (keine Protokollierung).
- **Unzensierte Modelle**, wenn Sie sie benötigen.
- **Anonymisierter Zugriff** auf proprietäre Modelle (Opus/GPT/Gemini), wenn Qualität zählt.
- OpenAI-kompatible `/v1` Endpunkte.

## Datenschutzmodi

Venice bietet zwei Datenschutzstufen — deren Verständnis ist entscheidend für die Modellauswahl:

| Modus            | Beschreibung                                                                                                                                                                        | Modelle                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Privat**       | Vollständig privat. Prompts/Antworten werden **niemals gespeichert oder protokolliert**. Ephemer.                                   | Llama, Qwen, DeepSeek, Venice Uncensored usw. |
| **Anonymisiert** | Über Venice weitergeleitet, Metadaten entfernt. Der zugrunde liegende Anbieter (OpenAI, Anthropic) sieht anonymisierte Anfragen. | Claude, GPT, Gemini, Grok, Kimi, MiniMax                      |

## Funktionen

- **Datenschutzorientiert**: Wählen Sie zwischen „privat“ (vollständig privat) und „anonymisiert“ (über Proxy)
- **Unzensierte Modelle**: Zugriff auf Modelle ohne Inhaltsbeschränkungen
- **Zugriff auf führende Modelle**: Nutzen Sie Claude, GPT-5.2, Gemini, Grok über den anonymisierten Proxy von Venice
- **OpenAI-kompatible API**: Standard-`/v1` Endpunkte für einfache Integration
- **Streaming**: ✅ Auf allen Modellen unterstützt
- **Function Calling**: ✅ Auf ausgewählten Modellen unterstützt (Modellfähigkeiten prüfen)
- **Vision**: ✅ Auf Modellen mit Vision-Fähigkeit unterstützt
- **Keine harten Rate-Limits**: Fair-Use-Drosselung kann bei extremer Nutzung greifen

## Einrichtung

### 1. API-Schlüssel erhalten

1. Registrieren Sie sich unter [venice.ai](https://venice.ai)
2. Gehen Sie zu **Settings → API Keys → Create new key**
3. Kopieren Sie Ihren API-Schlüssel (Format: `vapi_xxxxxxxxxxxx`)

### 2) OpenClaw konfigurieren

**Option A: Umgebungsvariable**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Option B: Interaktive Einrichtung (empfohlen)**

```bash
openclaw onboard --auth-choice venice-api-key
```

Dies wird:

1. Nach Ihrem API-Schlüssel fragen (oder einen vorhandenen `VENICE_API_KEY` verwenden)
2. Alle verfügbaren Venice-Modelle anzeigen
3. Ihnen erlauben, Ihr Standardmodell auszuwählen
4. Den Anbieter automatisch konfigurieren

**Option C: Nicht-interaktiv**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. Einrichtung verifizieren

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## Modellauswahl

Nach der Einrichtung zeigt OpenClaw alle verfügbaren Venice-Modelle an. Wählen Sie nach Bedarf:

- **Standard (unsere Wahl)**: `venice/llama-3.3-70b` für private, ausgewogene Leistung.
- **Beste Gesamtqualität**: `venice/claude-opus-45` für anspruchsvolle Aufgaben (Opus bleibt am stärksten).
- **Datenschutz**: Wählen Sie „private“ Modelle für vollständig private Inferenz.
- **Fähigkeiten**: Wählen Sie „anonymisierte“ Modelle, um über den Proxy von Venice auf Claude, GPT, Gemini zuzugreifen.

Ändern Sie Ihr Standardmodell jederzeit:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

Alle verfügbaren Modelle auflisten:

```bash
openclaw models list | grep venice
```

## Konfiguration über `openclaw configure`

1. Führen Sie `openclaw configure` aus
2. Wählen Sie **Model/auth**
3. Wählen Sie **Venice AI**

## Welches Modell sollte ich verwenden?

| Fall verwenden                    | Empfohlenes Modell               | Warum                                              |
| --------------------------------- | -------------------------------- | -------------------------------------------------- |
| **Allgemeiner Chat**              | `llama-3.3-70b`                  | Gut ausgewogen, vollständig privat                 |
| **Beste Gesamtqualität**          | `claude-opus-45`                 | Opus bleibt am stärksten für schwierige Aufgaben   |
| **Datenschutz + Claude-Qualität** | `claude-opus-45`                 | Beste Schlussfolgerungen über anonymisierten Proxy |
| **Programmierung**                | `qwen3-coder-480b-a35b-instruct` | Code-optimiert, 262k Kontext                       |
| **Vision-Aufgaben**               | `qwen3-vl-235b-a22b`             | Bestes privates Vision-Modell                      |
| **Unzensiert**                    | `venice-uncensored`              | Keine Inhaltsbeschränkungen                        |
| **Schnell + günstig**             | `qwen3-4b`                       | Leichtgewichtig, dennoch leistungsfähig            |
| **Komplexe Schlussfolgerungen**   | `deepseek-v3.2`                  | Starke Schlussfolgerungen, privat                  |

## Verfügbare Modelle (25 insgesamt)

### Private Modelle (15) — Vollständig privat, keine Protokollierung

| Modell-ID                        | Name                                       | Kontext (Token) | Funktionen                   |
| -------------------------------- | ------------------------------------------ | ---------------------------------- | ---------------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B              | 131k                               | Allgemein                    |
| `llama-3.2-3b`                   | Llama 3.2 3B               | 131k                               | Schnell, leichtgewichtig     |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B    | 131k                               | Komplexe Aufgaben            |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking                        | 131k                               | Reasoning                    |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct                        | 131k                               | Allgemein                    |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B                           | 262k                               | Code                         |
| `qwen3-next-80b`                 | Qwen3 Next 80B                             | 262k                               | Allgemein                    |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B                              | 262k                               | Vision                       |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k                                | Schnell, Schlussfolgern      |
| `deepseek-v3.2`                  | DeepSeek V3.2              | 163k                               | Reasoning                    |
| `venice-uncensored`              | Venice Uncensored                          | 32k                                | Unzensiert                   |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k                               | Vision                       |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct                       | 202k                               | Vision                       |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B                        | 131k                               | Allgemein                    |
| `zai-org-glm-4.7`                | GLM 4.7                    | 202k                               | Schlussfolgern, mehrsprachig |

### Anonymisierte Modelle (10) — Über den Venice-Proxy

| Modell-ID                | Original                          | Kontext (Token) | Funktionen             |
| ------------------------ | --------------------------------- | ---------------------------------- | ---------------------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k                               | Schlussfolgern, Vision |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k                               | Schlussfolgern, Vision |
| `openai-gpt-52`          | GPT-5.2           | 262k                               | Reasoning              |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k                               | Schlussfolgern, Vision |
| `gemini-3-pro-preview`   | Gemini 3 Pro                      | 202k                               | Schlussfolgern, Vision |
| `gemini-3-flash-preview` | Gemini 3 Flash                    | 262k                               | Schlussfolgern, Vision |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k                               | Schlussfolgern, Vision |
| `grok-code-fast-1`       | Grok Code Fast 1                  | 262k                               | Schlussfolgern, Code   |
| `kimi-k2-thinking`       | Kimi K2 Thinking                  | 262k                               | Reasoning              |
| `minimax-m21`            | MiniMax M2.1      | 202k                               | Reasoning              |

## Model Discovery

OpenClaw erkennt Modelle automatisch über die Venice-API, wenn `VENICE_API_KEY` gesetzt ist. Ist die API nicht erreichbar, wird auf einen statischen Katalog zurückgegriffen.

Der Endpunkt `/models` ist öffentlich (keine Authentifizierung für die Auflistung erforderlich), aber Inferenz erfordert einen gültigen API-Schlüssel.

## Streaming- & Tool-Unterstützung

| Funktion             | Unterstützung                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------ |
| **Streaming**        | ✅ Alle Modelle                                                                             |
| **Function Calling** | ✅ Die meisten Modelle (prüfen Sie `supportsFunctionCalling` in der API) |
| **Vision/Bilder**    | ✅ Modelle mit der Funktion „Vision“                                                        |
| **JSON-Modus**       | ✅ Unterstützt über `response_format`                                                       |

## Preise

Venice verwendet ein kreditbasiertes System. Aktuelle Preise finden Sie unter [venice.ai/pricing](https://venice.ai/pricing):

- **Private Modelle**: In der Regel geringere Kosten
- **Anonymisierte Modelle**: Ähnlich zur direkten API-Bepreisung + geringe Venice-Gebühr

## Vergleich: Venice vs. direkte API

| Aspekt          | Venice (anonymisiert) | Direkte API              |
| --------------- | ---------------------------------------- | ------------------------ |
| **Datenschutz** | Metadaten entfernt, anonymisiert         | Ihr Konto verknüpft      |
| **Latenz**      | +10–50 ms (Proxy)     | Direkt                   |
| **Funktionen**  | Die meisten Funktionen unterstützt       | Volle Funktionen         |
| **Abrechnung**  | Venice-Guthaben                          | Abrechnung beim Anbieter |

## Anwendungsbeispiele

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

## Fehlerbehebung

### API-Schlüssel nicht erkannt

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

Stellen Sie sicher, dass der Schlüssel mit `vapi_` beginnt.

### Modell nicht verfügbar

Der Venice-Modellkatalog wird dynamisch aktualisiert. Führen Sie `openclaw models list` aus, um die aktuell verfügbaren Modelle anzuzeigen. Einige Modelle können vorübergehend offline sein.

### Verbindungsprobleme

Die Venice-API befindet sich unter `https://api.venice.ai/api/v1`. Stellen Sie sicher, dass Ihr Netzwerk HTTPS-Verbindungen zulässt.

## Beispiel für Konfigurationsdatei

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
- [API-Dokumentation](https://docs.venice.ai)
- [Preise](https://venice.ai/pricing)
- [Status](https://status.venice.ai)
