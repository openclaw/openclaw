---
summary: "Use Venice AI privacy-focused models in OpenClaw"
read_when:
  - You want privacy-focused inference in OpenClaw
  - You want Venice AI setup guidance
title: "Venice AI"
x-i18n:
  source_hash: 2453a6ec3a715c24c460f902dec1755edcad40328de2ef895e35a614a25624cf
---

# 베니스 AI (베니스 하이라이트)

**Venice**는 독점 모델에 대한 익명 액세스 옵션을 갖춘 개인 정보 보호 우선 추론을 위한 당사의 주요 베니스 설정입니다.

Venice AI는 무수정 모델을 지원하고 익명화된 프록시를 통해 주요 독점 모델에 대한 액세스를 통해 개인 정보 보호 중심의 AI 추론을 제공합니다. 모든 추론은 기본적으로 비공개이므로 데이터에 대한 교육이나 로깅이 없습니다.

## OpenClaw에 베니스가 있는 이유

- 오픈 소스 모델에 대한 **비공개 추론**(로깅 없음).
- 필요할 때 **무수정 모델**.
- 품질이 중요한 경우 독점 모델(Opus/GPT/Gemini)에 대한 **익명화된 액세스**.
- OpenAI 호환 `/v1` 엔드포인트.

## 개인 정보 보호 모드

베니스는 두 가지 개인 정보 보호 수준을 제공합니다. 이를 이해하는 것이 모델 선택의 핵심입니다.

| 모드       | 설명                                                                                                         | 모델                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **비공개** | 완전 비공개. 프롬프트/응답은 **저장되거나 기록되지 않습니다**. 임시.                                         | 라마, 퀀, DeepSeek, 베니스 무수정 등      |
| **익명화** | 메타데이터가 제거된 베니스를 통해 프록시됩니다. 기본 공급자(OpenAI, Anthropic)는 익명화된 요청을 확인합니다. | 클로드, GPT, 제미니, 그록, 키미, 미니맥스 |

## 기능

- **개인정보 보호 중심**: "비공개"(완전 비공개) 및 "익명화"(프록시) 모드 중에서 선택하세요.
- **무수정 모델**: 콘텐츠 제한 없이 모델에 액세스
- **주요 모델 액세스**: 베니스의 익명 프록시를 통해 Claude, GPT-5.2, Gemini, Grok 사용
- **OpenAI 호환 API**: 간편한 통합을 위한 표준 `/v1` 엔드포인트
- **스트리밍**: ✅ 모든 모델에서 지원됨
- **함수 호출**: ✅ 일부 모델에서 지원됨(모델 기능 확인)
- **비전**: ✅ 비전 기능이 있는 모델에서 지원됩니다.
- **엄격한 요금 제한 없음**: 극단적인 사용량에는 공정 사용 조절이 적용될 수 있습니다.

## 설정

### 1. API 키 받기

