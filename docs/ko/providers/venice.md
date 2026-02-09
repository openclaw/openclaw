---
summary: "OpenClaw 에서 Venice AI 프라이버시 중심 모델 사용"
read_when:
  - OpenClaw 에서 프라이버시 중심 추론이 필요합니다
  - Venice AI 설정 가이드가 필요합니다
title: "Venice AI"
---

# Venice AI (Venice 하이라이트)

**Venice** 는 프라이버시 우선 추론을 위한 당사의 하이라이트 Venice 설정으로, 독점 모델에 대한 선택적 익명화 액세스를 제공합니다.

Venice AI 는 검열되지 않은 모델을 지원하고, 익명화된 프록시를 통해 주요 독점 모델에 접근할 수 있는 프라이버시 중심 AI 추론을 제공합니다. 모든 추론은 기본적으로 비공개입니다 — 데이터 학습 없음, 로깅 없음.

## OpenClaw 에서 Venice 를 사용하는 이유

- **비공개 추론**: 오픈 소스 모델에 대해 로깅 없음.
- **검열되지 않은 모델**: 필요할 때 사용.
- **익명화 액세스**: 품질이 중요한 경우 독점 모델(Opus/GPT/Gemini)에 접근.
- OpenAI 호환 `/v1` 엔드포인트.

## 프라이버시 모드

Venice 는 두 가지 프라이버시 수준을 제공합니다 — 모델 선택의 핵심입니다:

| 모드             | 설명                                                                                                                               | 모델                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Private**    | 완전 비공개. 프롬프트/응답은 **절대 저장되거나 로깅되지 않습니다**. 일회성입니다.                                 | Llama, Qwen, DeepSeek, Venice Uncensored 등 |
| **Anonymized** | 메타데이터를 제거한 상태로 Venice 를 통해 프록시됩니다. 기본 프로바이더(OpenAI, Anthropic)는 익명화된 요청을 봅니다. | Claude, GPT, Gemini, Grok, Kimi, MiniMax   |

## 기능

- **프라이버시 중심**: "private"(완전 비공개)와 "anonymized"(프록시) 모드 중 선택
- **검열되지 않은 모델**: 콘텐츠 제한 없는 모델에 접근
- **주요 모델 접근**: Venice 의 익명화 프록시를 통해 Claude, GPT-5.2, Gemini, Grok 사용
- **OpenAI 호환 API**: 쉬운 통합을 위한 표준 `/v1` 엔드포인트
- **스트리밍**: ✅ 모든 모델에서 지원
- **함수 호출**: ✅ 일부 모델에서 지원(모델 기능 확인)
- **비전**: ✅ 비전 기능이 있는 모델에서 지원
- **하드 레이트 리밋 없음**: 극단적인 사용에는 공정 사용 스로틀링이 적용될 수 있음

## 설정

### 1. API 키 받기

