---
summary: "OpenClaw에서 Venice AI 개인정보 보호 중심 모델을 사용합니다"
read_when:
  - OpenClaw에서 개인정보 보호 중심 추론을 원할 때
  - Venice AI 설정 지침이 필요할 때
title: "Venice AI"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/venice.md"
  workflow: 15
---

# Venice AI (Venice 하이라이트)

**Venice**는 개인정보 보호 우선 추론과 독점 모델에 대한 익명화된 액세스 옵션이 있는 강조 Venice 설정입니다.

Venice AI는 검열되지 않은 모델에 대한 지원 및 익명화된 프록시를 통한 주요 독점 모델에 대한 액세스를 갖춘 개인정보 보호 중심 AI 추론을 제공합니다. 모든 추론은 기본적으로 비공개 — 데이터 학습 없음, 로깅 없음.

## OpenClaw에서 Venice를 사용하는 이유

- **비공개 추론** (로깅 없음).
- **검열되지 않은 모델** 필요할 때.
- **익명화된 액세스** 품질이 중요할 때의 독점 모델 (Opus/GPT/Gemini).
- OpenAI 호환 `/v1` 엔드포인트.

## 개인정보 보호 모드

Venice는 두 가지 개인정보 보호 수준을 제공합니다 — 이를 이해하는 것은 모델 선택의 핵심입니다:

| 모드         | 설명                                                                                                     | 모델                                         |
| ------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **비공개**   | 완전 비공개. 프롬프트/응답은 **절대 저장되거나 로깅되지 않습니다**. 일시적.                              | Llama, Qwen, DeepSeek, Venice Uncensored, 등 |
| **익명화됨** | Venice를 통해 프록시. 메타데이터가 제거됩니다. 기본 제공자 (OpenAI, Anthropic)는 익명화된 요청을 봅니다. | Claude, GPT, Gemini, Grok, Kimi, MiniMax     |

## 기능

- **개인정보 보호 중심**: "비공개" (완전 비공개)와 "익명화됨" (프록시) 모드 간 선택
- **검열되지 않은 모델**: 콘텐츠 제한이 없는 모델에 액세스
- **주요 모델 액세스**: Venice의 익명화 프록시를 통해 Claude, GPT-5.2, Gemini, Grok 사용
- **OpenAI 호환 API**: 쉬운 통합을 위한 표준 `/v1` 엔드포인트
- **스트리밍**: ✅ 모든 모델에서 지원됨
- **함수 호출**: ✅ 선택 모델에서 지원됨 (모델 기능 확인)
- **Vision**: ✅ 비전 기능이 있는 모델에서 지원됨
- **하드 속도 제한 없음**: 극한 사용의 경우 공정 사용 조절 적용 가능

## 설정

### 1. API 키 얻기

