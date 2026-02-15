---
summary: "Configure Moonshot K2 vs Kimi Coding (separate providers + keys)"
read_when:
  - You want Moonshot K2 (Moonshot Open Platform) vs Kimi Coding setup
  - You need to understand separate endpoints, keys, and model refs
  - You want copy/paste config for either provider
title: "Moonshot AI"
x-i18n:
  source_hash: 9e4a6192faa21b881820d145e2415843b89e39a3be43451174b0ba9241aa873f
---

# 문샷 AI(키미)

Moonshot은 OpenAI 호환 엔드포인트와 함께 Kimi API를 제공합니다. 구성
공급자를 선택하고 기본 모델을 `moonshot/kimi-k2.5`로 설정하거나
`kimi-coding/k2p5`를 사용한 키미 코딩입니다.

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

키미 코딩:

```bash
openclaw onboard --auth-choice kimi-code-api-key
```

참고: Moonshot과 Kimi Coding은 별도의 제공업체입니다. 키는 상호 교환이 불가능하고, 엔드포인트가 다르며, 모델 참조가 다릅니다(Moonshot은 `moonshot/...`를 사용하고 Kimi Coding은 `kimi-coding/...`를 사용합니다).

## 구성 조각(Moonshot API)

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

## 키미코딩

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

## 메모

- Moonshot 모델 참조는 `moonshot/<modelId>`를 사용합니다. Kimi 코딩 모델 참조는 `kimi-coding/<modelId>`를 사용합니다.
- 필요한 경우 `models.providers`의 가격 및 컨텍스트 메타데이터를 재정의합니다.
- Moonshot이 모델에 대해 서로 다른 컨텍스트 제한을 게시하는 경우 조정합니다.
  `contextWindow` 따라서.
- 국제 엔드포인트에는 `https://api.moonshot.ai/v1`를 사용하고, 중국 엔드포인트에는 `https://api.moonshot.cn/v1`를 사용합니다.
