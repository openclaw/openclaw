---
summary: "Skonfiguruj Moonshot K2 vs Kimi Coding (oddzielni dostawcy + klucze)"
read_when:
  - Chcesz skonfigurować Moonshot K2 (Moonshot Open Platform) vs Kimi Coding
  - Musisz zrozumieć oddzielne endpointy, klucze i odwołania do modeli
  - Chcesz gotową konfigurację do skopiowania dla dowolnego dostawcy
title: "Moonshot AI"
---

# Moonshot AI (Kimi)

Moonshot udostępnia API Kimi z endpointami kompatybilnymi z OpenAI. Skonfiguruj
dostawcę i ustaw domyślny model na `moonshot/kimi-k2.5`, albo użyj
Kimi Coding z `kimi-coding/k2p5`.

Aktualne identyfikatory modeli Kimi K2:

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

Uwaga: Moonshot i Kimi Coding to oddzielni dostawcy. Klucze nie są wymienne, endpointy się różnią, a odwołania do modeli są inne (Moonshot używa `moonshot/...`, Kimi Coding używa `kimi-coding/...`).

## Fragment konfiguracji (API Moonshot)

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

## Uwagi

- Odwołania do modeli Moonshot używają `moonshot/<modelId>`. Odwołania do modeli Kimi Coding używają `kimi-coding/<modelId>`.
- W razie potrzeby nadpisz metadane cenowe i kontekstu w `models.providers`.
- Jeśli Moonshot opublikuje inne limity kontekstu dla modelu, odpowiednio dostosuj
  `contextWindow`.
- Użyj `https://api.moonshot.ai/v1` dla endpointu międzynarodowego oraz `https://api.moonshot.cn/v1` dla endpointu w Chinach.
