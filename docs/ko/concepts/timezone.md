---
read_when:
    - 모델에 대해 타임스탬프가 정규화되는 방식을 이해해야 합니다.
    - 시스템 프롬프트에 대한 사용자 시간대 구성
summary: 상담원, 봉투 및 프롬프트에 대한 시간대 처리
title: 시간대
x-i18n:
    generated_at: "2026-02-08T15:56:47Z"
    model: gtx
    provider: google-translate
    source_hash: 9ee809c96897db1126c7efcaa5bf48a63cdcb2092abd4b3205af224ebd882766
    source_path: concepts/timezone.md
    workflow: 15
---

# 시간대

OpenClaw는 타임스탬프를 표준화하여 모델이 **단일 참조 시간**.

## 메시지 봉투(기본적으로 로컬)

인바운드 메시지는 다음과 같은 봉투에 포장됩니다.

```
[Provider ... 2026-01-05 16:26 PST] message text
```

봉투에 있는 타임스탬프는 다음과 같습니다. **기본적으로 호스트-로컬**, 몇 분 정도의 정밀도로.

다음을 사용하여 이를 재정의할 수 있습니다.

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` UTC를 사용합니다.
- `envelopeTimezone: "user"` 용도 `agents.defaults.userTimezone` (호스트 시간대로 대체)
- 명시적인 IANA 시간대를 사용하세요(예: `"Europe/Vienna"`) 고정 오프셋의 경우.
- `envelopeTimestamp: "off"` 봉투 헤더에서 절대 타임스탬프를 제거합니다.
- `envelopeElapsed: "off"` 경과 시간 접미사를 제거합니다( `+2m` 스타일).

### 예

**로컬(기본값):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**고정 시간대:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**경과 시간:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## 도구 페이로드(원시 공급자 데이터 + 정규화된 필드)

도구 호출(`channels.discord.readMessages`, `channels.slack.readMessages`등) 반환 **원시 공급자 타임스탬프**.
일관성을 위해 정규화된 필드도 첨부합니다.

- `timestampMs` (UTC 에포크 밀리초)
- `timestampUtc` (ISO 8601 UTC 문자열)

원시 공급자 필드는 유지됩니다.

## 시스템 프롬프트의 사용자 시간대

세트 `agents.defaults.userTimezone` 모델에 사용자의 현지 시간대를 알려줍니다. 그렇다면
설정하지 않으면 OpenClaw가 다음 문제를 해결합니다. **런타임 시 호스트 시간대** (구성 쓰기 없음)

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

시스템 프롬프트에는 다음이 포함됩니다.

- `Current Date & Time` 현지 시간 및 시간대가 포함된 섹션
- `Time format: 12-hour` 또는 `24-hour`

다음을 사용하여 프롬프트 형식을 제어할 수 있습니다. `agents.defaults.timeFormat` (`auto` | `12` | `24`).

보다 [날짜 및 시간](/date-time) 전체 동작과 예제를 보려면.
