---
summary: "Moonshot K2 vs. Kimi Coding konfigurieren (separate Anbieter + Schlüssel)"
read_when:
  - Sie möchten Moonshot K2 (Moonshot Open Platform) vs. Kimi Coding einrichten
  - Sie müssen separate Endpunkte, Schlüssel und Modellreferenzen verstehen
  - Sie möchten Copy/Paste‑Konfigurationen für einen der beiden Anbieter
title: "Moonshot AI"
---

# Moonshot AI (Kimi)

Moonshot stellt die Kimi‑API mit OpenAI‑kompatiblen Endpunkten bereit. Konfigurieren Sie den
Anbieter und setzen Sie das Standardmodell auf `moonshot/kimi-k2.5`, oder verwenden Sie
Kimi Coding mit `kimi-coding/k2p5`.

Aktuelle Kimi‑K2‑Modell‑IDs:

{/_moonshot-kimi-k2-ids:start_/ && null}

- `kimi-k2.5`
- `kimi-k2-0905-preview`
- `kimi-k2-turbo-preview`
- `kimi-k2-thinking`
- `kimi-k2-thinking-turbo`
  {/_moonshot-kimi-k2-ids:end_/ && null}

```bash
openclaw onboard --auth-choice moonshot-api-key
```

Kimi Coding:

```bash
openclaw onboard --auth-choice kimi-code-api-key
```

Hinweis: Moonshot und Kimi Coding sind separate Anbieter. Schlüssel sind nicht austauschbar, Endpunkte unterscheiden sich, und Modellreferenzen unterscheiden sich (Moonshot verwendet `moonshot/...`, Kimi Coding verwendet `kimi-coding/...`).

## Konfigurationsausschnitt (Moonshot API)

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
      models: {
        // moonshot-kimi-k2-aliases:start
        "moonshot/kimi-k2.5": { alias: "Kimi K2.5" },
        "moonshot/kimi-k2-0905-preview": { alias: "Kimi K2" },
        "moonshot/kimi-k2-turbo-preview": { alias: "Kimi K2 Turbo" },
        "moonshot/kimi-k2-thinking": { alias: "Kimi K2 Thinking" },
        "moonshot/kimi-k2-thinking-turbo": { alias: "Kimi K2 Thinking Turbo" },
        // moonshot-kimi-k2-aliases:end
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          // moonshot-kimi-k2-models:start
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-0905-preview",
            name: "Kimi K2 0905 Preview",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-turbo-preview",
            name: "Kimi K2 Turbo",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-thinking",
            name: "Kimi K2 Thinking",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-thinking-turbo",
            name: "Kimi K2 Thinking Turbo",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          // moonshot-kimi-k2-models:end
        ],
      },
    },
  },
}
```

## Kimi Coding

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/k2p5" },
      models: {
        "kimi-coding/k2p5": { alias: "Kimi K2.5" },
      },
    },
  },
}
```

## Hinweise

- Moonshot‑Modellreferenzen verwenden `moonshot/<modelId>`. Kimi‑Coding‑Modellreferenzen verwenden `kimi-coding/<modelId>`.
- Überschreiben Sie Preis‑ und Kontext‑Metadaten bei Bedarf in `models.providers`.
- Wenn Moonshot für ein Modell andere Kontextgrenzen veröffentlicht, passen Sie
  `contextWindow` entsprechend an.
- Verwenden Sie `https://api.moonshot.ai/v1` für den internationalen Endpunkt und `https://api.moonshot.cn/v1` für den China‑Endpunkt.
