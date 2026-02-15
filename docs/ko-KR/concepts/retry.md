---
summary: "Retry policy for outbound provider calls"
read_when:
  - Updating provider retry behavior or defaults
  - Debugging provider send errors or rate limits
title: "Retry Policy"
x-i18n:
  source_hash: 55bb261ff567f46ce447be9c0ee0c5b5e6d2776287d7662762656c14108dd607
---

# 재시도 정책

## 목표

- 다단계 흐름이 아닌 HTTP 요청별로 재시도합니다.
- 현재 단계만 다시 시도하여 순서를 유지합니다.
- 멱등성이 아닌 작업을 중복하지 마세요.

## 기본값

- 시도 횟수: 3
- 최대 지연 한도: 30000ms
- 지터: 0.1(10%)
- 공급자 기본값:
  - 텔레그램 최소 지연: 400ms
  - Discord 최소 지연: 500ms

## 행동

### 불화

- 속도 제한 오류(HTTP 429)에서만 재시도합니다.
- 가능한 경우 Discord `retry_after`를 사용하고, 그렇지 않은 경우 지수 백오프를 사용합니다.

### 텔레그램

- 일시적인 오류(429, 시간 초과, 연결/재설정/닫기, 일시적으로 사용할 수 없음)에 대해 재시도합니다.
- 사용 가능한 경우 `retry_after`를 사용하고, 그렇지 않으면 지수 백오프를 사용합니다.
- 마크다운 구문 분석 오류는 재시도되지 않습니다. 일반 텍스트로 돌아갑니다.

## 구성

`~/.openclaw/openclaw.json`에서 공급자별 재시도 정책을 설정합니다.

```json5
{
  channels: {
    telegram: {
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
    discord: {
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

## 메모

- 요청별로 재시도가 적용됩니다(메시지 전송, 미디어 업로드, 반응, 투표, 스티커).
- 복합 흐름은 완료된 단계를 다시 시도하지 않습니다.
