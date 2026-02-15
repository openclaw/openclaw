---
summary: "Use Synthetic's Anthropic-compatible API in OpenClaw"
read_when:
  - You want to use Synthetic as a model provider
  - You need a Synthetic API key or base URL setup
title: "Synthetic"
x-i18n:
  source_hash: f3f6e3eb864661754cbe2276783c5bc96ae01cb85ee4a19c92bed7863a35a4f7
---

# 합성

Synthetic은 Anthropic 호환 엔드포인트를 노출합니다. OpenClaw는 이를
`synthetic` 제공업체이며 Anthropic Messages API를 사용합니다.

## 빠른 설정

1. `SYNTHETIC_API_KEY`를 설정합니다(또는 아래 마법사를 실행합니다).
2. 온보딩을 실행합니다.

```bash
openclaw onboard --auth-choice synthetic-api-key
```

기본 모델은 다음과 같이 설정됩니다.

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## 구성 예

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

참고: OpenClaw의 Anthropic 클라이언트는 기본 URL에 `/v1`를 추가하므로 다음을 사용하십시오.
`https://api.synthetic.new/anthropic` (`/anthropic/v1` 아님). 합성이 변경된 경우
기본 URL은 `models.providers.synthetic.baseUrl`를 재정의하세요.

## 모델 카탈로그

아래의 모든 모델은 비용 `0`(입력/출력/캐시)를 사용합니다.

| 모델 ID                                                | 컨텍스트 창 | 최대 토큰 | 추론 | 입력            |
| ------------------------------------------------------ | ----------- | --------- | ---- | --------------- |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000      | 65536     | 거짓 | 텍스트          |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000      | 8192      | 사실 | 텍스트          |
| `hf:zai-org/GLM-4.7`                                   | 198000      | 128000    | 거짓 | 텍스트          |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000      | 8192      | 거짓 | 텍스트          |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000      | 8192      | 거짓 | 텍스트          |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000      | 8192      | 거짓 | 텍스트          |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000      | 8192      | 거짓 | 텍스트          |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000      | 8192      | 거짓 | 텍스트          |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000      | 8192      | 거짓 | 텍스트          |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000      | 8192      | 거짓 | 텍스트          |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000      | 8192      | 거짓 | 텍스트          |
| `hf:openai/gpt-oss-120b`                               | 128000      | 8192      | 거짓 | 텍스트          |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000      | 8192      | 거짓 | 텍스트          |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000      | 8192      | 거짓 | 텍스트          |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000      | 8192      | 거짓 | 텍스트 + 이미지 |
| `hf:zai-org/GLM-4.5`                                   | 128000      | 128000    | 거짓 | 텍스트          |
| `hf:zai-org/GLM-4.6`                                   | 198000      | 128000    | 거짓 | 텍스트          |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000      | 8192      | 거짓 | 텍스트          |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000      | 8192      | 사실 | 텍스트          |

## 메모

- 모델 참조는 `synthetic/<modelId>`를 사용합니다.
- 모델 허용 목록(`agents.defaults.models`)을 활성화하면 모든 모델을 추가하세요.
  사용할 계획입니다.
- 제공자 규칙은 [모델 제공자](/concepts/model-providers)를 참조하세요.
