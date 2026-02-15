---
summary: "Date and time handling across envelopes, prompts, tools, and connectors"
read_when:
  - You are changing how timestamps are shown to the model or users
  - You are debugging time formatting in messages or system prompt output
title: "Date and Time"
x-i18n:
  source_hash: 753af5946a006215d6af2467fa478f3abb42b1dff027cf85d5dc4c7ba4b58d39
---

# 날짜 및 시간

OpenClaw는 기본적으로 **전송 타임스탬프의 호스트-현지 시간** 및 **시스템 프롬프트에서만 사용자 시간대**를 사용합니다.
제공자 타임스탬프가 보존되므로 도구는 기본 의미를 유지합니다(현재 시간은 `session_status`를 통해 확인 가능).

## 메시지 봉투(기본적으로 로컬)

인바운드 메시지는 타임스탬프(분 정밀도)로 래핑됩니다.

```
[Provider ... 2026-01-05 16:26 PST] message text
```

이 봉투 타임스탬프는 공급자 시간대에 관계없이 **기본적으로 호스트 로컬**입니다.

이 동작을 재정의할 수 있습니다.

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
- `envelopeTimezone: "local"`는 호스트 시간대를 사용합니다.
- `envelopeTimezone: "user"`는 `agents.defaults.userTimezone`를 사용합니다(호스트 시간대로 대체).
- 고정 구역에는 명시적인 IANA 시간대(예: `"America/Chicago"`)를 사용합니다.
- `envelopeTimestamp: "off"`는 봉투 헤더에서 절대 타임스탬프를 제거합니다.
- `envelopeElapsed: "off"`는 경과 시간 접미사(`+2m` 스타일)를 제거합니다.

### 예

**로컬(기본값):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**사용자 시간대:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**경과 시간 활성화됨:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## 시스템 프롬프트: 현재 날짜 및 시간

사용자 시간대를 알고 있는 경우 시스템 프롬프트에는 전용 시간대가 포함됩니다.
**시간대만** 있는 **현재 날짜 및 시간** 섹션(시계/시간 형식 없음)
프롬프트 캐싱을 안정적으로 유지하려면 다음을 수행하세요.

```
Time zone: America/Chicago
```

에이전트에 현재 시간이 필요한 경우 `session_status` 도구를 사용하세요. 상태
카드에는 타임스탬프 줄이 포함되어 있습니다.

## 시스템 이벤트 라인(기본적으로 로컬)

에이전트 컨텍스트에 삽입된 대기열 시스템 이벤트에는 다음을 사용하여 타임스탬프가 앞에 붙습니다.
메시지 봉투와 동일한 시간대 선택(기본값: 호스트-로컬)

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### 사용자 시간대 + 형식 구성

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone`는 프롬프트 컨텍스트에 대한 **사용자 현지 시간대**를 설정합니다.
- `timeFormat`는 프롬프트에서 **12시간/24시간 표시**를 제어합니다. `auto`는 OS 기본 설정을 따릅니다.

## 시간 형식 감지(자동)

`timeFormat: "auto"`인 경우 OpenClaw는 OS 기본 설정을 검사합니다(macOS/Windows).
로케일 형식으로 돌아갑니다. 감지된 값은 **프로세스별로 캐시**됩니다.
반복되는 시스템 호출을 피하기 위해.

## 도구 페이로드 + 커넥터(원시 공급자 시간 + 정규화된 필드)

채널 도구는 **제공자 기본 타임스탬프**를 반환하고 일관성을 위해 정규화된 필드를 추가합니다.

- `timestampMs`: 에포크 밀리초(UTC)
- `timestampUtc`: ISO 8601 UTC 문자열

원시 공급자 필드는 보존되므로 아무것도 손실되지 않습니다.

- Slack: API의 획기적인 문자열
- 불일치: UTC ISO 타임스탬프
- 텔레그램/WhatsApp: 공급자별 숫자/ISO 타임스탬프

현지 시간이 필요한 경우 알려진 시간대를 사용하여 다운스트림으로 변환하세요.

## 관련 문서

- [시스템 프롬프트](/concepts/system-prompt)
- [시간대](/concepts/timezone)
- [메시지](/concepts/messages)
