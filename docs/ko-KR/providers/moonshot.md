---
summary: "Moonshot K2 vs Kimi Coding 설정 (프로바이더 별도 + 키)"
read_when:
  - Moonshot K2 (Moonshot Open Platform) vs Kimi Coding 설정을 원하는 경우
  - 별도 엔드포인트, 키, 모델 참조를 이해해야 하는 경우
  - 두 프로바이더에 대한 설정 복사/붙여넣기를 원하는 경우
title: "Moonshot AI"
---

# Moonshot AI (Kimi)

Moonshot은 OpenAI 호환 엔드포인트를 제공하는 Kimi API를 제공합니다. 프로바이더를 설정하고 기본 모델을 `moonshot/kimi-k2.5`로 설정하거나, Kimi Coding을 `kimi-coding/k2p5`로 사용할 수 있습니다.

현재 Kimi K2 모델 ID:

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

Note: Moonshot과 Kimi Coding은 별도의 프로바이더입니다. 키는 호환되지 않으며, 엔드포인트와 모델 참조가 다릅니다 (Moonshot은 `moonshot/...` 사용, Kimi Coding은 `kimi-coding/...` 사용).

## 구성 스니ippet (Moonshot API)

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

- Moonshot 모델 참조는 `moonshot/<modelId>`를 사용합니다. Kimi Coding 모델 참조는 `kimi-coding/<modelId>`를 사용합니다.
- 필요에 따라 `models.providers`의 가격 및 컨텍스트 메타데이터를 재정의합니다.
- Moonshot이 모델에 대해 다른 컨텍스트 제한을 발표할 경우, `contextWindow`를 조정하십시오.
- 국제 엔드포인트는 `https://api.moonshot.ai/v1`를, 중국 엔드포인트는 `https://api.moonshot.cn/v1`를 사용하십시오.