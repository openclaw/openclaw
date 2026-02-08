---
summary: "모델 장애 조치 설정"
read_when:
  - 모델 장애 조치를 설정할 때
title: "장애 조치"
---

# 장애 조치

모델 장애 시 자동 전환 설정입니다.

## 기본 개념

- 주 모델 오류 시 백업 모델로 전환
- API 다운타임 대응
- 비용 최적화

## 기본 설정

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
      fallback: ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4.1"],
    },
  },
}
```

## 상세 설정

```json5
{
  agents: {
    defaults: {
      failover: {
        primary: "anthropic/claude-opus-4-6",
        backups: [
          {
            model: "anthropic/claude-sonnet-4-20250514",
            maxRetries: 2,
          },
          {
            model: "openai/gpt-4.1",
            maxRetries: 3,
          },
        ],
      },
    },
  },
}
```

## 장애 조치 조건

### 오류 유형

| 오류        | 장애 조치 |
| ----------- | --------- |
| API 다운    | ✅        |
| Rate Limit  | ✅        |
| 인증 오류   | ❌        |
| 잘못된 요청 | ❌        |

### 커스텀 조건

```json5
{
  failover: {
    triggers: {
      httpCodes: [500, 502, 503, 429],
      timeout: 30,
    },
  },
}
```

## 재시도 설정

```json5
{
  agents: {
    defaults: {
      retry: {
        maxAttempts: 3,
        delay: 1000, // ms
        backoff: 2, // 지수 백오프
      },
    },
  },
}
```

## 프로바이더 장애 조치

### 프로바이더 간 전환

```json5
{
  agents: {
    defaults: {
      failover: {
        providers: ["anthropic", "openai", "google"],
      },
    },
  },
}
```

## 알림

```json5
{
  failover: {
    notify: {
      onFailover: true,
      target: {
        channel: "telegram",
        to: "123456789",
      },
    },
  },
}
```

## 수동 전환

채팅에서:

```
/model anthropic/claude-sonnet-4-20250514
```

## 상태 확인

```bash
openclaw models status
```

## 로깅

```json5
{
  logging: {
    failover: true,
  },
}
```

## 문제 해결

### 모든 모델 실패

1. 네트워크 연결 확인
2. API 키 확인
3. 모든 프로바이더 상태 확인

### 과도한 장애 조치

1. 주 모델 상태 확인
2. 재시도 설정 조정
