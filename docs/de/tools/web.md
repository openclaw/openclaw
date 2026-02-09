---
summary: "„Websuche- und Fetch-Werkzeuge (Brave Search API, Perplexity direkt/OpenRouter)“"
read_when:
  - Sie möchten web_search oder web_fetch aktivieren
  - Sie benötigen die Einrichtung eines Brave Search API-Schlüssels
  - Sie möchten Perplexity Sonar für die Websuche verwenden
title: "„Web-Werkzeuge“"
---

# Web-Werkzeuge

OpenClaw liefert zwei leichtgewichtige Web-Werkzeuge aus:

- `web_search` — Websuche über die Brave Search API (Standard) oder Perplexity Sonar (direkt oder über OpenRouter).
- `web_fetch` — HTTP-Fetch + lesbare Extraktion (HTML → Markdown/Text).

Dies ist **keine** Browser-Automatisierung. Für JS-lastige Seiten oder Logins verwenden Sie das
[Browser-Werkzeug](/tools/browser).

## Wie es funktioniert

- `web_search` ruft Ihren konfigurierten Anbieter auf und gibt Ergebnisse zurück.
  - **Brave** (Standard): liefert strukturierte Ergebnisse (Titel, URL, Snippet).
  - **Perplexity**: liefert KI-synthetisierte Antworten mit Zitaten aus Echtzeit-Websuchen.
- Ergebnisse werden 15 Minuten lang pro Anfrage zwischengespeichert (konfigurierbar).
- `web_fetch` führt einen einfachen HTTP-GET aus und extrahiert lesbaren Inhalt
  (HTML → Markdown/Text). JavaScript wird **nicht** ausgeführt.
- `web_fetch` ist standardmäßig aktiviert (sofern nicht ausdrücklich deaktiviert).

## Auswahl eines Suchanbieters

| Anbieter                                | Vorteile                                      | Nachteile                                    | API-Schlüssel                                  |
| --------------------------------------- | --------------------------------------------- | -------------------------------------------- | ---------------------------------------------- |
| **Brave** (Standard) | Schnell, strukturierte Ergebnisse, Free-Tier  | Klassische Suchergebnisse                    | `BRAVE_API_KEY`                                |
| **Perplexity**                          | KI-synthetisierte Antworten, Zitate, Echtzeit | Erfordert Perplexity- oder OpenRouter-Zugang | `OPENROUTER_API_KEY` oder `PERPLEXITY_API_KEY` |

Siehe [Brave Search Einrichtung](/brave-search) und [Perplexity Sonar](/perplexity) für anbieterspezifische Details.

Legen Sie den Anbieter in der Konfiguration fest:

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // or "perplexity"
      },
    },
  },
}
```

Beispiel: Wechsel zu Perplexity Sonar (direkte API):

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Einen Brave-API-Schlüssel erhalten

1. Erstellen Sie ein Brave Search API-Konto unter [https://brave.com/search/api/](https://brave.com/search/api/)
2. Wählen Sie im Dashboard den **Data for Search**-Plan (nicht „Data for AI“) und erzeugen Sie einen API-Schlüssel.
3. Führen Sie `openclaw configure --section web` aus, um den Schlüssel in der Konfiguration zu speichern (empfohlen), oder setzen Sie `BRAVE_API_KEY` in Ihrer Umgebung.

Brave bietet einen Free-Tier sowie kostenpflichtige Pläne; prüfen Sie im Brave-API-Portal die
aktuellen Limits und Preise.

### Wo der Schlüssel gesetzt wird (empfohlen)

**Empfohlen:** Führen Sie `openclaw configure --section web` aus. Dadurch wird der Schlüssel in
`~/.openclaw/openclaw.json` unter `tools.web.search.apiKey` gespeichert.

**Umgebungs-Alternative:** Setzen Sie `BRAVE_API_KEY` in der Gateway-Prozess-
umgebung. Für eine Gateway-Installation legen Sie ihn in `~/.openclaw/.env` (oder in Ihrer
Service-Umgebung) ab. Siehe [Env vars](/help/faq#how-does-openclaw-load-environment-variables).

## Verwendung von Perplexity (direkt oder über OpenRouter)

Perplexity-Sonar-Modelle verfügen über integrierte Websuchfunktionen und liefern KI-synthetisierte
Antworten mit Zitaten. Sie können diese über OpenRouter nutzen (keine Kreditkarte erforderlich –
unterstützt Krypto/Prepaid).

### Einen OpenRouter-API-Schlüssel erhalten

1. Erstellen Sie ein Konto unter [https://openrouter.ai/](https://openrouter.ai/)
2. Laden Sie Guthaben auf (unterstützt Krypto, Prepaid oder Kreditkarte)
3. Erzeugen Sie einen API-Schlüssel in Ihren Kontoeinstellungen

### Perplexity-Suche einrichten

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API key (optional if OPENROUTER_API_KEY or PERPLEXITY_API_KEY is set)
          apiKey: "sk-or-v1-...",
          // Base URL (key-aware default if omitted)
          baseUrl: "https://openrouter.ai/api/v1",
          // Model (defaults to perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**Umgebungs-Alternative:** Setzen Sie `OPENROUTER_API_KEY` oder `PERPLEXITY_API_KEY` in der Gateway-
Umgebung. Für eine Gateway-Installation legen Sie ihn in `~/.openclaw/.env` ab.

Wenn keine Base-URL gesetzt ist, wählt OpenClaw einen Standard basierend auf der Quelle des API-Schlüssels:

- `PERPLEXITY_API_KEY` oder `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` oder `sk-or-...` → `https://openrouter.ai/api/v1`
- Unbekannte Schlüsselformate → OpenRouter (sicherer Fallback)

