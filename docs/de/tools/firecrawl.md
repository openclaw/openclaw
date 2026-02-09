---
summary: "Firecrawl-Fallback für web_fetch (Anti-Bot + zwischengespeicherte Extraktion)"
read_when:
  - Sie möchten eine Firecrawl-gestützte Web-Extraktion
  - Sie benötigen einen Firecrawl-API-Schlüssel
  - Sie möchten eine Anti-Bot-Extraktion für web_fetch
title: "Firecrawl"
---

# Firecrawl

OpenClaw kann **Firecrawl** als Fallback-Extraktor für `web_fetch` verwenden. Es handelt sich um einen gehosteten
Content-Extraktionsdienst, der Bot-Umgehung und Caching unterstützt, was bei
JS-lastigen Websites oder Seiten hilft, die einfache HTTP-Abrufe blockieren.

## API-Schlüssel abrufen

1. Erstellen Sie ein Firecrawl-Konto und generieren Sie einen API-Schlüssel.
2. Speichern Sie ihn in der Konfiguration oder setzen Sie `FIRECRAWL_API_KEY` in der Gateway-Umgebung.

## Firecrawl konfigurieren

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

Hinweise:

- `firecrawl.enabled` ist standardmäßig true, wenn ein API-Schlüssel vorhanden ist.
- `maxAgeMs` steuert, wie alt zwischengespeicherte Ergebnisse sein dürfen (ms). Der Standardwert beträgt 2 Tage.

## Stealth / Bot-Umgehung

Firecrawl stellt einen **Proxy-Modus**-Parameter zur Bot-Umgehung bereit (`basic`, `stealth` oder `auto`).
OpenClaw verwendet für Firecrawl-Anfragen immer `proxy: "auto"` plus `storeInCache: true`.
Wenn kein Proxy angegeben ist, verwendet Firecrawl standardmäßig `auto`. `auto` wiederholt den Versuch mit Stealth-Proxys, wenn ein grundlegender Versuch fehlschlägt, was
mehr Credits verbrauchen kann als reines Basic-Scraping.

## Wie `web_fetch` Firecrawl verwendet

`web_fetch` Extraktionsreihenfolge:

1. Readability (lokal)
2. Firecrawl (falls konfiguriert)
3. Grundlegende HTML-Bereinigung (letzter Fallback)

Siehe [Web tools](/tools/web) für die vollständige Einrichtung der Web-Tools.
