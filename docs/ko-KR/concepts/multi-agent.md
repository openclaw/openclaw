---
summary: "멀티 에이전트 설정, 라우팅, 서브에이전트"
read_when:
  - 여러 에이전트를 사용하고 싶을 때
title: "멀티 에이전트"
---

# 멀티 에이전트

OpenClaw는 여러 에이전트를 동시에 운영하고 라우팅할 수 있습니다.

## 멀티 에이전트 개념

### 에이전트 정의

각 에이전트는 고유한 설정을 가집니다:

- 모델
- 워크스페이스
- 도구 권한
- 메모리

### 사용 사례

- **코딩 에이전트**: 개발 작업 전용
- **빠른 에이전트**: 간단한 질문 응답
- **보안 에이전트**: 제한된 권한

## 에이전트 설정

### 여러 에이전트 정의

```json5
{
  agents: {
    list: [
      {
        id: "main",
        model: "anthropic/claude-opus-4-6",
        workspace: "~/.openclaw/workspace",
      },
      {
        id: "coder",
        model: "anthropic/claude-opus-4-6",
        workspace: "~/projects",
        tools: {
          browser: false, // 브라우저 비활성화
        },
      },
      {
        id: "quick",
        model: "anthropic/claude-sonnet-4-20250514",
        tools: {
          bash: false,
          write: false,
        },
      },
    ],
  },
}
```

## 에이전트 라우팅

### 발신자별 라우팅

특정 발신자를 특정 에이전트로:

```json5
{
  bindings: [
    {
      peer: {
        kind: "dm",
        channel: "telegram",
        sender: "123456789",
      },
      agent: "coder",
    },
  ],
}
```

### 그룹별 라우팅

```json5
{
  bindings: [
    {
      peer: {
        kind: "group",
        channel: "discord",
        group: "987654321",
      },
      agent: "quick",
    },
  ],
}
```

### 채널별 라우팅

```json5
{
  bindings: [
    {
      peer: {
        kind: "dm",
        channel: "whatsapp",
      },
      agent: "main",
    },
    {
      peer: {
        kind: "dm",
        channel: "telegram",
      },
      agent: "coder",
    },
  ],
}
```

## 서브에이전트

에이전트가 다른 에이전트에게 작업을 위임합니다.

### 서브에이전트 호출

에이전트는 `dispatch` 도구를 사용:

```
dispatch(agentId: "coder", task: "이 코드를 리팩토링해줘")
```

### 서브에이전트 설정

```json5
{
  agents: {
    defaults: {
      subagents: {
        enabled: true,
        allowed: ["coder", "quick"],
      },
    },
  },
}
```

### 서브에이전트 권한

```json5
{
  agents: {
    list: [
      {
        id: "main",
        subagents: {
          enabled: true,
          allowed: ["coder"],
        },
      },
      {
        id: "coder",
        subagents: {
          enabled: false, // 서브에이전트 호출 불가
        },
      },
    ],
  },
}
```

## 세션 격리

### 에이전트별 세션

각 에이전트는 독립된 세션을 가집니다:

```
agent:main:telegram:dm:123456789
agent:coder:telegram:dm:123456789
```

### 세션 공유

특정 에이전트 간 세션 공유:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        sessions: {
          shareWith: ["coder"],
        },
      },
    ],
  },
}
```

## 에이전트 전환

### 채팅에서 전환

```
/agent coder
/agent main
```

### 자동 전환

특정 키워드로 자동 전환:

```json5
{
  agents: {
    routing: {
      keywords: {
        코드: "coder",
        빠르게: "quick",
      },
    },
  },
}
```

## 워크스페이스 격리

### 에이전트별 워크스페이스

```json5
{
  agents: {
    list: [
      {
        id: "main",
        workspace: "~/.openclaw/workspace",
      },
      {
        id: "project-a",
        workspace: "~/projects/project-a",
      },
      {
        id: "project-b",
        workspace: "~/projects/project-b",
      },
    ],
  },
}
```

## 도구 권한

### 에이전트별 도구 제한

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          bash: true,
          browser: true,
          write: true,
        },
      },
      {
        id: "readonly",
        tools: {
          bash: false,
          browser: true,
          write: false,
          read: true,
        },
      },
    ],
  },
}
```

## 모니터링

### 에이전트별 세션 확인

```bash
# 모든 세션
openclaw sessions list

# 특정 에이전트 세션만
openclaw sessions list --agent coder
```

### 에이전트 상태

```bash
openclaw agents status
```

## 베스트 프랙티스

1. **용도별 분리**: 코딩, 질문답변, 자동화 등 용도별 에이전트
2. **권한 최소화**: 필요한 도구만 활성화
3. **워크스페이스 격리**: 프로젝트별 워크스페이스 분리
4. **페일오버 설정**: 주 에이전트 실패 시 대체 에이전트
