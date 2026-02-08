---
summary: "사용량 추적 및 비용 관리"
read_when:
  - 사용량을 확인할 때
title: "사용량"
---

# 사용량

API 사용량 추적 및 비용 관리 가이드입니다.

## 사용량 표시

### 채팅에서

```
/usage on
/usage tokens
/usage full
/usage off
```

### 응답에 표시

```
[응답 내용]

📊 토큰: 1,234 (입력: 800, 출력: 434)
💰 비용: $0.0012
```

## 설정

### 기본 설정

```json5
{
  usage: {
    display: "tokens", // off | tokens | full
    showCost: true,
  },
}
```

## 토큰 추적

### 세션별

```bash
openclaw sessions usage <session-key>
```

### 전체

```bash
openclaw usage summary
openclaw usage summary --period 30d
```

## 비용 계산

### 모델별 가격

| 모델          | 입력    | 출력   |
| ------------- | ------- | ------ |
| Claude Opus   | $15/M   | $75/M  |
| Claude Sonnet | $3/M    | $15/M  |
| GPT-4.1       | $2/M    | $10/M  |
| GPT-4.1-mini  | $0.15/M | $0.6/M |

### 비용 로깅

```json5
{
  usage: {
    log: true,
    logPath: "~/.openclaw/usage/",
  },
}
```

## 예산 제한

### 일일 한도

```json5
{
  usage: {
    limits: {
      daily: {
        cost: 10.0, // USD
        action: "warn", // warn | block
      },
    },
  },
}
```

### 월간 한도

```json5
{
  usage: {
    limits: {
      monthly: {
        cost: 100.0,
        action: "warn",
      },
    },
  },
}
```

### 세션별 한도

```json5
{
  agents: {
    defaults: {
      usage: {
        maxTokensPerSession: 100000,
      },
    },
  },
}
```

## 알림

### 한도 도달 시

```json5
{
  usage: {
    alerts: {
      at: [50, 80, 100], // 퍼센트
      target: {
        channel: "telegram",
        to: "123456789",
      },
    },
  },
}
```

## 리포트

### CLI

```bash
# 일간 리포트
openclaw usage report --daily

# 월간 리포트
openclaw usage report --monthly

# CSV 내보내기
openclaw usage report --format csv > usage.csv
```

### 자동 리포트

```json5
{
  usage: {
    reports: {
      weekly: {
        enabled: true,
        target: { channel: "telegram", to: "123456789" },
      },
    },
  },
}
```

## 최적화 팁

### 비용 절감

1. 가벼운 모델 사용 (Sonnet, mini)
2. 사고 레벨 낮추기
3. 컨텍스트 압축 활성화
4. 히스토리 제한

### 효율성

```json5
{
  agents: {
    defaults: {
      compaction: { auto: true, threshold: 50000 },
      historyLimit: 30,
    },
  },
}
```

## 문제 해결

### 사용량 표시 안 됨

1. `/usage on` 확인
2. 설정 확인

### 비용 계산 오류

1. 모델 가격 업데이트 확인
2. 로그 확인
