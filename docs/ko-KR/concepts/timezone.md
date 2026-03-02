---
summary: "에이전트, envelopes, 프롬프트에 대한 Timezone 처리"
read_when:
  - 타임스탬프가 모델에 대해 정규화되는 방법을 이해해야 할 때
  - 시스템 프롬프트에 대한 사용자 timezone을 설정할 때
title: "시간대"
---

# 시간대

OpenClaw는 타임스탐프를 정규화하여 모델이 **단일 참조 시간**을 봅니다.

## 메시지 envelopes (기본적으로 local)

인바운드 메시지는 다음과 같은 envelope로 래핑됩니다:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Envelope의 타임스탬프는 **host-local by default**이며, 분 정밀도입니다.

다음으로 이를 재정의할 수 있습니다:

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

- `envelopeTimezone: "utc"`는 UTC를 사용합니다.
- `envelopeTimezone: "user"`는 `agents.defaults.userTimezone`을 사용합니다 (host timezone으로 fallback).
- explicit IANA timezone (예: `"Europe/Vienna"`)을 fixed offset에 사용합니다.
- `envelopeTimestamp: "off"`는 envelope headers에서 절대 타임스탤프를 제거합니다.
- `envelopeElapsed: "off"`는 elapsed time 접미사를 제거합니다 (the `+2m` style).

### 예시

**Local (기본값):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**Fixed timezone:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**Elapsed time:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## 도구 페이로드 (원본 provider 데이터 + 정규화된 필드)

도구 호출 (`channels.discord.readMessages`, `channels.slack.readMessages`, 등)은 **원본 provider 타임스탬프**를 반환합니다.
우리는 또한 일관성을 위해 정규화된 필드를 첨부합니다:

- `timestampMs` (UTC epoch milliseconds)
- `timestampUtc` (ISO 8601 UTC string)

원본 provider 필드는 보존됩니다.

## 시스템 프롬프트에 대한 사용자 timezone

`agents.defaults.userTimezone`을 설정하여 모델에 사용자의 local time zone을 알려줍니다. 설정되지 않은 경우 OpenClaw는 **런타임에서 host timezone을 해결**합니다 (설정 쓰기 없음).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

시스템 프롬프트는 다음을 포함합니다:

- `Current Date & Time` 섹션이 local time 및 timezone과 함께
- `Time format: 12-hour` 또는 `24-hour`

당신은 `agents.defaults.timeFormat` (`auto` | `12` | `24`)를 사용하여 프롬프트 형식을 제어할 수 있습니다.

전체 동작 및 예시는 [날짜 & 시간](/date-time)을 참조합니다.
