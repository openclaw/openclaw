---
summary: "Configurer Moonshot K2 vs Kimi Coding (fournisseurs et cles separes)"
read_when:
  - Vous souhaitez configurer Moonshot K2 (Moonshot Open Platform) vs Kimi Coding
  - Vous devez comprendre les endpoints, cles et references de modele separes
  - Vous voulez une configuration a copier/coller pour l’un ou l’autre fournisseur
title: "Moonshot AI"
---

# Moonshot AI (Kimi)

Moonshot fournit l’API Kimi avec des endpoints compatibles OpenAI. Configurez le
fournisseur et definissez le modele par defaut sur `moonshot/kimi-k2.5`, ou utilisez
Kimi Coding avec `kimi-coding/k2p5`.

IDs de modele Kimi K2 actuels :

{/_ moonshot-kimi-k2-ids:start _/ && null}

- `kimi-k2.5`
- `kimi-k2-0905-preview`
- `kimi-k2-turbo-preview`
- `kimi-k2-thinking`
- `kimi-k2-thinking-turbo`
  {/_ moonshot-kimi-k2-ids:end _/ && null}

```bash
openclaw onboard --auth-choice moonshot-api-key
```

Kimi Coding :

```bash
openclaw onboard --auth-choice kimi-code-api-key
```

Remarque : Moonshot et Kimi Coding sont des fournisseurs distincts. Les cles ne sont pas interchangeables, les endpoints different et les references de modele different (Moonshot utilise `moonshot/...`, Kimi Coding utilise `kimi-coding/...`).

## Extrait de configuration (API Moonshot)

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

## Notes

- Les references de modele Moonshot utilisent `moonshot/<modelId>`. Les references de modele Kimi Coding utilisent `kimi-coding/<modelId>`.
- Remplacez les metadonnees de tarification et de contexte dans `models.providers` si necessaire.
- Si Moonshot publie des limites de contexte differentes pour un modele, ajustez
  `contextWindow` en consequence.
- Utilisez `https://api.moonshot.ai/v1` pour l’endpoint international, et `https://api.moonshot.cn/v1` pour l’endpoint Chine.
