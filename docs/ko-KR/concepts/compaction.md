---
summary: "컴팩션 및 히스토리 관리"
read_when:
  - 컨텍스트를 압축할 때
title: "컴팩션"
---

# 컴팩션

컨텍스트 압축 및 히스토리 관리 가이드입니다.

## 컴팩션이란?

- 대화 히스토리를 요약하여 압축
- 토큰 사용량 감소
- 컨텍스트 창 관리

## 수동 컴팩션

채팅에서:

```
/compact
```

## 자동 컴팩션

### 설정

```json5
{
  agents: {
    defaults: {
      compaction: {
        auto: true,
        threshold: 50000, // 토큰
      },
    },
  },
}
```

### 트리거 조건

자동 컴팩션 발생 시점:

- 토큰 임계값 도달
- 컨텍스트 창 90% 사용
- 수동 요청

## 컴팩션 방식

### summary (기본값)

대화를 요약:

```json5
{
  compaction: {
    method: "summary",
  },
}
```

### prune

오래된 메시지 제거:

```json5
{
  compaction: {
    method: "prune",
    keepRecent: 20,
  },
}
```

### hybrid

요약 + 중요 메시지 유지:

```json5
{
  compaction: {
    method: "hybrid",
    keepRecent: 10,
    summaryOlder: true,
  },
}
```

## 히스토리 제한

### 메시지 수

```json5
{
  agents: {
    defaults: {
      historyLimit: 50,
    },
  },
}
```

### 토큰 수

```json5
{
  agents: {
    defaults: {
      maxContextTokens: 100000,
    },
  },
}
```

## 요약 품질

### 상세 수준

```json5
{
  compaction: {
    summary: {
      detail: "high", // low | medium | high
    },
  },
}
```

## 중요 메시지 유지

### 고정 메시지

```json5
{
  compaction: {
    preserve: {
      pinned: true,
      codeBlocks: true,
      toolResults: true,
    },
  },
}
```

## 상태 확인

채팅에서:

```
/debug session
```

출력:

```
세션: agent:main:telegram:dm:123
토큰: 45,000 / 128,000
메시지: 42
마지막 컴팩션: 12시간 전
```

## 로깅

```json5
{
  logging: {
    compaction: true,
  },
}
```

## 문제 해결

### 정보 손실

1. 컴팩션 상세 수준 높이기
2. 중요 메시지 고정
3. 히스토리 제한 늘리기

### 느린 컴팩션

1. 요약 상세 수준 낮추기
2. prune 방식 사용