### Verfügbare Perplexity-Modelle

| Modell                                               | Beschreibung                                   | Am besten für         |
| ---------------------------------------------------- | ---------------------------------------------- | --------------------- |
| `perplexity/sonar`                                   | Schnelles Q&A mit Websuche | Schnelle Nachschläge  |
| `perplexity/sonar-pro` (Standard) | Mehrstufiges Schlussfolgern mit Websuche       | Komplexe Fragen       |
| `perplexity/sonar-reasoning-pro`                     | Chain-of-Thought-Analyse                       | Tiefgehende Recherche |

## web_search

Durchsuchen Sie das Web mit Ihrem konfigurierten Anbieter.

### Anforderungen

- `tools.web.search.enabled` darf nicht `false` sein (Standard: aktiviert)
- API-Schlüssel für den gewählten Anbieter:
  - **Brave**: `BRAVE_API_KEY` oder `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY` oder `tools.web.search.perplexity.apiKey`

### Konfiguration

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### Werkzeugparameter

- `query` (erforderlich)
- `count` (1–10; Standard aus der Konfiguration)
- `country` (optional): 2-stelliger Ländercode für regionsspezifische Ergebnisse (z. B. „DE“, „US“, „ALL“). Wenn nicht angegeben, wählt Brave seine Standardregion.
- `search_lang` (optional): ISO-Sprachcode für Suchergebnisse (z. B. „de“, „en“, „fr“)
- `ui_lang` (optional): ISO-Sprachcode für UI-Elemente
- `freshness` (optional, nur Brave): Filter nach Entdeckungszeit (`pd`, `pw`, `pm`, `py` oder `YYYY-MM-DDtoYYYY-MM-DD`)

**Beispiele:**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// French search with French UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

Ruft eine URL ab und extrahiert lesbaren Inhalt.

### web_fetch-Anforderungen

- `tools.web.fetch.enabled` darf nicht `false` sein (Standard: aktiviert)
- Optionaler Firecrawl-Fallback: Setzen Sie `tools.web.fetch.firecrawl.apiKey` oder `FIRECRAWL_API_KEY`.

### web_fetch-Konfiguration

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### web_fetch-Werkzeugparameter

- `url` (erforderlich, nur http/https)
- `extractMode` (`markdown` | `text`)
- `maxChars` (lange Seiten kürzen)

Hinweise:

- `web_fetch` verwendet zuerst Readability (Extraktion des Hauptinhalts), danach Firecrawl (falls konfiguriert). Wenn beides fehlschlägt, gibt das Werkzeug einen Fehler zurück.
- Firecrawl-Anfragen verwenden standardmäßig den Bot-Umgehungsmodus und cachen Ergebnisse.
- `web_fetch` sendet standardmäßig einen Chrome-ähnlichen User-Agent und `Accept-Language`; überschreiben Sie `userAgent` bei Bedarf.
- `web_fetch` blockiert private/interne Hostnamen und prüft Weiterleitungen erneut (begrenzen mit `maxRedirects`).
- `maxChars` wird auf `tools.web.fetch.maxCharsCap` begrenzt.
- `web_fetch` ist eine Best-Effort-Extraktion; einige Seiten benötigen das Browser-Werkzeug.
- Siehe [Firecrawl](/tools/firecrawl) für Schlüsseleinrichtung und Servicedetails.
- Antworten werden zwischengespeichert (Standard: 15 Minuten), um wiederholte Abrufe zu reduzieren.
- Wenn Sie Werkzeugprofile/Allowlists verwenden, fügen Sie `web_search`/`web_fetch` oder `group:web` hinzu.
- Wenn der Brave-Schlüssel fehlt, gibt `web_search` einen kurzen Einrichtungshinweis mit einem Dokumentationslink zurück.
