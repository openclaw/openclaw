---
summary: "„Session Pruning: Kürzen von Werkzeugergebnissen zur Reduzierung von Kontextaufblähung“"
read_when:
  - Sie möchten das Wachstum des LLM‑Kontexts durch Werkzeugausgaben reduzieren
  - Sie stimmen agents.defaults.contextPruning ab
---

# Session Pruning

Session Pruning kürzt **alte Werkzeugergebnisse** aus dem In‑Memory‑Kontext unmittelbar vor jedem LLM‑Aufruf. Die auf der Festplatte gespeicherte Sitzungsverlaufshistorie wird **nicht** umgeschrieben (`*.jsonl`).

## Wann es ausgeführt wird

- Wenn `mode: "cache-ttl"` aktiviert ist und der letzte Anthropic‑Aufruf für die Sitzung älter als `ttl` ist.
- Betrifft nur die Nachrichten, die für diese Anfrage an das Modell gesendet werden.
- Aktiv nur für Anthropic‑API‑Aufrufe (und OpenRouter‑Anthropic‑Modelle).
- Für beste Ergebnisse stimmen Sie `ttl` auf Ihr Modell `cacheControlTtl` ab.
- Nach einem Prune wird das TTL‑Fenster zurückgesetzt, sodass nachfolgende Anfragen den Cache behalten, bis `ttl` erneut abläuft.

## Intelligente Standardwerte (Anthropic)

- **OAuth‑ oder setup-token**‑Profile: Aktivieren Sie `cache-ttl`‑Pruning und setzen Sie den Heartbeat auf `1h`.
- **API‑Schlüssel**‑Profile: Aktivieren Sie `cache-ttl`‑Pruning, setzen Sie den Heartbeat auf `30m` und setzen Sie den Standardwert `cacheControlTtl` bei Anthropic‑Modellen auf `1h`.
- Wenn Sie einen dieser Werte explizit setzen, überschreibt OpenClaw diese **nicht**.

## Was dies verbessert (Kosten + Cache‑Verhalten)

- **Warum prunen:** Anthropic‑Prompt‑Caching gilt nur innerhalb der TTL. Wenn eine Sitzung länger als die TTL inaktiv ist, cached die nächste Anfrage den vollständigen Prompt erneut, sofern Sie ihn nicht zuvor kürzen.
- **Was günstiger wird:** Pruning reduziert die **cacheWrite**‑Größe für diese erste Anfrage nach Ablauf der TTL.
- **Warum das Zurücksetzen der TTL wichtig ist:** Sobald Pruning ausgeführt wurde, wird das Cache‑Fenster zurückgesetzt, sodass Folgeanfragen den frisch gecachten Prompt wiederverwenden können, statt die vollständige Historie erneut zu cachen.
- **Was es nicht tut:** Pruning fügt keine Tokens hinzu und verdoppelt keine Kosten; es ändert lediglich, was bei dieser ersten Anfrage nach der TTL gecacht wird.

## Was gekürzt werden kann

- Nur `toolResult`‑Nachrichten.
- Nutzer‑ und Assistenten‑Nachrichten werden **niemals** verändert.
- Die letzten `keepLastAssistants` Assistenten‑Nachrichten sind geschützt; Werkzeugergebnisse nach diesem Cutoff werden nicht gekürzt.
- Wenn es nicht genügend Assistenten‑Nachrichten gibt, um den Cutoff festzulegen, wird Pruning übersprungen.
- Werkzeugergebnisse mit **Image‑Blöcken** werden übersprungen (niemals gekürzt/geleert).

## Schätzung des Kontextfensters

Pruning verwendet ein geschätztes Kontextfenster (Zeichen ≈ Tokens × 4). Das Basisfenster wird in dieser Reihenfolge ermittelt:

1. `models.providers.*.models[].contextWindow`‑Override.
2. Modell‑Definition `contextWindow` (aus dem Modell‑Registry).
3. Standard `200000` Tokens.

Wenn `agents.defaults.contextTokens` gesetzt ist, wird es als Obergrenze (min) für das ermittelte Fenster behandelt.

## Modus

### cache-ttl

- Pruning wird nur ausgeführt, wenn der letzte Anthropic‑Aufruf älter als `ttl` ist (Standard `5m`).
- Bei Ausführung: Gleiches Soft‑Trim‑ plus Hard‑Clear‑Verhalten wie zuvor.

## Soft‑ vs. Hard‑Pruning

- **Soft‑Trim**: nur für übergroße Werkzeugergebnisse.
  - Behält Anfang + Ende bei, fügt `...` ein und hängt einen Hinweis mit der ursprünglichen Größe an.
  - Überspringt Ergebnisse mit Image‑Blöcken.
- **Hard‑Clear**: ersetzt das gesamte Werkzeugergebnis durch `hardClear.placeholder`.

## Werkzeugauswahl

- `tools.allow` / `tools.deny` unterstützen `*`‑Wildcards.
- Siege nicht zu.
- Der Abgleich ist nicht case-sensitiv.
- Leere Allowlist ⇒ alle Werkzeuge erlaubt.

## Interaktion mit anderen Limits

- Eingebaute Werkzeuge kürzen ihre Ausgabe bereits selbst; Session Pruning ist eine zusätzliche Ebene, die verhindert, dass sich in lang laufenden Chats zu viel Werkzeugausgabe im Modellkontext ansammelt.
- Kompaktierung ist separat: Kompaktierung fasst zusammen und persistiert, Pruning ist pro Anfrage transient. Siehe [/concepts/compaction](/concepts/compaction).

## Standardwerte (wenn aktiviert)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## Beispiele

Standard (aus):

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

TTL‑bewusstes Pruning aktivieren:

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

Pruning auf bestimmte Werkzeuge beschränken:

```json5
{
  agent: {
    contextPruning: {
      mode: "cache-ttl",
      tools: { allow: ["exec", "read"], deny: ["*image*"] },
    },
  },
}
```

Siehe Konfigurationsreferenz: [Gateway Configuration](/gateway/configuration)