1. [venice.ai](https://venice.ai) 에서 가입
2. **Settings → API Keys → Create new key** 로 이동
3. API 키 복사(형식: `vapi_xxxxxxxxxxxx`)

### 2) OpenClaw 구성

**옵션 A: 환경 변수**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**옵션 B: 대화형 설정(권장)**

```bash
openclaw onboard --auth-choice venice-api-key
```

다음이 수행됩니다:

1. API 키 입력을 요청(또는 기존 `VENICE_API_KEY` 사용)
2. 사용 가능한 모든 Venice 모델 표시
3. 기본 모델 선택
4. 프로바이더 자동 구성

**옵션 C: 비대화형**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. 설정 확인

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## 모델 선택

설정 후 OpenClaw 는 사용 가능한 모든 Venice 모델을 표시합니다. 필요에 따라 선택하십시오:

- **기본값(권장)**: 비공개이면서 균형 잡힌 성능의 `venice/llama-3.3-70b`.
- **최고의 전체 품질**: 어려운 작업에는 `venice/claude-opus-45`(Opus 가 여전히 가장 강력함).
- **프라이버시**: 완전 비공개 추론을 위해 "private" 모델 선택.
- **역량**: Venice 프록시를 통해 Claude, GPT, Gemini 에 접근하려면 "anonymized" 모델 선택.

기본 모델은 언제든 변경할 수 있습니다:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

사용 가능한 모든 모델 나열:

```bash
openclaw models list | grep venice
```

## `openclaw configure` 를 통한 구성

1. `openclaw configure` 실행
2. **Model/auth** 선택
3. **Venice AI** 선택

## 어떤 모델을 사용해야 하나요?

| 사용 사례                 | 권장 모델                            | 이유                     |
| --------------------- | -------------------------------- | ---------------------- |
| **일반 채팅**             | `llama-3.3-70b`                  | 전반적으로 우수하며 완전 비공개      |
| **최고의 전체 품질**         | `claude-opus-45`                 | 어려운 작업에서 Opus 가 가장 강력함 |
| **프라이버시 + Claude 품질** | `claude-opus-45`                 | 익명화 프록시를 통한 최고의 추론     |
| **코딩**                | `qwen3-coder-480b-a35b-instruct` | 코드 최적화, 262k 컨텍스트      |
| **비전 작업**             | `qwen3-vl-235b-a22b`             | 최고의 비공개 비전 모델          |
| **검열 없음**             | `venice-uncensored`              | 콘텐츠 제한 없음              |
| **빠르고 저렴함**           | `qwen3-4b`                       | 경량이지만 충분한 성능           |
| **복잡한 추론**            | `deepseek-v3.2`                  | 강력한 추론, 비공개            |

## 사용 가능한 모델(총 25개)

### Private 모델(15) — 완전 비공개, 로깅 없음

| 모델 ID                            | 이름                                         | 컨텍스트(토큰) | 기능      |
| -------------------------------- | ------------------------------------------ | --------------------------- | ------- |
| `llama-3.3-70b`                  | Llama 3.3 70B              | 131k                        | 일반      |
| `llama-3.2-3b`                   | Llama 3.2 3B               | 131k                        | 빠름, 경량  |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B    | 131k                        | 복잡한 작업  |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking                        | 131k                        | 추론      |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct                        | 131k                        | 일반      |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B                           | 262k                        | 코드      |
| `qwen3-next-80b`                 | Qwen3 Next 80B                             | 262k                        | 일반      |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B                              | 262k                        | 비전      |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k                         | 빠름, 추론  |
| `deepseek-v3.2`                  | DeepSeek V3.2              | 163k                        | 추론      |
| `venice-uncensored`              | Venice Uncensored                          | 32k                         | 검열 없음   |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k                        | 비전      |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct                       | 202k                        | 비전      |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B                        | 131k                        | 일반      |
| `zai-org-glm-4.7`                | GLM 4.7                    | 202k                        | 추론, 다국어 |

### Anonymized 모델(10) — Venice 프록시 경유

| 모델 ID                    | 원본                                | 컨텍스트(토큰) | 기능     |
| ------------------------ | --------------------------------- | --------------------------- | ------ |
| `claude-opus-45`         | Claude Opus 4.5   | 202k                        | 추론, 비전 |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k                        | 추론, 비전 |
| `openai-gpt-52`          | GPT-5.2           | 262k                        | 추론     |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k                        | 추론, 비전 |
| `gemini-3-pro-preview`   | Gemini 3 Pro                      | 202k                        | 추론, 비전 |
| `gemini-3-flash-preview` | Gemini 3 Flash                    | 262k                        | 추론, 비전 |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k                        | 추론, 비전 |
| `grok-code-fast-1`       | Grok Code Fast 1                  | 262k                        | 추론, 코드 |
| `kimi-k2-thinking`       | Kimi K2 Thinking                  | 262k                        | 추론     |
| `minimax-m21`            | MiniMax M2.1      | 202k                        | 추론     |

## 모델 디스커버리

`VENICE_API_KEY` 가 설정되면 OpenClaw 는 Venice API 에서 모델을 자동으로 디스커버리합니다. API 에 접근할 수 없는 경우 정적 카탈로그로 대체합니다.

`/models` 엔드포인트는 공개되어 있으며(목록에는 인증 불필요), 추론에는 유효한 API 키가 필요합니다.

## 스트리밍 및 도구 지원

| 기능          | 지원                                                                |
| ----------- | ----------------------------------------------------------------- |
| **스트리밍**    | ✅ 모든 모델                                                           |
| **함수 호출**   | ✅ 대부분의 모델(API 에서 `supportsFunctionCalling` 확인) |
| **비전/이미지**  | ✅ "Vision" 기능이 표시된 모델                                             |
| **JSON 모드** | ✅ `response_format` 를 통해 지원                                       |

## 가격

Venice 는 크레딧 기반 시스템을 사용합니다. 최신 요금은 [venice.ai/pricing](https://venice.ai/pricing) 을 확인하십시오:

- **Private 모델**: 일반적으로 더 낮은 비용
- **Anonymized 모델**: 직접 API 가격 + 소액의 Venice 수수료

## 비교: Venice vs 직접 API

| 측면        | Venice(Anonymized) | 직접 API  |
| --------- | ------------------------------------- | ------- |
| **프라이버시** | 메타데이터 제거, 익명화                         | 계정이 연결됨 |
| **지연 시간** | +10–50ms(프록시)      | 직접      |
| **기능**    | 대부분의 기능 지원                            | 전체 기능   |
| **청구**    | Venice 크레딧                            | 제공업체 과금 |

## 사용 예제

```bash
# Use default private model
openclaw chat --model venice/llama-3.3-70b

# Use Claude via Venice (anonymized)
openclaw chat --model venice/claude-opus-45

# Use uncensored model
openclaw chat --model venice/venice-uncensored

# Use vision model with image
openclaw chat --model venice/qwen3-vl-235b-a22b

# Use coding model
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## 문제 해결

### API 키가 인식되지 않음

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

키가 `vapi_` 로 시작하는지 확인하십시오.

### 모델을 사용할 수 없음

Venice 모델 카탈로그는 동적으로 업데이트됩니다. 현재 사용 가능한 모델을 보려면 `openclaw models list` 를 실행하십시오. 일부 모델은 일시적으로 오프라인일 수 있습니다.

### 연결 문제

Venice API 는 `https://api.venice.ai/api/v1` 에 있습니다. 네트워크에서 HTTPS 연결이 허용되는지 확인하십시오.

## 설정 파일 예시

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/llama-3.3-70b" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## 링크

- [Venice AI](https://venice.ai)
- [API Documentation](https://docs.venice.ai)
- [Pricing](https://venice.ai/pricing)
- [Status](https://status.venice.ai)
