---
summary: "Prüfen, was Geld ausgeben kann, welche Schlüssel verwendet werden und wie die Nutzung angezeigt wird"
read_when:
  - Sie möchten verstehen, welche Funktionen kostenpflichtige APIs aufrufen können
  - Sie müssen Schlüssel, Kosten und Nutzungstransparenz prüfen
  - Sie erklären die Kostenberichte von /status oder /usage
title: "API-Nutzung und Kosten"
---

# API-Nutzung & Kosten

Dieses Dokument listet **Funktionen, die API-Schlüssel aufrufen können**, und wo deren Kosten angezeigt werden. Der Fokus liegt auf
OpenClaw-Funktionen, die Anbieter-Nutzung oder kostenpflichtige API-Aufrufe erzeugen können.

## Wo Kosten angezeigt werden (Chat + CLI)

**Kostenübersicht pro Sitzung**

- `/status` zeigt das aktuelle Sitzungsmodell, die Kontextnutzung und die Token der letzten Antwort.
- Wenn das Modell **API-Schlüssel-Authentifizierung** verwendet, zeigt `/status` außerdem die **geschätzten Kosten** für die letzte Antwort an.

**Kosten-Footer pro Nachricht**

- `/usage full` hängt an jede Antwort einen Nutzungs-Footer an, einschließlich **geschätzter Kosten** (nur bei API-Schlüsseln).
- `/usage tokens` zeigt nur Token an; OAuth-Flows blenden Dollar-Kosten aus.

**CLI-Nutzungsfenster (Anbieter-Kontingente)**

- `openclaw status --usage` und `openclaw channels list` zeigen **Nutzungsfenster** der Anbieter
  (Kontingent-Snapshots, keine Kosten pro Nachricht).

Siehe [Token-Nutzung & Kosten](/reference/token-use) für Details und Beispiele.

## Wie Schlüssel gefunden werden

OpenClaw kann Zugangsdaten beziehen aus:

- **Auth-Profilen** (pro Agent, gespeichert in `auth-profiles.json`).
- **Umgebungsvariablen** (z. B. `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **Konfiguration** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- **Skills** (`skills.entries.<name>.apiKey`), die Schlüssel ggf. in die Umgebungsvariablen des Skill-Prozesses exportieren.

## Funktionen, die Schlüssel verbrauchen können

### 1. Kernmodell-Antworten (Chat + Werkzeuge)

Jede Antwort oder jeder Werkzeugaufruf verwendet den **aktuellen Modellanbieter** (OpenAI, Anthropic usw.). Dies ist die
primäre Quelle für Nutzung und Kosten.

Siehe [Modelle](/providers/models) für die Preis-Konfiguration und [Token-Nutzung & Kosten](/reference/token-use) für die Anzeige.

### 2. Medienverständnis (Audio/Bild/Video)

Eingehende Medien können vor der Antwort zusammengefasst/transkribiert werden. Dafür werden Modell-/Anbieter-APIs verwendet.

- Audio: OpenAI / Groq / Deepgram (jetzt **automatisch aktiviert**, wenn Schlüssel vorhanden sind).
- Bild: OpenAI / Anthropic / Google.
- Video: Google.

Siehe [Medienverständnis](/nodes/media-understanding).

### 3. Speicher-Embeddings + semantische Suche

Die semantische Speichersuche verwendet **Embedding-APIs**, wenn sie für Remote-Anbieter konfiguriert ist:

- `memorySearch.provider = "openai"` → OpenAI-Embeddings
- `memorySearch.provider = "gemini"` → Gemini-Embeddings
- `memorySearch.provider = "voyage"` → Voyage-Embeddings
- Optionaler Fallback auf einen Remote-Anbieter, wenn lokale Embeddings fehlschlagen

Sie können es mit `memorySearch.provider = "local"` lokal halten (keine API-Nutzung).

Siehe [Memory](/concepts/memory).

### 4. Web-Suchwerkzeug (Brave / Perplexity über OpenRouter)

`web_search` verwendet API-Schlüssel und kann Nutzungskosten verursachen:

- **Brave Search API**: `BRAVE_API_KEY` oder `tools.web.search.apiKey`
- **Perplexity** (über OpenRouter): `PERPLEXITY_API_KEY` oder `OPENROUTER_API_KEY`

**Brave Free-Tier (großzügig):**

- **2.000 Anfragen/Monat**
- **1 Anfrage/Sekunde**
- **Kreditkarte erforderlich** zur Verifizierung (keine Kosten, sofern Sie nicht upgraden)

Siehe [Web-Werkzeuge](/tools/web).

### 5. Web-Fetch-Werkzeug (Firecrawl)

`web_fetch` kann **Firecrawl** aufrufen, wenn ein API-Schlüssel vorhanden ist:

- `FIRECRAWL_API_KEY` oder `tools.web.fetch.firecrawl.apiKey`

Wenn Firecrawl nicht konfiguriert ist, fällt das Werkzeug auf direkten Fetch + Readability zurück (keine kostenpflichtige API).

Siehe [Web-Werkzeuge](/tools/web).

### 6. Anbieter-Nutzungs-Snapshots (Status/Health)

Einige Statusbefehle rufen **Anbieter-Nutzungsendpunkte** auf, um Kontingentfenster oder den Auth-Status anzuzeigen.
Dies sind typischerweise Aufrufe mit geringem Volumen, treffen aber dennoch Anbieter-APIs:

- `openclaw status --usage`
- `openclaw models status --json`

Siehe [Models CLI](/cli/models).

### 7. Zusammenfassung durch Kompaktions-Schutz

Der Kompaktions-Schutz kann den Sitzungsverlauf mit dem **aktuellen Modell** zusammenfassen, was
bei der Ausführung Anbieter-APIs aufruft.

Siehe [Sitzungsverwaltung + Kompaktion](/reference/session-management-compaction).

### 8. Modell-Scan / -Probe

`openclaw models scan` kann OpenRouter-Modelle prüfen und verwendet `OPENROUTER_API_KEY`, wenn
das Prüfen aktiviert ist.

Siehe [Models CLI](/cli/models).

### 9. Talk (Sprache)

Der Talk-Modus kann **ElevenLabs** aufrufen, wenn er konfiguriert ist:

- `ELEVENLABS_API_KEY` oder `talk.apiKey`

Siehe [Talk-Modus](/nodes/talk).

### 10. Skills (Drittanbieter-APIs)

Skills können `apiKey` in `skills.entries.<name>.apiKey` speichern. Wenn ein Skill diesen Schlüssel für externe
APIs verwendet, können entsprechend dem Anbieter des Skills Kosten entstehen.

Siehe [Skills](/tools/skills).
