---
summary: "Moonshot K2 와 Kimi Coding 설정 (별도 프로바이더 + 키)"
read_when:
  - Moonshot K2 (Moonshot Open Platform) 와 Kimi Coding 설정이 필요할 때
  - 별도의 엔드포인트, 키 및 모델 참조를 이해해야 할 때
  - 각 프로바이더에 대한 복사/붙여넣기 설정이 필요할 때
title: "Moonshot AI"
x-i18n:
  source_path: docs/providers/moonshot.md
---

# Moonshot AI (Kimi)

Moonshot 은 OpenAI 호환 엔드포인트로 Kimi API 를 제공합니다. 프로바이더를 설정하고 기본 모델을 `moonshot/kimi-k2.5` 로 설정하거나, Kimi Coding 의 경우 `kimi-coding/k2p5` 를 사용하세요.

현재 Kimi K2 모델 ID:

[//]: # "moonshot-kimi-k2-ids:start"

- `kimi-k2.5`
- `kimi-k2-0905-preview`
- `kimi-k2-turbo-preview`
- `kimi-k2-thinking`
- `kimi-k2-thinking-turbo`

[//]: # "moonshot-kimi-k2-ids:end"

```bash
openclaw onboard --auth-choice moonshot-api-key
```

Kimi Coding:

```bash
openclaw onboard --auth-choice kimi-code-api-key
```

참고: Moonshot 과 Kimi Coding 은 별도의 프로바이더입니다. 키는 호환되지 않으며, 엔드포인트가 다르고, 모델 참조가 다릅니다 (Moonshot 은 `moonshot/...`, Kimi Coding 은 `kimi-coding/...` 사용).

## 설정 스니펫 (Moonshot API)

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

## 참고 사항

- Moonshot 모델 참조는 `moonshot/<modelId>` 를 사용합니다. Kimi Coding 모델 참조는 `kimi-coding/<modelId>` 를 사용합니다.
- 필요에 따라 `models.providers` 에서 가격 및 컨텍스트 메타데이터를 재정의하세요.
- Moonshot 이 모델에 대해 다른 컨텍스트 제한을 게시하는 경우
  `contextWindow` 을 그에 맞게 조정하세요.
- 국제 엔드포인트는 `https://api.moonshot.ai/v1`, 중국 엔드포인트는 `https://api.moonshot.cn/v1` 을 사용하세요.

## 네이티브 thinking 모드 (Moonshot)

Moonshot Kimi 는 바이너리 네이티브 thinking 을 지원합니다:

- `thinking: { type: "enabled" }`
- `thinking: { type: "disabled" }`

`agents.defaults.models.<provider/model>.params` 를 통해 모델별로 설정하세요:

```json5
{
  agents: {
    defaults: {
      models: {
        "moonshot/kimi-k2.5": {
          params: {
            thinking: { type: "disabled" },
          },
        },
      },
    },
  },
}
```

OpenClaw 는 Moonshot 에 대해 런타임 `/think` 레벨도 매핑합니다:

- `/think off` -> `thinking.type=disabled`
- off 가 아닌 모든 thinking 레벨 -> `thinking.type=enabled`

Moonshot thinking 이 활성화되면, `tool_choice` 는 `auto` 또는 `none` 이어야 합니다. OpenClaw 는 호환성을 위해 호환되지 않는 `tool_choice` 값을 `auto` 로 정규화합니다.
