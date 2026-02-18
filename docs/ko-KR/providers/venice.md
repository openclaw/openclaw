````markdown
---
summary: "OpenClaw에서 Venice AI 개인 정보 중심 모델 사용"
read_when:
  - OpenClaw에서 개인 정보 중심 추론을 원할 때
  - Venice AI 설정 안내가 필요할 때
title: "Venice AI"
---

# Venice AI (Venice 하이라이트)

**Venice**는 개인 정보 우선 추론을 위한 Venice 설정의 하이라이트로, 독점 모델에 대한 익명 접근을 선택적으로 제공합니다.

Venice AI는 검열이 없는 모델을 지원하고 익명화된 프록시를 통해 주요 독점 모델에 접근할 수 있는 개인 정보 중심 AI 추론을 제공합니다. 모든 추론은 기본적으로 개인적으로 처리되며, 데이터 학습이나 로깅은 없습니다.

## OpenClaw에서 Venice를 사용하는 이유

- **개인 정보 보호 추론**을 위한 오픈 소스 모델 (로깅 없음).
- 필요할 때 **검열 없는 모델**.
- 품질이 중요한 경우 익명화된 **독점 모델 접근** (Opus/GPT/Gemini).
- OpenAI 호환 `/v1` 엔드포인트 제공.

## 개인 정보 모드

Venice는 두 가지 개인 정보 수준을 제공하며, 이를 이해하는 것이 모델 선택에 중요합니다:

| 모드          | 설명                                                                                                                | 모델                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **개인 정보** | 완전한 개인정보 보호. 프롬프트/응답이 **절대 저장되거나 로깅되지 않음**. 일시적으로 유지됨.                         | Llama, Qwen, DeepSeek, Venice Uncensored, 등 |
| **익명화됨**  | Venice를 통해 프록시 처리되어 메타데이터가 제거됨. 기저 프로바이더 (OpenAI, Anthropic) 가 익명화된 요청을 받습니다. | Claude, GPT, Gemini, Grok, Kimi, MiniMax     |

## 기능

- **개인 정보 중심**: "private" (완전한 개인) 및 "익명화된" (프록시 처리된) 모드 중 선택
- **검열 없는 모델**: 콘텐츠 제한 없는 모델 접근
- **주요 모델 접근**: Venice의 익명화 프록시를 통해 Claude, GPT-5.2, Gemini, Grok 사용
- **OpenAI 호환 API**: 쉬운 통합을 위한 표준 `/v1` 엔드포인트
- **스트리밍**: ✅ 모든 모델에서 지원
- **함수 호출**: ✅ 일부 모델에서 지원 (모델 기능 확인)
- **비전**: ✅ 비전 기능을 가진 모델에서 지원
- **강력한 사용 제한 없음**: 과도한 사용에 대한 공정 사용 스로틀링 가능

## 설정

### 1. API 키 얻기

