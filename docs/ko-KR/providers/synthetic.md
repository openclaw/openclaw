---
summary: "OpenClaw에서 Synthetic의 Anthropic 호환 API를 사용합니다"
read_when:
  - 모델 제공자로 Synthetic을 사용하고 싶을 때
  - Synthetic API 키 또는 기본 URL 설정이 필요할 때
title: "Synthetic"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/synthetic.md"
  workflow: 15
---

# Synthetic

Synthetic은 Anthropic 호환 엔드포인트를 노출합니다. OpenClaw는 이를 `synthetic` 제공자로 등록하고 Anthropic 메시지 API를 사용합니다.

## 빠른 설정

1. `SYNTHETIC_API_KEY` 설정 (또는 아래 마법사 실행).
2. 온보딩 실행:

```bash
openclaw onboard --auth-choice synthetic-api-key
```

기본 모델은 다음으로 설정됩니다:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## 구성 예제

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

참고: OpenClaw의 Anthropic 클라이언트는 기본 URL에 `/v1`을 추가하므로 `https://api.synthetic.new/anthropic` (`/anthropic/v1` 없음)을 사용합니다. Synthetic이 기본 URL을 변경하면 `models.providers.synthetic.baseUrl`을 재정의합니다.

## 모델 카탈로그

아래의 모든 모델은 비용 `0` (입력/출력/캐시)을 사용합니다.

| 모델 ID                                                | 컨텍스트 창 | 최대 토큰 | 추론  | 입력         |
| ------------------------------------------------------ | ----------- | --------- | ----- | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000      | 65536     | false | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000      | 8192      | true  | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000      | 128000    | false | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000      | 8192      | false | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000      | 8192      | false | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000      | 8192      | false | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000      | 8192      | false | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000      | 8192      | false | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000      | 8192      | false | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000      | 8192      | false | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000      | 8192      | false | text         |
| `hf:openai/gpt-oss-120b`                               | 128000      | 8192      | false | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000      | 8192      | false | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000      | 8192      | false | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000      | 8192      | false | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000      | 128000    | false | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000      | 128000    | false | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000      | 8192      | false | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000      | 8192      | true  | text         |

## 참고

- 모델 참조는 `synthetic/<modelId>`를 사용합니다.
- 모델 허용 목록 (`agents.defaults.models`)을 활성화하는 경우 사용할 모든 모델을 추가합니다.
- 제공자 규칙은 [모델 제공자](/concepts/model-providers)를 참조하세요.
