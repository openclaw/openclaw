---
summary: "OpenClaw 에서 Venice AI 프라이버시 중심 모델 사용하기"
read_when:
  - OpenClaw 에서 프라이버시 중심 추론을 원할 때
  - Venice AI 설정 안내가 필요할 때
title: "Venice AI"
x-i18n:
  source_path: docs/providers/venice.md
---

# Venice AI (Venice 하이라이트)

**Venice** 는 프라이버시 우선 추론과 독점 모델에 대한 선택적 익명화 액세스를 위한 하이라이트 Venice 설정입니다.

Venice AI 는 무검열 모델 지원과 익명화 프록시를 통한 주요 독점 모델 액세스가 포함된 프라이버시 중심 AI 추론을 제공합니다. 모든 추론은 기본적으로 비공개입니다 -- 데이터 학습 없음, 로깅 없음.

## OpenClaw 에서 Venice 를 사용하는 이유

- 오픈소스 모델을 위한 **비공개 추론** (로깅 없음).
- 필요할 때 **무검열 모델**.
- 품질이 중요할 때 독점 모델 (Opus/GPT/Gemini) 에 대한 **익명화 액세스**.
- OpenAI 호환 `/v1` 엔드포인트.

## 프라이버시 모드

Venice 는 두 가지 프라이버시 수준을 제공합니다 -- 모델 선택의 핵심입니다:

| 모드           | 설명                                                                                                               | 모델                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **Private**    | 완전히 비공개. 프롬프트/응답은 **저장되거나 기록되지 않음**. 임시적.                                               | Llama, Qwen, DeepSeek, Kimi, MiniMax, Venice Uncensored 등 |
| **Anonymized** | Venice 를 통해 프록시되며 메타데이터 제거. 기본 프로바이더 (OpenAI, Anthropic, Google, xAI) 는 익명화된 요청을 봄. | Claude, GPT, Gemini, Grok                                  |

## 기능

- **프라이버시 중심**: "private" (완전 비공개) 와 "anonymized" (프록시) 모드 중 선택
- **무검열 모델**: 콘텐츠 제한 없는 모델에 대한 액세스
- **주요 모델 액세스**: Venice 의 익명화 프록시를 통해 Claude, GPT, Gemini, Grok 사용
- **OpenAI 호환 API**: 쉬운 통합을 위한 표준 `/v1` 엔드포인트
- **스트리밍**: 모든 모델에서 지원
- **함수 호출**: 일부 모델에서 지원 (API 의 모델 기능 확인)
- **비전**: 비전 기능이 있는 모델에서 지원
- **하드 속도 제한 없음**: 극단적인 사용에 대해 공정 사용 쓰로틀링이 적용될 수 있음

## 설정

### 1. API 키 받기

