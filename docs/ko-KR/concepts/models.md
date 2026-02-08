---
summary: "AI 모델 선택, Provider 설정, 로컬 모델"
read_when:
  - 모델을 변경하고 싶을 때
title: "모델"
---

# 모델

OpenClaw는 다양한 AI 모델 provider를 지원합니다.

## 지원 Provider

| Provider       | 모델 예시                        | 설정 키            |
| -------------- | -------------------------------- | ------------------ |
| **Anthropic**  | Claude Opus 4.6, Claude Sonnet 4 | `anthropicApiKey`  |
| **OpenAI**     | GPT-4.1, GPT-4.1-mini            | `openaiApiKey`     |
| **Google**     | Gemini 2.5 Pro, Gemini 2.5 Flash | `googleApiKey`     |
| **OpenRouter** | 다양한 모델                      | `openrouterApiKey` |
| **Local**      | Ollama, LM Studio 등             | 별도 설정          |

## 모델 설정

### 기본 모델

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
    },
  },
}
```

### 에이전트별 모델

```json5
{
  agents: {
    list: [
      {
        id: "main",
        model: "anthropic/claude-opus-4-6",
      },
      {
        id: "quick",
        model: "anthropic/claude-sonnet-4-20250514",
      },
      {
        id: "budget",
        model: "openai/gpt-4.1-mini",
      },
    ],
  },
}
```

## API 키 설정

### 환경변수 (권장)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GOOGLE_AI_API_KEY=...
export OPENROUTER_API_KEY=...
```

### 설정 파일

```json5
{
  agents: {
    defaults: {
      anthropicApiKey: "sk-ant-...",
      openaiApiKey: "sk-...",
    },
  },
}
```

## 런타임 모델 변경

채팅에서:

```
/model anthropic/claude-sonnet-4-20250514
/model openai/gpt-4.1
/model google/gemini-2.5-flash
```

## 모델 페일오버

주 모델 실패 시 대체 모델로 자동 전환:

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
      modelFailover: ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4.1"],
    },
  },
}
```

### 페일오버 조건

```json5
{
  agents: {
    defaults: {
      modelFailover: {
        models: ["anthropic/claude-sonnet-4-20250514"],
        on: ["rate_limit", "server_error", "timeout"],
        maxRetries: 3,
      },
    },
  },
}
```

## 로컬 모델

### Ollama

```json5
{
  agents: {
    defaults: {
      model: "ollama/llama3.2",
      ollamaBaseUrl: "http://localhost:11434",
    },
  },
}
```

### LM Studio

```json5
{
  agents: {
    defaults: {
      model: "lmstudio/local-model",
      lmstudioBaseUrl: "http://localhost:1234/v1",
    },
  },
}
```

### OpenAI 호환 API

```json5
{
  agents: {
    defaults: {
      model: "openai-compatible/model-name",
      openaiBaseUrl: "http://localhost:8080/v1",
      openaiApiKey: "not-needed", // 로컬은 보통 불필요
    },
  },
}
```

## 모델 매개변수

### 온도 (Temperature)

```json5
{
  agents: {
    defaults: {
      temperature: 0.7, // 0.0 ~ 1.0
    },
  },
}
```

### 최대 토큰

```json5
{
  agents: {
    defaults: {
      maxTokens: 16384,
    },
  },
}
```

### Top-P

```json5
{
  agents: {
    defaults: {
      topP: 0.9,
    },
  },
}
```

## 사용량 추적

### 사용량 표시

채팅에서:

```
/usage tokens   # 토큰만 표시
/usage full     # 전체 표시
/usage off      # 비활성화
```

### 현재 상태

```
/status
```

## 권장 모델

| 용도            | 권장 모델                       |
| --------------- | ------------------------------- |
| **일반 코딩**   | Claude Opus 4.6, GPT-4.1        |
| **빠른 응답**   | Claude Sonnet 4, GPT-4.1-mini   |
| **복잡한 추론** | Claude Opus 4.6 (high thinking) |
| **비용 절약**   | GPT-4.1-mini, Gemini Flash      |
| **프라이버시**  | Ollama (로컬)                   |

## 문제 해결

### API 키 오류

```
Error: Invalid API key
```

1. 키가 올바른지 확인
2. 환경변수가 설정되어 있는지 확인
3. Gateway 재시작

### Rate Limit

```
Error: Rate limit exceeded
```

1. 잠시 대기 후 재시도
2. 페일오버 모델 설정
3. API 할당량 확인

### 모델을 찾을 수 없음

```
Error: Model not found
```

1. 모델 이름 철자 확인
2. Provider가 활성화되어 있는지 확인
3. 해당 모델에 접근 권한이 있는지 확인
