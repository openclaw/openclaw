---
read_when:
    - OpenClaw에서 개인정보 보호에 초점을 맞춘 추론을 원합니다.
    - Venice AI 설정 안내를 원합니다
summary: OpenClaw에서 Venice AI 개인 정보 보호 중심 모델 사용
title: 베니스 AI
x-i18n:
    generated_at: "2026-02-08T16:06:21Z"
    model: gtx
    provider: google-translate
    source_hash: 2453a6ec3a715c24c460f902dec1755edcad40328de2ef895e35a614a25624cf
    source_path: providers/venice.md
    workflow: 15
---

# 베니스 AI (베니스 하이라이트)

**베니스** 독점 모델에 대한 익명 액세스 옵션을 갖춘 개인 정보 보호 우선 추론을 위한 베니스의 주요 설정입니다.

Venice AI는 무수정 모델을 지원하고 익명화된 프록시를 통해 주요 독점 모델에 대한 액세스를 통해 개인 정보 보호 중심의 AI 추론을 제공합니다. 모든 추론은 기본적으로 비공개이므로 데이터에 대한 교육이나 로깅이 없습니다.

## OpenClaw에 베니스가 있는 이유

- **개인적인 추론** 오픈 소스 모델의 경우(로깅 없음)
- **무수정 모델** 필요할 때.
- **익명화된 액세스** 품질이 중요한 경우 독점 모델(Opus/GPT/Gemini)로 전환하세요.
- OpenAI 호환 `/v1` 끝점.

## 개인 정보 보호 모드

베니스는 두 가지 개인 정보 보호 수준을 제공합니다. 이를 이해하는 것이 모델 선택의 핵심입니다.

| Mode           | Description                                                                                                          | Models                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Private**    | Fully private. Prompts/responses are **never stored or logged**. Ephemeral.                                          | Llama, Qwen, DeepSeek, Venice Uncensored, etc. |
| **Anonymized** | Proxied through Venice with metadata stripped. The underlying provider (OpenAI, Anthropic) sees anonymized requests. | Claude, GPT, Gemini, Grok, Kimi, MiniMax       |

## 특징

- **개인 정보 보호 중심**: "비공개"(완전 비공개) 및 "익명화"(프록시) 모드 중에서 선택합니다.
- **무수정 모델**: 콘텐츠 제한 없이 모델에 접근 가능
- **주요 모델 액세스**: 베니스의 익명 프록시를 통해 Claude, GPT-5.2, Gemini, Grok 사용
- **OpenAI 호환 API**: 기준 `/v1` 간편한 통합을 위한 엔드포인트
- **스트리밍**: ✅ 모든 모델에서 지원됨
- **함수 호출**: ✅ 일부 모델에서 지원됨(모델 기능 확인)
- **비전**: ✅ 비전 기능이 있는 모델에서 지원됩니다.
- **엄격한 비율 제한 없음**: 극단적인 사용에는 공정 사용 제한이 적용될 수 있습니다.

## 설정

### 1. API 키 받기