1. [venice.ai](https://venice.ai)에 가입하세요.
2. **설정 → API 키 → 새 키 생성**으로 이동합니다.
3. API 키를 복사하세요(형식: `vapi_xxxxxxxxxxxx`)

### 2. OpenClaw 구성

**옵션 A: 환경 변수**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**옵션 B: 대화형 설정(권장)**

```bash
openclaw onboard --auth-choice venice-api-key
```

이는 다음을 수행합니다.

1. API 키를 묻는 메시지를 표시합니다(또는 기존 `VENICE_API_KEY` 사용).
2. 사용 가능한 모든 베니스 모델 표시
3. 기본 모델을 선택하세요
4. 자동으로 공급자 구성

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

설정 후 OpenClaw는 사용 가능한 모든 베니스 모델을 표시합니다. 필요에 따라 선택하세요.

- **기본값(선택)**: `venice/llama-3.3-70b` 비공개적이고 균형 잡힌 성능을 위한 것입니다.
- **전체적으로 최고 품질**: `venice/claude-opus-45` 힘든 작업용(Opus는 여전히 가장 강력함).
- **프라이버시**: 완전한 비공개 추론을 위해 "비공개" 모델을 선택합니다.
- **기능**: 베니스의 프록시를 통해 Claude, GPT, Gemini에 액세스하려면 "익명화된" 모델을 선택하세요.

언제든지 기본 모델을 변경하세요.

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

사용 가능한 모든 모델을 나열합니다.

```bash
openclaw models list | grep venice
```

## `openclaw configure`를 통해 구성

1. `openclaw configure` 실행
2. **모델/인증**을 선택합니다.
3. **베니스 AI**를 선택하세요.

## 어떤 모델을 사용해야 하나요?

| 사용 사례                       | 추천 모델                        | 왜                                                 |
| ------------------------------- | -------------------------------- | -------------------------------------------------- |
| **일반 채팅**                   | `llama-3.3-70b`                  | 다재다능하고 완전 비공개                           |
| **전체적으로 최고의 품질**      | `claude-opus-45`                 | Opus는 여전히 어려운 작업에 가장 강력한 제품입니다 |
| **개인정보 보호 + 클로드 품질** | `claude-opus-45`                 | 익명화된 프록시를 통한 최상의 추론                 |
| **코딩**                        | `qwen3-coder-480b-a35b-instruct` | 코드 최적화, 262k 컨텍스트                         |
| **비전 과제**                   | `qwen3-vl-235b-a22b`             | 최고의 프라이빗 비전 모델                          |
| **무수정**                      | `venice-uncensored`              | 콘텐츠 제한 없음                                   |
| **빠르고 저렴함**               | `qwen3-4b`                       | 가벼우면서도 여전히 뛰어난 성능                    |
| **복잡한 추론**                 | `deepseek-v3.2`                  | 강력한 추론, 비공개                                |

## 사용 가능한 모델(총 25개)

### 비공개 모델(15) — 완전 비공개, 로깅 없음

| 모델 ID                          | 이름                     | 컨텍스트(토큰) | 특징          |
| -------------------------------- | ------------------------ | -------------- | ------------- |
| `llama-3.3-70b`                  | 라마 3.3 70B             | 131k           | 일반          |
| `llama-3.2-3b`                   | 라마 3.2 3B              | 131k           | 빠르고 가벼운 |
| `hermes-3-llama-3.1-405b`        | 헤르메스 3 라마 3.1 405B | 131k           | 복잡한 작업   |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B 생각          | 131k           | 추론          |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B 지시          | 131k           | 일반          |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 코더 480B          | 262k           | 코드          |
| `qwen3-next-80b`                 | Qwen3 다음 80B           | 262k           | 일반          |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B            | 262k           | 비전          |
| `qwen3-4b`                       | 베니스 스몰(Qwen3 4B)    | 32k            | 빠른 추론     |
| `deepseek-v3.2`                  | DeepSeek V3.2            | 163k           | 추론          |
| `venice-uncensored`              | 베니스 무수정            | 32k            | 무수정        |
| `mistral-31-24b`                 | 베니스 미디엄(미스트랄)  | 131k           | 비전          |
| `google-gemma-3-27b-it`          | 젬마 3 27B 교육          | 202k           | 비전          |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B      | 131k           | 일반          |
| `zai-org-glm-4.7`                | GLM 4.7                  | 202k           | 추론, 다국어  |

### 익명 모델 (10) — 베니스 프록시를 통해

| 모델 ID                  | 원본               | 컨텍스트(토큰) | 특징       |
| ------------------------ | ------------------ | -------------- | ---------- |
| `claude-opus-45`         | 클로드 오푸스 4.5  | 202k           | 추론, 비전 |
| `claude-sonnet-45`       | 클로드 소네트 4.5  | 202k           | 추론, 비전 |
| `openai-gpt-52`          | GPT-5.2            | 262k           | 추론       |
| `openai-gpt-52-codex`    | GPT-5.2 코덱스     | 262k           | 추론, 비전 |
| `gemini-3-pro-preview`   | 제미니 3 프로      | 202k           | 추론, 비전 |
| `gemini-3-flash-preview` | 제미니 3 플래시    | 262k           | 추론, 비전 |
| `grok-41-fast`           | Grok 4.1 빠른      | 262k           | 추론, 비전 |
| `grok-code-fast-1`       | Grok 코드 패스트 1 | 262k           | 추론, 코드 |
| `kimi-k2-thinking`       | 키미 K2 생각       | 262k           | 추론       |
| `minimax-m21`            | 미니맥스 M2.1      | 202k           | 추론       |

## 모델 발굴

OpenClaw는 `VENICE_API_KEY`가 설정되면 Venice API에서 모델을 자동으로 검색합니다. API에 연결할 수 없으면 정적 카탈로그로 대체됩니다.

`/models` 엔드포인트는 공개이지만(목록에 인증이 필요하지 않음) 추론을 위해서는 유효한 API 키가 필요합니다.

## 스트리밍 및 도구 지원

| 기능            | 지원                                                     |
| --------------- | -------------------------------------------------------- |
| **스트리밍**    | ✅ 모든 모델                                             |
| **함수 호출**   | ✅ 대부분의 모델(API에서 `supportsFunctionCalling` 확인) |
| **비전/이미지** | ✅ "Vision" 기능이 표시된 모델                           |
| **JSON 모드**   | ✅ `response_format`를 통해 지원됨                       |

## 가격

베니스는 학점 기반 시스템을 사용합니다. 현재 요금은 [venice.ai/pricing](https://venice.ai/pricing)에서 확인하세요.

- **개인 모델**: 일반적으로 가격이 저렴함
- **익명화된 모델**: 직접 API 가격 책정과 유사 + 소액의 베니스 수수료

## 비교: Venice 대 Direct API

| 측면             | 베니스(익명)                 | 다이렉트 API                 |
| ---------------- | ---------------------------- | ---------------------------- |
| **개인정보보호** | 제거되고 익명화된 메타데이터 | 귀하의 계정이 연결되었습니다 |
| **지연 시간**    | +10-50ms(프록시)             | 직접                         |
| **특징**         | 대부분의 기능 지원           | 전체 기능                    |
| **결제**         | 베니스 크레딧                | 공급자 청구                  |

## 사용 예

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

### API 키가 인식되지 않습니다

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

키가 `vapi_`로 시작하는지 확인하세요.

### 사용할 수 없는 모델

베니스 모델 카탈로그는 동적으로 업데이트됩니다. 현재 사용 가능한 모델을 보려면 `openclaw models list`를 실행하세요. 일부 모델은 일시적으로 오프라인 상태일 수 있습니다.

### 연결 문제

베니스 API는 `https://api.venice.ai/api/v1`에 있습니다. 네트워크가 HTTPS 연결을 허용하는지 확인하세요.

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

- [베니스 AI](https://venice.ai)
- [API 문서](https://docs.venice.ai)
- [가격](https://venice.ai/pricing)
- [상태](https://status.venice.ai)
