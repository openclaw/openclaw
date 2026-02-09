---
summary: "Moonshot K2 ile Kimi Coding yapılandırması (ayrı sağlayıcılar + anahtarlar)"
read_when:
  - Moonshot K2 (Moonshot Open Platform) ile Kimi Coding kurulumunu istiyorsunuz
  - Ayrı uç noktaları, anahtarları ve model referanslarını anlamanız gerekiyor
  - Her iki sağlayıcı için kopyala/yapıştır yapılandırma istiyorsunuz
title: "Moonshot AI"
---

# Moonshot AI (Kimi)

Moonshot, OpenAI uyumlu uç noktalarla Kimi API’sini sağlar. Sağlayıcıyı
yapılandırın ve varsayılan modeli `moonshot/kimi-k2.5` olarak ayarlayın ya da
`kimi-coding/k2p5` ile Kimi Coding’i kullanın.

Mevcut Kimi K2 model kimlikleri:

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

Not: Moonshot ve Kimi Coding ayrı sağlayıcılardır. Anahtarlar birbirinin yerine kullanılamaz, uç noktalar farklıdır ve model referansları farklıdır (Moonshot `moonshot/...` kullanır, Kimi Coding `kimi-coding/...` kullanır).

## Yapılandırma parçası (Moonshot API)

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

## Notlar

- Moonshot model referansları `moonshot/<modelId>` kullanır. Kimi Coding model referansları `kimi-coding/<modelId>` kullanır.
- Gerekirse fiyatlandırma ve bağlam meta verilerini `models.providers` içinde geçersiz kılın.
- Moonshot bir model için farklı bağlam sınırları yayımlarsa,
  `contextWindow` değerini buna göre ayarlayın.
- Uluslararası uç nokta için `https://api.moonshot.ai/v1`, Çin uç noktası için `https://api.moonshot.cn/v1` kullanın.