1. 다음에서 가입하세요 [venice.ai](https://venice.ai)
2. 이동 **설정 → API 키 → 새 키 생성**
3. API 키를 복사합니다(형식: `vapi_xxxxxxxxxxxx`)

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

1. API 키를 묻는 메시지를 표시합니다(또는 기존 키 사용 `VENICE_API_KEY`)
2. 사용 가능한 모든 베니스 모델 보기
3. 기본 모델을 선택할 수 있습니다.
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

- **기본값(저희 선택)**: `venice/llama-3.3-70b` 프라이빗하고 균형 잡힌 성능을 제공합니다.
- **전반적으로 최고의 품질**: `venice/claude-opus-45` 힘든 일을 위해 (Opus는 여전히 가장 강력합니다).
- **은둔**: 완전한 비공개 추론을 위해서는 "비공개" 모델을 선택하세요.
- **능력**: 베니스의 프록시를 통해 Claude, GPT, Gemini에 액세스하려면 "익명화된" 모델을 선택하세요.

언제든지 기본 모델을 변경하세요.

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

사용 가능한 모든 모델을 나열합니다.

```bash
openclaw models list | grep venice
```

## 다음을 통해 구성 `openclaw configure`

1. 달리다 `openclaw configure`
2. 선택하다 **모델/인증**
3. 선택하다 **베니스 AI**

## 어떤 모델을 사용해야 합니까?

| Use Case                     | Recommended Model                | Why                                       |
| ---------------------------- | -------------------------------- | ----------------------------------------- |
| **General chat**             | `llama-3.3-70b`                  | Good all-around, fully private            |
| **Best overall quality**     | `claude-opus-45`                 | Opus remains the strongest for hard tasks |
| **Privacy + Claude quality** | `claude-opus-45`                 | Best reasoning via anonymized proxy       |
| **Coding**                   | `qwen3-coder-480b-a35b-instruct` | Code-optimized, 262k context              |
| **Vision tasks**             | `qwen3-vl-235b-a22b`             | Best private vision model                 |
| **Uncensored**               | `venice-uncensored`              | No content restrictions                   |
| **Fast + cheap**             | `qwen3-4b`                       | Lightweight, still capable                |
| **Complex reasoning**        | `deepseek-v3.2`                  | Strong reasoning, private                 |

## 사용 가능한 모델(총 25개)

### 비공개 모델(15) — 완전 비공개, 로깅 없음

| Model ID                         | Name                    | Context (tokens) | Features                |
| -------------------------------- | ----------------------- | ---------------- | ----------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B           | 131k             | General                 |
| `llama-3.2-3b`                   | Llama 3.2 3B            | 131k             | Fast, lightweight       |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B | 131k             | Complex tasks           |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking     | 131k             | Reasoning               |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct     | 131k             | General                 |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B        | 262k             | Code                    |
| `qwen3-next-80b`                 | Qwen3 Next 80B          | 262k             | General                 |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B           | 262k             | Vision                  |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k              | Fast, reasoning         |
| `deepseek-v3.2`                  | DeepSeek V3.2           | 163k             | Reasoning               |
| `venice-uncensored`              | Venice Uncensored       | 32k              | Uncensored              |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k             | Vision                  |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct    | 202k             | Vision                  |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B     | 131k             | General                 |
| `zai-org-glm-4.7`                | GLM 4.7                 | 202k             | Reasoning, multilingual |

### 익명화된 모델 (10) — 베니스 프록시를 통해

| Model ID                 | Original          | Context (tokens) | Features          |
| ------------------------ | ----------------- | ---------------- | ----------------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k             | Reasoning, vision |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k             | Reasoning, vision |
| `openai-gpt-52`          | GPT-5.2           | 262k             | Reasoning         |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k             | Reasoning, vision |
| `gemini-3-pro-preview`   | Gemini 3 Pro      | 202k             | Reasoning, vision |
| `gemini-3-flash-preview` | Gemini 3 Flash    | 262k             | Reasoning, vision |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k             | Reasoning, vision |
| `grok-code-fast-1`       | Grok Code Fast 1  | 262k             | Reasoning, code   |
| `kimi-k2-thinking`       | Kimi K2 Thinking  | 262k             | Reasoning         |
| `minimax-m21`            | MiniMax M2.1      | 202k             | Reasoning         |

## 모델 발견

OpenClaw는 다음과 같은 경우 Venice API에서 모델을 자동으로 검색합니다. `VENICE_API_KEY` 설정됩니다. API에 연결할 수 없으면 정적 카탈로그로 대체됩니다.

그만큼 `/models` 엔드포인트는 공개이지만(목록에 인증이 필요하지 않음) 추론에는 유효한 API 키가 필요합니다.

## 스트리밍 및 도구 지원

| Feature              | Support                                                 |
| -------------------- | ------------------------------------------------------- |
| **Streaming**        | ✅ All models                                           |
| **Function calling** | ✅ Most models (check `supportsFunctionCalling` in API) |
| **Vision/Images**    | ✅ Models marked with "Vision" feature                  |
| **JSON mode**        | ✅ Supported via `response_format`                      |

## 가격

베니스는 학점 기반 시스템을 사용합니다. 확인하다 [venice.ai/가격](https://venice.ai/pricing) 현재 요금의 경우:

- **개인 모델**: 일반적으로 비용이 저렴함
- **익명화된 모델**: 직접 API 가격과 유사 + 소액의 베니스 수수료

## 비교: 베니스와 다이렉트 API

| Aspect       | Venice (Anonymized)           | Direct API          |
| ------------ | ----------------------------- | ------------------- |
| **Privacy**  | Metadata stripped, anonymized | Your account linked |
| **Latency**  | +10-50ms (proxy)              | Direct              |
| **Features** | Most features supported       | Full features       |
| **Billing**  | Venice credits                | Provider billing    |

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

키가 다음으로 시작하는지 확인하세요. `vapi_`.

### 모델을 사용할 수 없음

베니스 모델 카탈로그는 동적으로 업데이트됩니다. 달리다 `openclaw models list` 현재 사용 가능한 모델을 보려면 일부 모델은 일시적으로 오프라인 상태일 수 있습니다.

### 연결 문제

베니스 API는 다음 위치에 있습니다. `https://api.venice.ai/api/v1`. 네트워크가 HTTPS 연결을 허용하는지 확인하세요.

## 구성 파일 예

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

## 모래밭

- [베니스 AI](https://venice.ai)
- [API 문서](https://docs.venice.ai)
- [가격](https://venice.ai/pricing)
- [상태](https://status.venice.ai)
