---
summary: "성능 최적화 가이드"
read_when:
  - 성능을 최적화할 때
title: "성능"
---

# 성능 최적화

OpenClaw 성능을 최적화하는 방법입니다.

## 응답 속도

### 모델 선택

| 모델          | 속도 | 품질 |
| ------------- | ---- | ---- |
| Claude Sonnet | 빠름 | 좋음 |
| Claude Opus   | 느림 | 최상 |
| GPT-4.1-mini  | 빠름 | 좋음 |
| GPT-4.1       | 중간 | 좋음 |

빠른 응답이 필요하면:

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-sonnet-4-20250514",
    },
  },
}
```

### 사고 레벨

사고 레벨 낮추기:

```json5
{
  agents: {
    defaults: {
      thinking: "low", // off | minimal | low | medium | high
    },
  },
}
```

### 컨텍스트 압축

```json5
{
  agents: {
    defaults: {
      compaction: {
        auto: true,
        threshold: 50000,
      },
      historyLimit: 30,
    },
  },
}
```

## 메모리 사용량

### 세션 제한

```json5
{
  agents: {
    defaults: {
      sessions: {
        pruneAfter: "7d",
        maxSessions: 100,
      },
    },
  },
}
```

### 미디어 캐시

```json5
{
  media: {
    cache: {
      maxSize: "500mb",
      retention: "7d",
    },
  },
}
```

### 로그 정리

```json5
{
  logging: {
    retention: {
      days: 7,
      maxSize: "100mb",
    },
  },
}
```

## 네트워크

### 스트리밍

지원 채널에서 스트리밍 활성화:

```json5
{
  channels: {
    telegram: {
      streamMode: "partial",
    },
  },
}
```

### 연결 유지

```json5
{
  gateway: {
    keepAlive: {
      interval: 30,
      timeout: 60,
    },
  },
}
```

## 동시성

### 동시 요청 제한

```json5
{
  agents: {
    defaults: {
      maxConcurrent: 5,
    },
  },
}
```

### 큐 설정

```json5
{
  agents: {
    defaults: {
      queue: {
        maxSize: 20,
        timeout: 120,
      },
    },
  },
}
```

## 브라우저

### 리소스 절약

```json5
{
  browser: {
    enabled: true,
    headless: true,
    maxInstances: 2,
    timeout: 30000,
    closeAfterIdle: 60,
  },
}
```

### 비활성화

필요 없으면 비활성화:

```json5
{
  browser: {
    enabled: false,
  },
}
```

## 저사양 장치

### Raspberry Pi 최적화

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-sonnet-4-20250514", // 빠른 모델
      thinking: "minimal",
      historyLimit: 20,
      compaction: { auto: true, threshold: 30000 },
    },
  },
  browser: { enabled: false },
  media: { cache: { maxSize: "200mb" } },
}
```

## 모니터링

### 성능 로깅

```json5
{
  logging: {
    performance: true,
  },
}
```

### 메트릭

```bash
# 상태 확인
openclaw gateway status --metrics
```

## 문제 해결

### 느린 응답

1. 모델/사고 레벨 확인
2. 컨텍스트 크기 확인 (`/compact`)
3. 네트워크 지연 확인

### 높은 메모리

1. 세션 정리
2. 미디어 캐시 정리
3. 브라우저 인스턴스 확인
