---
read_when:
    - Synthetic을 모델 공급자로 사용하고 싶습니다.
    - 합성 API 키 또는 기본 URL 설정이 필요합니다.
summary: OpenClaw에서 Synthetic의 Anthropic 호환 API 사용
title: 인조
x-i18n:
    generated_at: "2026-02-08T16:01:38Z"
    model: gtx
    provider: google-translate
    source_hash: f3f6e3eb864661754cbe2276783c5bc96ae01cb85ee4a19c92bed7863a35a4f7
    source_path: providers/synthetic.md
    workflow: 15
---

# 인조

Synthetic은 Anthropic 호환 엔드포인트를 노출합니다. OpenClaw는 이를
`synthetic` 공급자이며 Anthropic Messages API를 사용합니다.

## 빠른 설정

1. 세트 `SYNTHETIC_API_KEY` (또는 아래 마법사를 실행하세요).
2. 온보딩 실행:

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

참고: OpenClaw의 Anthropic 클라이언트가 추가됩니다. `/v1` 기본 URL에 연결하므로 다음을 사용하세요.
`https://api.synthetic.new/anthropic` (아니다 `/anthropic/v1`). 합성이 변경된 경우
기본 URL, 재정의 `models.providers.synthetic.baseUrl`.

## 모델 카탈로그

사용 비용 이하의 모든 모델 `0` (입력/출력/캐시).

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

## 메모

- 모델 참조 사용 `synthetic/<modelId>`.
- 모델 허용 목록(`agents.defaults.models`), 원하는 모든 모델을 추가하세요.
  사용할 계획입니다.
- 보다 [모델 제공자](/concepts/model-providers) 공급자 규칙의 경우.