1. [venice.ai](https://venice.ai)에서 가입
2. **설정 → API 키 → 새 키 생성** 으로 이동
3. API 키 복사 (형식: `vapi_xxxxxxxxxxxx`)

### 2. OpenClaw 구성

**옵션 A: 환경 변수**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```
````

**옵션 B: 상호작용 기반 설정 (권장)**

```bash
openclaw onboard --auth-choice venice-api-key
```

이 작업은 다음을 수행합니다:

1. API 키를 요청 (또는 기존 `VENICE_API_KEY` 사용)
2. 사용 가능한 모든 Venice 모델 표시
3. 기본 모델 선택 가능
4. 프로바이더 자동 구성

**옵션 C: 비상호작용**

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

설정 후에는 OpenClaw가 모든 사용 가능한 Venice 모델을 표시합니다. 필요에 따라 선택하십시오:

- **기본 (추천)**: `venice/llama-3.3-70b`로 개인 정보 및 균형 잡힌 성능
- **최고의 전반적 품질**: `venice/claude-opus-45`로 어려운 작업 (Opus는 여전히 가장 강력함)
- **개인 정보**: 완전한 개인 추론을 위해 "private" 모드를 선택
- **기능성**: Claude, GPT, Gemini에 접근하려면 "익명화된" 모델 선택

기본 모델은 언제든지 변경 가능합니다:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

모든 사용 가능한 모델 목록:

```bash
openclaw models list | grep venice
```

## `openclaw configure`를 통해 구성

1. `openclaw configure` 실행
2. **모델/인증** 선택
3. **Venice AI** 선택

## 어떤 모델을 사용해야 하나요?

| 사용 사례                 | 추천 모델                        | 이유                                      |
| ------------------------- | -------------------------------- | ----------------------------------------- |
| **일반 대화**             | `llama-3.3-70b`                  | 전반적으로 좋고, 완전한 개인 정보 보호    |
| **최고의 전반적 품질**    | `claude-opus-45`                 | Opus는 복잡한 작업에서 여전히 최고의 성과 |
| **Privacy + Claude 품질** | `claude-opus-45`                 | 익명화 프록시를 통한 최상의 추론          |
| **코딩**                  | `qwen3-coder-480b-a35b-instruct` | 코드 최적화, 262k 컨텍스트                |
| **비전 작업**             | `qwen3-vl-235b-a22b`             | 최고의 개인 정보 보호 비전 모델           |
| **검열 없음**             | `venice-uncensored`              | 콘텐츠 제한 없음                          |
| **빠르고 저렴함**         | `qwen3-4b`                       | 가벼우면서도 여전히 성능을 갖춤           |
| **복잡한 추론**           | `deepseek-v3.2`                  | 강력한 추론 능력, 개인정보 보호           |

## 사용 가능한 모델 (총 25개)

### 개인 정보 모델 (15개) — 완전한 개인 정보 보호, 로깅 없음

| 모델 ID                          | 이름                    | 컨텍스트 (토큰) | 특징              |
| -------------------------------- | ----------------------- | --------------- | ----------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B           | 131k            | 일반적인 사용     |
| `llama-3.2-3b`                   | Llama 3.2 3B            | 131k            | 빠르고 가벼움     |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B | 131k            | 복잡한 작업       |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking     | 131k            | 추론              |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct     | 131k            | 일반적인 사용     |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B        | 262k            | 코드              |
| `qwen3-next-80b`                 | Qwen3 Next 80B          | 262k            | 일반적인 사용     |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B           | 262k            | 비전              |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k             | 빠르며 추론 가능  |
| `deepseek-v3.2`                  | DeepSeek V3.2           | 163k            | 추론              |
| `venice-uncensored`              | Venice Uncensored       | 32k             | 검열 없음         |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k            | 비전              |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct    | 202k            | 비전              |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B     | 131k            | 일반적인 사용     |
| `zai-org-glm-4.7`                | GLM 4.7                 | 202k            | 추론, 다국어 지원 |

### 익명화 모델 (10개) — Venice 프록시를 통해

| 모델 ID                  | 원본              | 컨텍스트 (토큰) | 특징       |
| ------------------------ | ----------------- | --------------- | ---------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k            | 추론, 비전 |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k            | 추론, 비전 |
| `openai-gpt-52`          | GPT-5.2           | 262k            | 추론       |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k            | 추론, 비전 |
| `gemini-3-pro-preview`   | Gemini 3 Pro      | 202k            | 추론, 비전 |
| `gemini-3-flash-preview` | Gemini 3 Flash    | 262k            | 추론, 비전 |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k            | 추론, 비전 |
| `grok-code-fast-1`       | Grok Code Fast 1  | 262k            | 추론, 코드 |
| `kimi-k2-thinking`       | Kimi K2 Thinking  | 262k            | 추론       |
| `minimax-m21`            | MiniMax M2.1      | 202k            | 추론       |

## 모델 검색

`VENICE_API_KEY`가 설정되면 OpenClaw는 Venice API를 통해 모델을 자동으로 검색합니다. API에 접근할 수 없는 경우, 정적 카탈로그로 대체됩니다.

`/models` 엔드포인트는 공개되어 있으며 (목록을 위해 인증이 필요하지 않음), 추론 시에는 유효한 API 키가 필요합니다.

## 스트리밍 및 도구 지원

| 기능            | 지원                                                    |
| --------------- | ------------------------------------------------------- |
| **스트리밍**    | ✅ 모든 모델                                            |
| **함수 호출**   | ✅ 대부분의 모델 (API의 `supportsFunctionCalling` 확인) |
| **비전/이미지** | ✅ "비전" 기능이 있는 모델                              |
| **JSON 모드**   | ✅ `response_format`을 통해 지원                        |

## 가격

Venice는 크레딧 기반 시스템을 사용합니다. 현재 요금은 [venice.ai/pricing](https://venice.ai/pricing)를 참조하세요:

- **개인 정보 모델**: 일반적으로 낮은 비용
- **익명화 모델**: 직접 API 가격과 유사 + 약간의 Venice 수수료

## 비교: Venice vs 직접 API

| 측면          | Venice (익명화)         | 직접 API           |
| ------------- | ----------------------- | ------------------ |
| **개인 정보** | 메타데이터 제거, 익명화 | 귀하의 계정과 연결 |
| **지연 시간** | +10-50ms (프록시)       | 직접적             |
| **기능**      | 대부분의 기능 지원      | 전체 기능          |
| **청구서**    | Venice 크레딧           | 프로바이더 청구서  |

## 사용 예시

```bash
# 기본 개인 정보 모델 사용
openclaw chat --model venice/llama-3.3-70b

# Venice (익명화) 를 통한 Claude 사용
openclaw chat --model venice/claude-opus-45

# 검열 없는 모델 사용
openclaw chat --model venice/venice-uncensored

# 이미지와 함께 비전 모델 사용
openclaw chat --model venice/qwen3-vl-235b-a22b

# 코딩 모델 사용
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## 문제 해결

### API 키가 인식되지 않음

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

키가 `vapi_` 로 시작해야 합니다.

### 모델 사용 불가

Venice 모델 카탈로그는 동적으로 업데이트됩니다. 현재 사용 가능한 모델을 보려면 `openclaw models list` 를 실행하세요. 일부 모델은 일시적으로 오프라인일 수 있습니다.

### 연결 문제

Venice API는 `https://api.venice.ai/api/v1`에 있습니다. 귀하의 네트워크가 HTTPS 연결을 허용하는지 확인하십시오.

## 구성 파일 예시

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

```

```
