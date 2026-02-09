---
summary: "엔벌로프, 프롬프트, 도구 및 커넥터 전반에서의 날짜 및 시간 처리"
read_when:
  - 모델 또는 사용자에게 표시되는 타임스탬프 방식을 변경하는 경우
  - 메시지 또는 시스템 프롬프트 출력에서 시간 형식을 디버깅하는 경우
title: "날짜 및 시간"
---

# Date & Time

OpenClaw 는 **전송 타임스탬프에는 호스트 로컬 시간**을 기본으로 사용하며, **시스템 프롬프트에는 사용자 타임존만** 포함합니다.
프로바이더 타임스탬프는 보존되어 도구가 고유한 시맨틱을 유지하도록 합니다 (현재 시간은 `session_status` 를 통해 사용할 수 있습니다).

## 메시지 엔벨로프(기본값은 로컬)

인바운드 메시지는 타임스탬프 (분 단위 정밀도)와 함께 래핑됩니다:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

이 엔벌로프 타임스탬프는 프로바이더 타임존과 무관하게 **기본적으로 호스트 로컬**입니다.

이 동작은 다음과 같이 재정의할 수 있습니다:

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

- `envelopeTimezone: "utc"` 는 UTC 를 사용합니다.
- `envelopeTimezone: "local"` 는 호스트 타임존을 사용합니다.
- `envelopeTimezone: "user"` 는 `agents.defaults.userTimezone` 를 사용합니다 (호스트 타임존으로 폴백).
- 고정된 존을 위해 명시적인 IANA 타임존 (예: `"America/Chicago"`)을 사용하십시오.
- `envelopeTimestamp: "off"` 는 엔벌로프 헤더에서 절대 타임스탬프를 제거합니다.
- `envelopeElapsed: "off"` 는 경과 시간 접미사 (`+2m` 스타일)를 제거합니다.

### Examples

**로컬 (기본값):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**사용자 타임존:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**경과 시간 활성화:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## 시스템 프롬프트: 현재 날짜 및 시간

사용자 타임존을 알고 있는 경우, 시스템 프롬프트에는 프롬프트 캐싱을 안정적으로 유지하기 위해
**시간대만** 포함하는 전용 **현재 날짜 및 시간** 섹션이 추가됩니다 (시계/시간 형식 없음):

```
Time zone: America/Chicago
```

에이전트가 현재 시간이 필요할 때는 `session_status` 도구를 사용하십시오. 상태
카드에는 타임스탬프 라인이 포함됩니다.

## 시스템 이벤트 라인 (기본값: 로컬)

에이전트 컨텍스트에 삽입되는 큐잉된 시스템 이벤트는 메시지 엔벌로프와 동일한
타임존 선택 (기본값: 호스트 로컬)을 사용하여 타임스탬프 접두사가 붙습니다.

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### 사용자 타임존 + 형식 구성

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

- `userTimezone` 는 프롬프트 컨텍스트를 위한 **사용자 로컬 타임존**을 설정합니다.
- `timeFormat` 는 프롬프트에서의 **12시간/24시간 표시**를 제어합니다. `auto` 는 OS 기본 설정을 따릅니다.

## 시간 형식 감지 (자동)

`timeFormat: "auto"` 인 경우, OpenClaw 는 OS 기본 설정 (macOS/Windows)을 검사하고
로케일 형식으로 폴백합니다. 감지된 값은 반복적인 시스템 호출을 피하기 위해
**프로세스 단위로 캐시**됩니다.

## 도구 페이로드 + 커넥터 (원시 프로바이더 시간 + 정규화된 필드)

채널 도구는 **프로바이더 네이티브 타임스탬프**를 반환하고, 일관성을 위해 정규화된 필드를 추가합니다:

- `timestampMs`: 에포크 밀리초 (UTC)
- `timestampUtc`: ISO 8601 UTC 문자열

원시 프로바이더 필드는 손실이 없도록 그대로 보존됩니다.

- Slack: API 에서 제공되는 에포크 유사 문자열
- Discord: UTC ISO 타임스탬프
- Telegram/WhatsApp: 프로바이더별 숫자/ISO 타임스탬프

로컬 시간이 필요한 경우, 알려진 타임존을 사용하여 다운스트림에서 변환하십시오.

## 관련 문서

- [System Prompt](/concepts/system-prompt)
- [Timezones](/concepts/timezone)
- [Messages](/concepts/messages)
