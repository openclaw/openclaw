---
summary: "에이전트, 엔벌로프, 프롬프트를 위한 타임존 처리"
read_when:
  - 모델에 대해 타임스탬프가 어떻게 정규화되는지 이해해야 할 때
  - 시스템 프롬프트에서 사용자 타임존을 구성할 때
title: "타임존"
---

# 타임존

OpenClaw 는 모델이 **단일 기준 시간**을 보도록 타임스탬프를 표준화합니다.

## 메시지 엔벨로프(기본값은 로컬)

인바운드 메시지는 다음과 같은 엔벌로프로 래핑됩니다:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

엔벌로프의 타임스탬프는 **기본적으로 호스트 로컬**이며, 분 단위 정밀도를 사용합니다.

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

- `envelopeTimezone: "utc"` 은 UTC 를 사용합니다.
- `envelopeTimezone: "user"` 은 `agents.defaults.userTimezone` 을 사용합니다 (호스트 타임존으로 폴백).
- 고정 오프셋을 위해 명시적 IANA 타임존(예: `"Europe/Vienna"`)을 사용합니다.
- `envelopeTimestamp: "off"` 은 엔벌로프 헤더에서 절대 타임스탬프를 제거합니다.
- `envelopeElapsed: "off"` 은 경과 시간 접미사(`+2m` 스타일)를 제거합니다.

### 예제

**로컬(기본값):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**고정 타임존:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**경과 시간:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## 도구 페이로드 (원시 프로바이더 데이터 + 정규화된 필드)

도구 호출(`channels.discord.readMessages`, `channels.slack.readMessages` 등)은 **원시 프로바이더 타임스탬프**를 반환합니다. **원본 제공자 타임스탬프**를 반환합니다.
일관성을 위해 정규화된 필드도 함께 첨부합니다:

- `timestampMs` (UTC 에포크 밀리초)
- `timestampUtc` (ISO 8601 UTC 문자열)

원시 프로바이더 필드는 보존됩니다.

## 시스템 프롬프트를 위한 사용자 타임존

모델에 사용자의 로컬 타임존을 알리려면 `agents.defaults.userTimezone` 을 설정하십시오. 설정되지 않은 경우,
OpenClaw 는 **런타임에 호스트 타임존을 해결**합니다 (구성 쓰기 없음).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

시스템 프롬프트에는 다음이 포함됩니다:

- 로컬 시간과 타임존을 포함하는 `Current Date & Time` 섹션
- `Time format: 12-hour` 또는 `24-hour`

`agents.defaults.timeFormat` (`auto` | `12` | `24`)로 프롬프트 형식을 제어할 수 있습니다.

전체 동작과 예시는 [Date & Time](/date-time)을 참고하십시오.