1. [venice.ai](https://venice.ai) 에 가입합니다
2. **Settings - API Keys - Create new key** 로 이동합니다
3. API 키를 복사합니다 (형식: `vapi_xxxxxxxxxxxx`)

### 2. OpenClaw 설정

**옵션 A: 환경 변수**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**옵션 B: 대화형 설정 (권장)**

```bash
openclaw onboard --auth-choice venice-api-key
```

이렇게 하면:

1. API 키를 입력하라는 메시지 (또는 기존 `VENICE_API_KEY` 사용)
2. 모든 사용 가능한 Venice 모델 표시
3. 기본 모델 선택
4. 프로바이더 자동 설정

**옵션 C: 비대화형**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. 설정 확인

```bash
openclaw agent --model venice/kimi-k2-5 --message "Hello, are you working?"
```

## 모델 선택

설정 후, OpenClaw 는 사용 가능한 모든 Venice 모델을 표시합니다. 필요에 따라 선택하세요:

- **기본 모델**: `venice/kimi-k2-5` -- 강력한 비공개 추론과 비전.
- **고성능 옵션**: `venice/claude-opus-4-6` -- 가장 강력한 익명화 Venice 경로.
- **프라이버시**: 완전한 비공개 추론을 위해 "private" 모델을 선택하세요.
- **기능**: Venice 프록시를 통해 Claude, GPT, Gemini 에 액세스하려면 "anonymized" 모델을 선택하세요.

기본 모델을 언제든지 변경할 수 있습니다:

```bash
openclaw models set venice/kimi-k2-5
openclaw models set venice/claude-opus-4-6
```

사용 가능한 모든 모델 나열:

```bash
openclaw models list | grep venice
```

## `openclaw configure` 를 통한 설정

1. `openclaw configure` 를 실행합니다
2. **Model/auth** 를 선택합니다
3. **Venice AI** 를 선택합니다

## 어떤 모델을 사용해야 할까요?

| 사용 사례              | 권장 모델                        | 이유                                  |
| ---------------------- | -------------------------------- | ------------------------------------- |
| **일반 채팅 (기본)**   | `kimi-k2-5`                      | 강력한 비공개 추론과 비전             |
| **최고 전체 품질**     | `claude-opus-4-6`                | 가장 강력한 익명화 Venice 옵션        |
| **프라이버시 + 코딩**  | `qwen3-coder-480b-a35b-instruct` | 대형 컨텍스트를 가진 비공개 코딩 모델 |
| **비공개 비전**        | `kimi-k2-5`                      | 비공개 모드를 벗어나지 않는 비전 지원 |
| **빠름 + 저렴**        | `qwen3-4b`                       | 경량 추론 모델                        |
| **복잡한 비공개 작업** | `deepseek-v3.2`                  | 강력한 추론, Venice 도구 지원 없음    |
| **무검열**             | `venice-uncensored`              | 콘텐츠 제한 없음                      |

## 사용 가능한 모델 (총 41 개)

### Private 모델 (26 개) - 완전 비공개, 로깅 없음

| 모델 ID                                | 이름                                | 컨텍스트 | 기능                  |
| -------------------------------------- | ----------------------------------- | -------- | --------------------- |
| `kimi-k2-5`                            | Kimi K2.5                           | 256k     | 기본, 추론, 비전      |
| `kimi-k2-thinking`                     | Kimi K2 Thinking                    | 256k     | 추론                  |
| `llama-3.3-70b`                        | Llama 3.3 70B                       | 128k     | 범용                  |
| `llama-3.2-3b`                         | Llama 3.2 3B                        | 128k     | 범용                  |
| `hermes-3-llama-3.1-405b`              | Hermes 3 Llama 3.1 405B             | 128k     | 범용, 도구 비활성화   |
| `qwen3-235b-a22b-thinking-2507`        | Qwen3 235B Thinking                 | 128k     | 추론                  |
| `qwen3-235b-a22b-instruct-2507`        | Qwen3 235B Instruct                 | 128k     | 범용                  |
| `qwen3-coder-480b-a35b-instruct`       | Qwen3 Coder 480B                    | 256k     | 코딩                  |
| `qwen3-coder-480b-a35b-instruct-turbo` | Qwen3 Coder 480B Turbo              | 256k     | 코딩                  |
| `qwen3-5-35b-a3b`                      | Qwen3.5 35B A3B                     | 256k     | 추론, 비전            |
| `qwen3-next-80b`                       | Qwen3 Next 80B                      | 256k     | 범용                  |
| `qwen3-vl-235b-a22b`                   | Qwen3 VL 235B (Vision)              | 256k     | 비전                  |
| `qwen3-4b`                             | Venice Small (Qwen3 4B)             | 32k      | 빠름, 추론            |
| `deepseek-v3.2`                        | DeepSeek V3.2                       | 160k     | 추론, 도구 비활성화   |
| `venice-uncensored`                    | Venice Uncensored (Dolphin-Mistral) | 32k      | 무검열, 도구 비활성화 |
| `mistral-31-24b`                       | Venice Medium (Mistral)             | 128k     | 비전                  |
| `google-gemma-3-27b-it`                | Google Gemma 3 27B Instruct         | 198k     | 비전                  |
| `openai-gpt-oss-120b`                  | OpenAI GPT OSS 120B                 | 128k     | 범용                  |
| `nvidia-nemotron-3-nano-30b-a3b`       | NVIDIA Nemotron 3 Nano 30B          | 128k     | 범용                  |
| `olafangensan-glm-4.7-flash-heretic`   | GLM 4.7 Flash Heretic               | 128k     | 추론                  |
| `zai-org-glm-4.6`                      | GLM 4.6                             | 198k     | 범용                  |
| `zai-org-glm-4.7`                      | GLM 4.7                             | 198k     | 추론                  |
| `zai-org-glm-4.7-flash`                | GLM 4.7 Flash                       | 128k     | 추론                  |
| `zai-org-glm-5`                        | GLM 5                               | 198k     | 추론                  |
| `minimax-m21`                          | MiniMax M2.1                        | 198k     | 추론                  |
| `minimax-m25`                          | MiniMax M2.5                        | 198k     | 추론                  |

### Anonymized 모델 (15 개) - Venice 프록시 경유

| 모델 ID                         | 이름                           | 컨텍스트 | 기능             |
| ------------------------------- | ------------------------------ | -------- | ---------------- |
| `claude-opus-4-6`               | Claude Opus 4.6 (via Venice)   | 1M       | 추론, 비전       |
| `claude-opus-4-5`               | Claude Opus 4.5 (via Venice)   | 198k     | 추론, 비전       |
| `claude-sonnet-4-6`             | Claude Sonnet 4.6 (via Venice) | 1M       | 추론, 비전       |
| `claude-sonnet-4-5`             | Claude Sonnet 4.5 (via Venice) | 198k     | 추론, 비전       |
| `openai-gpt-54`                 | GPT-5.4 (via Venice)           | 1M       | 추론, 비전       |
| `openai-gpt-53-codex`           | GPT-5.3 Codex (via Venice)     | 400k     | 추론, 비전, 코딩 |
| `openai-gpt-52`                 | GPT-5.2 (via Venice)           | 256k     | 추론             |
| `openai-gpt-52-codex`           | GPT-5.2 Codex (via Venice)     | 256k     | 추론, 비전, 코딩 |
| `openai-gpt-4o-2024-11-20`      | GPT-4o (via Venice)            | 128k     | 비전             |
| `openai-gpt-4o-mini-2024-07-18` | GPT-4o Mini (via Venice)       | 128k     | 비전             |
| `gemini-3-1-pro-preview`        | Gemini 3.1 Pro (via Venice)    | 1M       | 추론, 비전       |
| `gemini-3-pro-preview`          | Gemini 3 Pro (via Venice)      | 198k     | 추론, 비전       |
| `gemini-3-flash-preview`        | Gemini 3 Flash (via Venice)    | 256k     | 추론, 비전       |
| `grok-41-fast`                  | Grok 4.1 Fast (via Venice)     | 1M       | 추론, 비전       |
| `grok-code-fast-1`              | Grok Code Fast 1 (via Venice)  | 256k     | 추론, 코딩       |

## 모델 검색

`VENICE_API_KEY` 가 설정되면 OpenClaw 는 Venice API 에서 모델을 자동으로 검색합니다. API 에 접근할 수 없으면 정적 카탈로그로 폴백합니다.

`/models` 엔드포인트는 공개입니다 (목록에 인증 불필요). 추론에는 유효한 API 키가 필요합니다.

## 스트리밍 및 도구 지원

| 기능            | 지원                                                    |
| --------------- | ------------------------------------------------------- |
| **스트리밍**    | 모든 모델                                               |
| **함수 호출**   | 대부분의 모델 (API 에서 `supportsFunctionCalling` 확인) |
| **비전/이미지** | "Vision" 기능이 표시된 모델                             |
| **JSON 모드**   | `response_format` 을 통해 지원                          |

## 가격

Venice 는 크레딧 기반 시스템을 사용합니다. 현재 요금은 [venice.ai/pricing](https://venice.ai/pricing) 에서 확인하세요:

- **Private 모델**: 일반적으로 더 저렴
- **Anonymized 모델**: 직접 API 가격과 유사 + 소규모 Venice 수수료

## 비교: Venice vs 직접 API

| 측면           | Venice (Anonymized)     | 직접 API        |
| -------------- | ----------------------- | --------------- |
| **프라이버시** | 메타데이터 제거, 익명화 | 계정에 연결됨   |
| **지연**       | +10-50ms (프록시)       | 직접            |
| **기능**       | 대부분의 기능 지원      | 전체 기능       |
| **과금**       | Venice 크레딧           | 프로바이더 과금 |

## 사용 예제

```bash
# 기본 비공개 모델 사용
openclaw agent --model venice/kimi-k2-5 --message "Quick health check"

# Venice 를 통한 Claude Opus 사용 (익명화)
openclaw agent --model venice/claude-opus-4-6 --message "Summarize this task"

# 무검열 모델 사용
openclaw agent --model venice/venice-uncensored --message "Draft options"

# 이미지와 함께 비전 모델 사용
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

키가 `vapi_` 로 시작하는지 확인하세요.

### 모델을 사용할 수 없음

Venice 모델 카탈로그는 동적으로 업데이트됩니다. `openclaw models list` 를 실행하여 현재 사용 가능한 모델을 확인하세요. 일부 모델은 일시적으로 오프라인 상태일 수 있습니다.

### 연결 문제

Venice API 는 `https://api.venice.ai/api/v1` 에 있습니다. 네트워크가 HTTPS 연결을 허용하는지 확인하세요.

## 설정 파일 예제

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/kimi-k2-5" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-k2-5",
            name: "Kimi K2.5",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 65536,
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
