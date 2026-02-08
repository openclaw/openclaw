---
summary: "지원되는 모든 AI 모델 프로바이더와 커스텀 프로바이더 설정 방법"
read_when:
  - 다양한 AI 모델을 사용하고 싶을 때
  - 커스텀 프로바이더를 추가하고 싶을 때
title: "모델 프로바이더"
---

# 모델 프로바이더

OpenClaw는 다양한 AI 모델 프로바이더를 지원합니다. 빌트인 프로바이더부터 커스텀 엔드포인트까지, 필요에 맞는 모델을 선택할 수 있습니다.

## 빌트인 프로바이더

### Anthropic

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
    },
  },
}
```

**지원 모델:**
- `anthropic/claude-opus-4-6` — 최고 성능
- `anthropic/claude-sonnet-4-20250514` — 균형 잡힌 성능
- `anthropic/claude-haiku-3-5-20241022` — 빠른 응답

**인증 방식:**
- API 키: `ANTHROPIC_API_KEY` 환경변수
- OAuth: `claude setup-token` → `openclaw models auth setup-token`
- Claude Pro/Max 구독 사용 가능

### OpenAI

```json5
{
  agents: {
    defaults: {
      model: "openai/gpt-4.1",
    },
  },
}
```

**지원 모델:**
- `openai/gpt-4.1` — 최신 GPT-4.1
- `openai/gpt-4.1-mini` — 경량 버전
- `openai/o3` — 추론 모델
- `openai/o4-mini` — 경량 추론

**인증 방식:**
- API 키: `OPENAI_API_KEY` 환경변수
- Codex CLI OAuth: `openclaw models auth openai-codex`

### Google Gemini

```json5
{
  agents: {
    defaults: {
      model: "google/gemini-2.5-pro",
    },
  },
}
```

**지원 모델:**
- `google/gemini-2.5-pro` — 고성능
- `google/gemini-2.5-flash` — 빠른 응답

**인증 방식:**
- API 키: `GOOGLE_AI_API_KEY` 또는 `GEMINI_API_KEY`
- Gemini CLI OAuth

### xAI (Grok)

```json5
{
  agents: {
    defaults: {
      model: "xai/grok-3",
    },
  },
}
```

**인증:** `XAI_API_KEY` 환경변수

### Groq

```json5
{
  agents: {
    defaults: {
      model: "groq/llama-4-scout-17b-16e-instruct",
    },
  },
}
```

**인증:** `GROQ_API_KEY` 환경변수

### Mistral

```json5
{
  agents: {
    defaults: {
      model: "mistral/mistral-large-latest",
    },
  },
}
```

**인증:** `MISTRAL_API_KEY` 환경변수

### GitHub Copilot

GitHub Copilot 구독을 통해 AI 모델에 접근합니다.

**인증:** `openclaw models auth github-copilot` (OAuth 흐름)

## 커스텀 프로바이더

`models.providers` 설정으로 OpenAI 호환 엔드포인트를 커스텀 프로바이더로 등록할 수 있습니다.

### 기본 구조

```json5
{
  models: {
    providers: [
      {
        id: "my-provider",
        label: "My Custom Provider",
        baseUrl: "https://api.example.com/v1",
        apiKey: "${MY_PROVIDER_API_KEY}",
        models: [
          { id: "my-model-v1", label: "My Model V1" },
        ],
      },
    ],
  },
}
```

### Ollama (로컬 모델)

```json5
{
  models: {
    providers: [
      {
        id: "ollama",
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        models: [
          { id: "llama3.1:70b", label: "Llama 3.1 70B" },
          { id: "codellama:34b", label: "Code Llama 34B" },
          { id: "qwen2.5:72b", label: "Qwen 2.5 72B" },
        ],
      },
    ],
  },
}
```

사용:

```
/model ollama/llama3.1:70b
```

### LM Studio

```json5
{
  models: {
    providers: [
      {
        id: "lmstudio",
        label: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
        models: [
          { id: "loaded-model", label: "LM Studio Model" },
        ],
      },
    ],
  },
}
```

### vLLM

```json5
{
  models: {
    providers: [
      {
        id: "vllm",
        label: "vLLM",
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "none",
        models: [
          { id: "meta-llama/Llama-3.1-70B-Instruct", label: "Llama 3.1 70B" },
        ],
      },
    ],
  },
}
```

### Moonshot AI / Kimi

```json5
{
  models: {
    providers: [
      {
        id: "moonshot",
        label: "Moonshot AI",
        baseUrl: "https://api.moonshot.cn/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        models: [
          { id: "moonshot-v1-128k", label: "Moonshot V1 128K" },
        ],
      },
    ],
  },
}
```

### Qwen (통의천문)

```json5
{
  models: {
    providers: [
      {
        id: "qwen",
        label: "Qwen",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey: "${DASHSCOPE_API_KEY}",
        models: [
          { id: "qwen-max", label: "Qwen Max" },
        ],
      },
    ],
  },
}
```

## 모델 참조 형식

모델은 `프로바이더/모델` 형식으로 참조합니다:

```
anthropic/claude-opus-4-6
openai/gpt-4.1
google/gemini-2.5-pro
ollama/llama3.1:70b
```

## CLI 관리 명령어

```bash
# 사용 가능한 모델 목록
openclaw models list

# 기본 모델 설정
openclaw models set anthropic/claude-opus-4-6

# 인증 프로필 관리
openclaw models auth setup-token        # Anthropic 구독 토큰
openclaw models auth github-copilot     # GitHub Copilot OAuth
openclaw models auth openai-codex       # OpenAI Codex OAuth

# 인증 프로필 순서 변경
openclaw models auth order

# 온보딩으로 전체 설정
openclaw onboard
```

## 런타임 모델 전환

채팅에서 `/model` 명령어로 즉시 전환:

```
/model                          # 모델 선택 피커 표시
/model anthropic/claude-sonnet-4-20250514  # 특정 모델로 전환
/model ollama/llama3.1:70b      # 커스텀 프로바이더 모델
```

전환된 모델은 현재 세션에만 적용됩니다.

## 폴백 설정

모든 인증 프로필이 실패할 경우의 폴백 모델을 설정할 수 있습니다:

```json5
{
  agents: {
    defaults: {
      model: {
        default: "anthropic/claude-opus-4-6",
        fallbacks: [
          "anthropic/claude-sonnet-4-20250514",
          "openai/gpt-4.1",
        ],
      },
    },
  },
}
```

자세한 폴백 동작은 [모델 장애 조치](/ko-KR/concepts/model-failover) 참조.

## 다음 단계

- [모델 장애 조치](/ko-KR/concepts/model-failover) - 인증 프로필 회전과 모델 폴백
- [OAuth 인증](/ko-KR/concepts/oauth) - OAuth 토큰 관리
- [에이전트 설정](/ko-KR/concepts/agent) - 에이전트별 모델 설정
