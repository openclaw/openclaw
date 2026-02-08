---
read_when:
    - 공급자 재시도 동작 또는 기본값 업데이트
    - 디버깅 공급자가 오류 또는 속도 제한을 보냅니다.
summary: 아웃바운드 공급자 호출에 대한 재시도 정책
title: 재시도 정책
x-i18n:
    generated_at: "2026-02-08T15:51:37Z"
    model: gtx
    provider: google-translate
    source_hash: 55bb261ff567f46ce447be9c0ee0c5b5e6d2776287d7662762656c14108dd607
    source_path: concepts/retry.md
    workflow: 15
---

# 재시도 정책

## 목표

- 다단계 흐름이 아닌 HTTP 요청별로 재시도합니다.
- 현재 단계만 다시 시도하여 순서를 유지합니다.
- 멱등성이 아닌 작업을 복제하지 마세요.

## 기본값

- 시도 횟수: 3
- 최대 지연 한도: 30000ms
- 지터: 0.1(10%)
- 공급자 기본값:
  - 텔레그램 최소 지연: 400ms
  - Discord 최소 지연: 500ms

## 행동

### 불화

- 비율 제한 오류(HTTP 429)에 대해서만 재시도합니다.
- 불일치를 사용합니다 `retry_after` 사용 가능한 경우, 그렇지 않은 경우 지수 백오프.

### 전보

- 일시적인 오류(429, 시간 초과, 연결/재설정/닫기, 일시적으로 사용할 수 없음)에 대해 재시도합니다.
- 용도 `retry_after` 사용 가능한 경우, 그렇지 않은 경우 지수 백오프.
- 마크다운 구문 분석 오류는 재시도되지 않습니다. 일반 텍스트로 돌아갑니다.

## 구성

공급자별 재시도 정책 설정 `~/.openclaw/openclaw.json`:

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

- 요청별로 재시도가 적용됩니다(메시지 전송, 미디어 업로드, 반응, 설문조사, 스티커).
- 복합 흐름은 완료된 단계를 재시도하지 않습니다.
