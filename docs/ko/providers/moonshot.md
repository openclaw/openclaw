---
summary: "Moonshot K2 대 Kimi Coding 설정 (분리된 프로바이더 + 키)"
read_when:
  - Moonshot K2 (Moonshot Open Platform)와 Kimi Coding 설정이 필요할 때
  - 분리된 엔드포인트, 키, 모델 참조를 이해해야 할 때
  - 어느 프로바이더든 복사/붙여넣기 설정을 원할 때
title: "Moonshot AI"
---

# Moonshot AI (Kimi)

Moonshot 은 OpenAI 호환 엔드포인트를 제공하는 Kimi API 를 제공합니다. 프로바이더를 구성하고 기본 모델을 `moonshot/kimi-k2.5` 로 설정하거나,  
`kimi-coding/k2p5` 를 사용하는 Kimi Coding 을 이용하십시오.

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

참고: Moonshot 과 Kimi Coding 은 분리된 프로바이더입니다. 키는 서로 호환되지 않으며, 엔드포인트가 다르고 모델 참조도 다릅니다 (Moonshot 은 `moonshot/...` 를 사용하고, Kimi Coding 은 `kimi-coding/...` 를 사용합니다).

## Config snippet (Moonshot API)

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

- Moonshot 모델 참조는 `moonshot/<modelId>` 를 사용합니다. Kimi Coding 모델 참조는 `kimi-coding/<modelId>` 를 사용합니다.
- 필요 시 `models.providers` 에서 가격 및 컨텍스트 메타데이터를 재정의하십시오.
- Moonshot 이 특정 모델에 대해 다른 컨텍스트 한계를 게시하는 경우,  
  `contextWindow` 을(를) 그에 맞게 조정하십시오.
- 국제 엔드포인트에는 `https://api.moonshot.ai/v1` 을(를) 사용하고, 중국 엔드포인트에는 `https://api.moonshot.cn/v1` 을(를) 사용하십시오.
