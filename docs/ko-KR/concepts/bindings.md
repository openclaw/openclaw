---
summary: "바인딩 및 라우팅 상세 가이드"
read_when:
  - 바인딩을 설정할 때
title: "바인딩"
---

# 바인딩

특정 발신자나 그룹을 에이전트 및 설정에 연결합니다.

## 기본 개념

바인딩은 다음을 지정합니다:

- **누가**: 발신자, 그룹, 채널
- **무엇을**: 에이전트, 설정, 권한
- **어떻게**: 특별한 규칙 적용

## 바인딩 구조

```json5
{
  bindings: [
    {
      peer: {
        kind: "dm", // dm | group
        channel: "telegram",
        sender: "123456789",
      },
      agent: "main",
      // 추가 설정...
    },
  ],
}
```

## 피어 지정

### DM (1:1 메시지)

```json5
{
  peer: {
    kind: "dm",
    channel: "telegram",
    sender: "123456789",
  },
}
```

### 그룹

```json5
{
  peer: {
    kind: "group",
    channel: "discord",
    group: "server_id/channel_id",
  },
}
```

### 와일드카드

```json5
{
  peer: {
    kind: "dm",
    channel: "telegram",
    sender: "*", // 모든 Telegram DM
  },
}
```

## 에이전트 지정

```json5
{
  bindings: [
    {
      peer: { kind: "dm", channel: "telegram", sender: "123456789" },
      agent: "coder",
    },
    {
      peer: { kind: "dm", channel: "whatsapp", sender: "*" },
      agent: "main",
    },
  ],
}
```

## 커스텀 설정

### 시스템 프롬프트

```json5
{
  peer: { ... },
  systemPrompt: "이 사용자는 한국어로만 응답받기 원합니다.",
}
```

### 모델 오버라이드

```json5
{
  peer: { ... },
  model: "anthropic/claude-opus-4-6",
  thinking: "high",
}
```

### 도구 제한

```json5
{
  peer: { ... },
  tools: {
    allow: ["read", "write"],
    deny: ["bash", "browser"],
  },
}
```

## 시간대 설정

```json5
{
  peer: { ... },
  timezone: "America/New_York",
}
```

## 우선순위

더 구체적인 바인딩이 우선:

1. 정확한 발신자 ID
2. 채널별 와일드카드
3. 전역 기본값

## 그룹 설정

```json5
{
  bindings: [
    {
      peer: {
        kind: "group",
        channel: "telegram",
        group: "-123456789",
      },
      requireMention: true,
      agent: "quick",
    },
  ],
}
```

## 동적 바인딩

### CLI에서

```bash
# 바인딩 추가
openclaw bindings add --peer telegram:dm:123456789 --agent coder

# 바인딩 제거
openclaw bindings remove --peer telegram:dm:123456789

# 목록
openclaw bindings list
```

## 디버깅

```bash
# 특정 피어의 바인딩 확인
openclaw bindings resolve telegram:dm:123456789
```

## 예시

### 개발자 친구

```json5
{
  peer: { kind: "dm", channel: "telegram", sender: "dev_friend_id" },
  agent: "coder",
  systemPrompt: "이 사용자는 시니어 개발자입니다.",
  tools: { bash: true, browser: true },
}
```

### 가족

```json5
{
  peer: { kind: "dm", channel: "whatsapp", sender: "family_id" },
  agent: "quick",
  systemPrompt: "간단하고 친근하게 응답하세요.",
  tools: { bash: false, browser: true },
}
```
