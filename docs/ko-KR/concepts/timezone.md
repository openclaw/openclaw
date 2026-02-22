---
summary: "에이전트, 봉투 및 프롬프트의 시간대 처리"
read_when:
  - 모델을 위해 타임스탬프가 어떻게 표준화되는지 이해해야 할 때
  - 시스템 프롬프트를 위해 사용자 시간대를 설정할 때
title: "시간대"
---

# 시간대

OpenClaw는 타임스탬프를 표준화하여 모델이 **단일 기준 시간**을 보도록 합니다.

## 메시지 봉투 (기본적으로 로컬)

수신 메시지는 다음과 같이 봉투에 포장됩니다:

```
[Provider ... 2026-01-05 16:26 PST] 메시지 텍스트
```

봉투 내 타임스탬프는 **기본적으로 호스트-로컬**이며, 분 단위의 정밀도를 가집니다.

다음과 같이 재정의할 수 있습니다:

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
- `envelopeTimezone: "user"`는 `agents.defaults.userTimezone`을 사용합니다 (호스트 시간대로 대체됩니다).
- 고정 오프셋을 위해 명시적인 IANA 시간대를 사용합니다 (예: `"Europe/Vienna"`).
- `envelopeTimestamp: "off"`는 봉투 헤더에서 절대 타임스탬프를 제거합니다.
- `envelopeElapsed: "off"`는 경과 시간 접미사를 제거합니다 (`+2m` 스타일).

### 예

**로컬 (기본):**

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

## 도구 페이로드 (원시 프로바이더 데이터 + 표준화된 필드)

도구 호출 (`channels.discord.readMessages`, `channels.slack.readMessages`, 등)은 **원시 프로바이더 타임스탬프**를 반환합니다.
일관성을 위해 표준화된 필드도 첨부합니다:

- `timestampMs` (UTC epoch 밀리초)
- `timestampUtc` (ISO 8601 UTC 문자열)

원시 프로바이더 필드는 유지됩니다.

## 시스템 프롬프트를 위한 사용자 시간대

모델에 사용자의 로컬 시간대를 알려주기 위해 `agents.defaults.userTimezone`을 설정하세요. 설정되지 않은 경우, OpenClaw는 **런타임에서 호스트 시간대**를 해결합니다 (구성 작성 없음).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

시스템 프롬프트에는 다음이 포함됩니다:

- 로컬 시간과 시간대가 포함된 `현재 날짜 및 시간` 섹션
- `시간 형식: 12시간` 또는 `24시간`

`agents.defaults.timeFormat` (`auto` | `12` | `24`)로 프롬프트 형식을 제어할 수 있습니다.

전체 동작 및 예시는 [Date & Time](/date-time)을 참조하세요.
