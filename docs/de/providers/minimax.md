---
summary: "MiniMax M2.1 in OpenClaw verwenden"
read_when:
  - Sie möchten MiniMax-Modelle in OpenClaw verwenden
  - Sie benötigen Anleitungen zur MiniMax-Einrichtung
title: "MiniMax"
---

# MiniMax

MiniMax ist ein KI-Unternehmen, das die Modellfamilie **M2/M2.1** entwickelt. Die aktuelle,
auf Programmierung fokussierte Version ist **MiniMax M2.1** (23. Dezember 2025), entwickelt
für reale, komplexe Aufgaben.

Quelle: [MiniMax M2.1 Release-Notiz](https://www.minimax.io/news/minimax-m21)

## Modellüberblick (M2.1)

MiniMax hebt in M2.1 folgende Verbesserungen hervor:

- Stärkere **mehrsprachige Programmierung** (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- Bessere **Web-/App-Entwicklung** und ästhetische Ausgabequalität (einschließlich nativer Mobile-Apps).
- Verbesserte Verarbeitung **zusammengesetzter Anweisungen** für büroähnliche Workflows, aufbauend auf
  verschränktem Denken und integrierter Ausführung von Einschränkungen.
- **Kompaktere Antworten** mit geringerem Token-Verbrauch und schnelleren Iterationszyklen.
- Stärkere Kompatibilität mit **Tool-/Agent-Frameworks** und besseres Kontextmanagement (Claude Code,
  Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- Hochwertigere **Dialog- und technische Schreibausgaben**.

## MiniMax M2.1 vs. MiniMax M2.1 Lightning

- **Geschwindigkeit:** Lightning ist die „schnelle“ Variante in der MiniMax-Preisdokumentation.
- **Kosten:** Die Preisgestaltung zeigt gleiche Eingabekosten, aber Lightning hat höhere Ausgabekosten.
- **Routing im Coding-Plan:** Das Lightning-Back-End ist im MiniMax Coding Plan nicht direkt verfügbar. MiniMax routet die meisten Anfragen automatisch zu Lightning, fällt jedoch bei
  Lastspitzen auf das reguläre M2.1-Back-End zurück.

## Einrichtung auswählen

### MiniMax OAuth (Coding Plan) — empfohlen

**Am besten geeignet für:** schnelle Einrichtung mit dem MiniMax Coding Plan über OAuth, kein API-Schlüssel erforderlich.

Aktivieren Sie das gebündelte OAuth-Plugin und authentifizieren Sie sich:

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

Sie werden aufgefordert, einen Endpunkt auszuwählen:

- **Global** – Internationale Nutzer (`api.minimax.io`)
- **CN** – Nutzer in China (`api.minimaxi.com`)

Siehe [MiniMax OAuth Plugin README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) für Details.

### MiniMax M2.1 (API-Schlüssel)

**Am besten geeignet für:** gehostetes MiniMax mit Anthropic-kompatibler API.

Konfiguration über die CLI:

- Führen Sie `openclaw configure` aus
- Wählen Sie **Model/auth**
- Wählen Sie **MiniMax M2.1**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 als Fallback (Opus primär)

**Am besten geeignet für:** Opus 4.6 als primäres Modell beibehalten und bei Ausfällen auf MiniMax M2.1 wechseln.

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### Optional: Lokal über LM Studio (manuell)

**Am besten geeignet für:** lokale Inferenz mit LM Studio.
Wir haben starke Ergebnisse mit MiniMax M2.1 auf leistungsfähiger Hardware (z. B. Desktop/Server) unter Verwendung des lokalen Servers von LM Studio gesehen.

Manuelle Konfiguration über `openclaw.json`:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Konfiguration über `openclaw configure`

Verwenden Sie den interaktiven Konfigurationsassistenten, um MiniMax einzurichten, ohne JSON zu bearbeiten:

1. Führen Sie `openclaw configure` aus.
2. Wählen Sie **Model/auth**.
3. Wählen Sie **MiniMax M2.1**.
4. Wählen Sie bei Aufforderung Ihr Standardmodell.

## Konfigurationsoptionen

- `models.providers.minimax.baseUrl`: bevorzugen Sie `https://api.minimax.io/anthropic` (Anthropic-kompatibel); `https://api.minimax.io/v1` ist optional für OpenAI-kompatible Payloads.
- `models.providers.minimax.api`: bevorzugen Sie `anthropic-messages`; `openai-completions` ist optional für OpenAI-kompatible Payloads.
- `models.providers.minimax.apiKey`: MiniMax-API-Schlüssel (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: definieren Sie `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: Aliase für Modelle, die Sie in der Allowlist verwenden möchten.
- `models.mode`: behalten Sie `merge` bei, wenn Sie MiniMax neben integrierten Modellen hinzufügen möchten.

## Hinweise

- Modellreferenzen sind `minimax/<model>`.
- API zur Nutzung des Coding Plans: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (erfordert einen Coding-Plan-Schlüssel).
- Aktualisieren Sie die Preiswerte in `models.json`, wenn Sie eine exakte Kostenverfolgung benötigen.
- Empfehlungslink für den MiniMax Coding Plan (10 % Rabatt): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- Siehe [/concepts/model-providers](/concepts/model-providers) für Anbieterregeln.
- Verwenden Sie `openclaw models list` und `openclaw models set minimax/MiniMax-M2.1`, um zu wechseln.

## Fehlerbehebung

### „Unknown model: minimax/MiniMax-M2.1“

Das bedeutet in der Regel, dass der **MiniMax-Anbieter nicht konfiguriert ist**
(kein Anbietereintrag und kein MiniMax-Auth-Profil bzw. Eine Korrektur für diese Erkennung ist in **2026.1.12** enthalten (zum Zeitpunkt des Schreibens noch nicht veröffentlicht). Beheben Sie dies durch:

- Aktualisieren auf **2026.1.12** (oder aus dem Quellcode ausführen `main`), anschließend den Gateway neu starten.
- Ausführen von `openclaw configure` und Auswahl von **MiniMax M2.1**, oder
- Manuelles Hinzufügen des Blocks `models.providers.minimax`, oder
- Setzen von `MINIMAX_API_KEY` (oder eines MiniMax-Auth-Profils), damit der Anbieter injiziert werden kann.

Stellen Sie sicher, dass die Modell-ID **groß-/kleinschreibungssensitiv** ist:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

Überprüfen Sie anschließend erneut mit:

```bash
openclaw models list
```
