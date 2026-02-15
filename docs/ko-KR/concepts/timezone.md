---
summary: "Timezone handling for agents, envelopes, and prompts"
read_when:
  - You need to understand how timestamps are normalized for the model
  - Configuring the user timezone for system prompts
title: "Timezones"
x-i18n:
  source_hash: 9ee809c96897db1126c7efcaa5bf48a63cdcb2092abd4b3205af224ebd882766
---

# 시간대

OpenClaw는 모델이 **단일 참조 시간**을 볼 수 있도록 타임스탬프를 표준화합니다.

## 메시지 봉투(기본적으로 로컬)

인바운드 메시지는 다음과 같은 봉투에 포장됩니다.

```
[Provider ... 2026-01-05 16:26 PST] message text
```

봉투의 타임스탬프는 **기본적으로 호스트 로컬**이며, 정밀도는 분 단위입니다.

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

- `envelopeTimezone: "utc"`는 UTC를 사용합니다.
- `envelopeTimezone: "user"`는 `agents.defaults.userTimezone`를 사용합니다(호스트 시간대로 대체).
- 고정 오프셋에는 명시적인 IANA 시간대(예: `"Europe/Vienna"`)를 사용합니다.
- `envelopeTimestamp: "off"`는 봉투 헤더에서 절대 타임스탬프를 제거합니다.
- `envelopeElapsed: "off"`는 경과 시간 접미사(`+2m` 스타일)를 제거합니다.

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

도구 호출(`channels.discord.readMessages`, `channels.slack.readMessages` 등)은 **원시 공급자 타임스탬프**를 반환합니다.
일관성을 위해 정규화된 필드도 첨부합니다.

- `timestampMs` (UTC 에포크 밀리초)
- `timestampUtc` (ISO 8601 UTC 문자열)

원시 공급자 필드는 유지됩니다.

## 시스템 프롬프트의 사용자 시간대

모델에 사용자의 현지 시간대를 알려주려면 `agents.defaults.userTimezone`를 설정하세요. 그렇다면
설정하지 않으면 OpenClaw는 **런타임에 호스트 시간대**를 확인합니다(구성 쓰기 없음).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

시스템 프롬프트에는 다음이 포함됩니다.

- 현지 시간과 시간대가 포함된 `Current Date & Time` 섹션
- `Time format: 12-hour` 또는 `24-hour`

`agents.defaults.timeFormat` (`auto` | `12` | `24`)를 사용하여 프롬프트 형식을 제어할 수 있습니다.

전체 동작과 예시는 [날짜 및 시간](/date-time)을 참조하세요.