1. [venice.ai](https://venice.ai)에 가입합니다
2. **설정 → API 키 → 새 키 생성**로 이동합니다
3. API 키 복사 (형식: `vapi_xxxxxxxxxxxx`)

### 2. OpenClaw 구성

**옵션 A: 환경 변수**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**옵션 B: 대화형 설정 (권장)**

```bash
openclaw onboard --auth-choice venice-api-key
```

다음이 수행됩니다:

1. API 키 입력 메시지 (또는 기존 `VENICE_API_KEY` 사용)
2. 모든 사용 가능한 Venice 모델 표시
3. 기본 모델을 선택하도록 합니다
4. 제공자를 자동으로 구성합니다

**옵션 C: 비대화형**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. 설정 확인

```bash
openclaw agent --model venice/llama-3.3-70b --message "Hello, are you working?"
```

## 모델 선택

설정 후 OpenClaw는 모든 사용 가능한 Venice 모델을 표시합니다. 필요에 따라 선택합니다:

- **기본 (우리 선택)**: 비공개, 균형 잡힌 성능을 위한 `venice/llama-3.3-70b`.
- **최고 품질**: 어려운 작업을 위한 `venice/claude-opus-45` (Opus는 여전히 가장 강력함).
- **개인정보 보호**: 완전 비공개 추론을 위해 "비공개" 모델을 선택합니다.
- **기능**: Claude, GPT, Gemini를 Venice의 프록시를 통해 액세스하려면 "익명화됨" 모델을 선택합니다.

기본 모델을 언제든지 변경합니다:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

모든 사용 가능한 모델을 나열합니다:

```bash
openclaw models list | grep venice
```

## `openclaw configure`를 통해 구성

1. `openclaw configure` 실행
2. **모델/인증** 선택
3. **Venice AI** 선택

## 어떤 모델을 사용해야 합니까?

| 사용 사례                       | 권장 모델                        | 이유                           |
| ------------------------------- | -------------------------------- | ------------------------------ |
| **일반 채팅**                   | `llama-3.3-70b`                  | 좋은 올라운더, 완전 비공개     |
| **최고 품질**                   | `claude-opus-45`                 | Opus는 어려운 작업에 가장 강력 |
| **개인정보 보호 + Claude 품질** | `claude-opus-45`                 | 익명화 프록시를 통한 최고 추론 |
| **코딩**                        | `qwen3-coder-480b-a35b-instruct` | 코드 최적화, 262k 컨텍스트     |
| **Vision 작업**                 | `qwen3-vl-235b-a22b`             | 최고 비공개 비전 모델          |
| **검열되지 않음**               | `venice-uncensored`              | 콘텐츠 제한 없음               |
| **빠름 + 저렴**                 | `qwen3-4b`                       | 경량, 여전히 기능              |
| **복잡한 추론**                 | `deepseek-v3.2`                  | 강력한 추론, 비공개            |

## 사용 가능한 모델 (25개 총)

### 비공개 모델 (15개) — 완전 비공개, 로깅 없음

| 모델 ID                          | 이름                    | 컨텍스트 (토큰) | 기능           |
| -------------------------------- | ----------------------- | --------------- | -------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B           | 131k            | 일반           |
| `llama-3.2-3b`                   | Llama 3.2 3B            | 131k            | 빠름, 경량     |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B | 131k            | 복잡한 작업    |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking     | 131k            | 추론           |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct     | 131k            | 일반           |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B        | 262k            | 코드           |
| `qwen3-next-80b`                 | Qwen3 Next 80B          | 262k            | 일반           |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B           | 262k            | Vision         |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k             | 빠름, 추론     |
| `deepseek-v3.2`                  | DeepSeek V3.2           | 163k            | 추론           |
| `venice-uncensored`              | Venice Uncensored       | 32k             | 검열되지 않음  |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k            | Vision         |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct    | 202k            | Vision         |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B     | 131k            | 일반           |
| `zai-org-glm-4.7`                | GLM 4.7                 | 202k            | 추론, 다중언어 |

### 익명화 모델 (10개) — Venice 프록시를 통해

| 모델 ID                  | 원본              | 컨텍스트 (토큰) | 기능         |
| ------------------------ | ----------------- | --------------- | ------------ |
| `claude-opus-45`         | Claude Opus 4.5   | 202k            | 추론, vision |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k            | 추론, vision |
| `openai-gpt-52`          | GPT-5.2           | 262k            | 추론         |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k            | 추론, vision |
| `gemini-3-pro-preview`   | Gemini 3 Pro      | 202k            | 추론, vision |
| `gemini-3-flash-preview` | Gemini 3 Flash    | 262k            | 추론, vision |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k            | 추론, vision |
| `grok-code-fast-1`       | Grok Code Fast 1  | 262k            | 추론, 코드   |
| `kimi-k2-thinking`       | Kimi K2 Thinking  | 262k            | 추론         |
| `minimax-m21`            | MiniMax M2.1      | 202k            | 추론         |

## 모델 발견

OpenClaw는 `VENICE_API_KEY`가 설정될 때 Venice API에서 자동으로 모델을 발견합니다. API에 연결할 수 없으면 정적 카탈로그로 폴백합니다.

`/models` 엔드포인트는 공개이지만 (나열에는 인증이 필요하지 않음) 추론에는 유효한 API 키가 필요합니다.

## 스트리밍 및 도구 지원

| 기능              | 지원                                                    |
| ----------------- | ------------------------------------------------------- |
| **스트리밍**      | ✅ 모든 모델                                            |
| **함수 호출**     | ✅ 대부분 모델 (API에서 `supportsFunctionCalling` 확인) |
| **Vision/이미지** | ✅ "Vision" 기능이 표시된 모델                          |
| **JSON 모드**     | ✅ `response_format`을 통해 지원됨                      |

## 가격

Venice는 크레딧 기반 시스템을 사용합니다. 현재 요금은 [venice.ai/pricing](https://venice.ai/pricing)을 확인하세요:

- **비공개 모델**: 일반적으로 낮은 비용
- **익명화 모델**: 직접 API 가격과 유사 + 작은 Venice 수수료

## 비교: Venice vs 직접 API

| 측면              | Venice (익명화)         | 직접 API    |
| ----------------- | ----------------------- | ----------- |
| **개인정보 보호** | 메타데이터 제거, 익명화 | 계정 연결됨 |
| **지연**          | +10-50ms (프록시)       | 직접        |
| **기능**          | 대부분 기능 지원        | 전체 기능   |
| **청구**          | Venice 크레딧           | 제공자 청구 |

## 사용 예제

```bash
# 기본 비공개 모델 사용
openclaw agent --model venice/llama-3.3-70b --message "Quick health check"

# Venice를 통해 Claude 사용 (익명화)
openclaw agent --model venice/claude-opus-45 --message "Summarize this task"

# 검열되지 않은 모델 사용
openclaw agent --model venice/venice-uncensored --message "Draft options"

# 이미지가 있는 Vision 모델 사용
openclaw agent --model venice/qwen3-vl-235b-a22b --message "Review attached image"

# 코딩 모델 사용
openclaw agent --model venice/qwen3-coder-480b-a35b-instruct --message "Refactor this function"
```

## 문제 해결

### API 키가 인식되지 않음

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

키가 `vapi_`로 시작하는지 확인합니다.

### 모델을 사용할 수 없음

Venice 모델 카탈로그는 동적으로 업데이트됩니다. `openclaw models list`를 실행하여 현재 사용 가능한 모델을 확인합니다. 일부 모델은 임시로 오프라인일 수 있습니다.

### 연결 문제

Venice API는 `https://api.venice.ai/api/v1`에 있습니다. 네트워크가 HTTPS 연결을 허용하는지 확인합니다.

## 구성 파일 예제

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
- [API 문서](https://docs.venice.ai)
- [가격](https://venice.ai/pricing)
- [상태](https://status.venice.ai)
