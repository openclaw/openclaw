---
summary: "에이전트 설정, 모델 선택, 프롬프트 커스터마이징"
read_when:
  - 에이전트 동작을 커스터마이징할 때
title: "에이전트"
---

# 에이전트

에이전트는 OpenClaw의 핵심입니다. AI 모델과 상호작용하고 사용자 요청을 처리합니다.

## 에이전트 설정

### 기본 설정

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
      maxTokens: 16384,
    },
  },
}
```

### 다중 에이전트

```json5
{
  agents: {
    list: [
      {
        id: "main",
        model: "anthropic/claude-opus-4-6",
      },
      {
        id: "coder",
        model: "anthropic/claude-opus-4-6",
        workspace: "~/projects",
      },
      {
        id: "quick",
        model: "anthropic/claude-sonnet-4-20250514", // 빠른 응답용
      },
    ],
  },
}
```

### 에이전트 바인딩

특정 발신자를 특정 에이전트로 라우팅:

```json5
{
  bindings: [
    {
      peer: { kind: "dm", channel: "telegram", sender: "123456789" },
      agent: "coder",
    },
    {
      peer: { kind: "group", channel: "discord", group: "987654321" },
      agent: "quick",
    },
  ],
}
```

## 모델 선택

### 지원 모델

| Provider   | 모델 예시                                                         |
| ---------- | ----------------------------------------------------------------- |
| Anthropic  | `anthropic/claude-opus-4-6`, `anthropic/claude-sonnet-4-20250514` |
| OpenAI     | `openai/gpt-4.1`, `openai/gpt-4.1-mini`                           |
| Google     | `google/gemini-2.5-pro`, `google/gemini-2.5-flash`                |
| OpenRouter | `openrouter/...`                                                  |

### 모델 설정

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
    },
  },
}
```

### 런타임 모델 변경

채팅에서:

```
/model anthropic/claude-sonnet-4-20250514
```

## API 키 설정

### 환경변수

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GOOGLE_AI_API_KEY=...
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

## 워크스페이스

에이전트가 작업하는 디렉토리입니다.

### 기본 워크스페이스

```
~/.openclaw/workspace/
├── AGENTS.md         # 에이전트 지침
├── SOUL.md           # 성격 정의
├── TOOLS.md          # 도구 사용 지침
├── HEARTBEAT.md      # 하트비트 지침
└── skills/           # 커스텀 스킬
```

### 커스텀 워크스페이스

```json5
{
  agents: {
    list: [
      {
        id: "project-a",
        workspace: "~/projects/project-a",
      },
    ],
  },
}
```

## 프롬프트 커스터마이징

### AGENTS.md

에이전트에게 전역 지침을 제공:

```markdown
# 에이전트 지침

## 역할

당신은 개발 보조 AI입니다.

## 규칙

- 항상 한국어로 응답하세요
- 코드 변경 전 확인을 요청하세요
- 민감한 정보를 노출하지 마세요
```

### SOUL.md

에이전트 성격을 정의:

```markdown
# 성격

- 친절하고 도움이 되는 어조 사용
- 기술적 설명은 간결하게
- 유머를 적절히 사용
```

### TOOLS.md

도구 사용 지침:

```markdown
# 도구 사용 지침

## bash

- 위험한 명령어 실행 전 확인
- 프로덕션 환경에서 주의

## browser

- 로그인이 필요한 사이트 주의
- 스크린샷 촬영 시 민감 정보 확인
```

## 사고 모드 (Thinking)

에이전트의 사고 과정을 제어합니다.

### 사고 레벨

| 레벨      | 설명      | 예산  |
| --------- | --------- | ----- |
| `off`     | 사고 없음 | 0     |
| `minimal` | 최소 사고 | 1024  |
| `low`     | 낮은 사고 | 4096  |
| `medium`  | 중간 사고 | 10240 |
| `high`    | 높은 사고 | 32768 |
| `xhigh`   | 최고 사고 | 65536 |

### 사고 레벨 설정

```json5
{
  agents: {
    defaults: {
      thinking: "medium",
    },
  },
}
```

채팅에서:

```
/think high
```

## 세션

### 세션 범위

```json5
{
  agents: {
    defaults: {
      sessions: {
        scope: "per-sender", // per-sender | per-channel
      },
    },
  },
}
```

### 히스토리 제한

```json5
{
  agents: {
    defaults: {
      historyLimit: 50,
    },
  },
}
```

### 컨텍스트 압축

컨텍스트가 너무 길어지면:

```
/compact
```

## 동시성

### 최대 동시 요청

```json5
{
  agents: {
    defaults: {
      maxConcurrent: 3,
    },
  },
}
```

### 요청당 시간 제한

```json5
{
  agents: {
    defaults: {
      timeout: 300, // 초
    },
  },
}
```

## 문제 해결

### 모델 오류

1. API 키 확인
2. 모델 이름 철자 확인
3. API 할당량 확인

### 느린 응답

1. `/compact`로 컨텍스트 줄이기
2. 더 빠른 모델 사용 (Sonnet, GPT-4.1-mini)
3. 사고 레벨 낮추기

### 이상한 응답

1. `/reset`으로 세션 초기화
2. 프롬프트(AGENTS.md) 검토
3. 모델 변경 시도
