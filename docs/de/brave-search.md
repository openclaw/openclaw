---
summary: "Einrichtung der Brave Search API für web_search"
read_when:
  - Sie möchten Brave Search für web_search verwenden
  - Sie benötigen einen BRAVE_API_KEY oder Plandetails
title: "Brave Search"
---

# Brave Search API

OpenClaw verwendet Brave Search als Standardanbieter für `web_search`.

## API-Schlüssel erhalten

1. Erstellen Sie ein Brave Search API-Konto unter [https://brave.com/search/api/](https://brave.com/search/api/)
2. Wählen Sie im Dashboard den Plan **Data for Search** und generieren Sie einen API-Schlüssel.
3. Speichern Sie den Schlüssel in der Konfiguration (empfohlen) oder setzen Sie `BRAVE_API_KEY` in der Gateway-Umgebung.

## Konfigurationsbeispiel

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## Hinweise

- Der Plan **Data for AI** ist **nicht** mit `web_search` kompatibel.
- Brave bietet eine kostenlose Stufe sowie kostenpflichtige Pläne; prüfen Sie das Brave API-Portal für aktuelle Limits.

Siehe [Web tools](/tools/web) für die vollständige web_search-Konfiguration.
