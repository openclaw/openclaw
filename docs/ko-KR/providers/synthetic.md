````markdown
---
summary: "OpenClaw에서 Synthetic의 Anthropic 호환 API 사용"
read_when:
  - Synthetic을 모델 프로바이더로 사용하고 싶을 때
  - Synthetic API 키 또는 기본 URL 설정이 필요할 때
title: "Synthetic"
---

# Synthetic

Synthetic은 Anthropic 호환 엔드포인트를 노출합니다. OpenClaw는 이를 `synthetic` 프로바이더로 등록하고 Anthropic 메시지 API를 사용합니다.

## 빠른 설정

1. `SYNTHETIC_API_KEY`를 설정하세요 (또는 아래의 마법사를 실행하세요).
2. 온보딩을 실행하세요:

```bash
openclaw onboard --auth-choice synthetic-api-key
```
````

기본 모델은 다음으로 설정됩니다:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## 설정 예시

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

참고: OpenClaw의 Anthropic 클라이언트는 기본 URL에 `/v1`을 추가하므로 `https://api.synthetic.new/anthropic`을 사용하세요 (`/anthropic/v1` 아님). Synthetic이 기본 URL을 변경할 경우 `models.providers.synthetic.baseUrl`을 재정의하세요.

## 모델 카탈로그

아래 모든 모델은 비용이 `0` 입니다 (입력/출력/캐시).

| Model ID                                               | Context window | Max tokens | Reasoning | Input        |
| ------------------------------------------------------ | -------------- | ---------- | --------- | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000         | 65536      | false     | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000         | 8192       | true      | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000         | 128000     | false     | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000         | 8192       | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000         | 8192       | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000         | 8192       | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000         | 8192       | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000         | 8192       | false     | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000         | 8192       | false     | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000         | 8192       | false     | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000         | 8192       | false     | text         |
| `hf:openai/gpt-oss-120b`                               | 128000         | 8192       | false     | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000         | 8192       | false     | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000         | 8192       | false     | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000         | 8192       | false     | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000         | 128000     | false     | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000         | 128000     | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000         | 8192       | false     | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000         | 8192       | true      | text         |

## 주의사항

- 모델 참조는 `synthetic/<modelId>` 형식을 사용합니다.
- 모델 허용 목록을 활성화하려면 (`agents.defaults.models`), 사용할 계획인 모든 모델을 추가하세요.
- [Model providers](/concepts/model-providers)에서 프로바이더 규칙을 참조하세요.

```

```
