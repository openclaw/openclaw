---
summary: "엔벨로프, 프롬프트, 도구, 커넥터 전반에 걸친 날짜 및 시간 처리"
read_when:
  - 타임스탬프를 모델이나 사용자에게 표시하는 방식을 변경할 때
  - 메시지나 시스템 프롬프트 출력에서 시간 포맷을 디버깅할 때
title: "날짜 및 시간"
---

# 날짜 & 시간

OpenClaw는 **전송 타임스탬프에 대해 호스트 로컬 시간을 기본값**으로 하며, **시스템 프롬프트에서는 사용자 시간대만**을 사용합니다.
프로바이더 타임스탬프는 유지되므로 도구는 본래의 의미를 유지합니다 (현재 시간은 `session_status`를 통해 이용할 수 있습니다).

## 메시지 엔벨로프 (기본적으로 로컬)

수신 메시지는 타임스탬프와 함께 래핑됩니다 (분 단위 정밀도):

```
[Provider ... 2026-01-05 16:26 PST] 메시지 텍스트
```

이 엔벨로프 타임스탬프는 **기본적으로 호스트 로컬**이며, 프로바이더 시간대와는 상관없습니다.

이 동작을 재정의할 수 있습니다:

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
- `envelopeTimezone: "local"`은 호스트 시간대를 사용합니다.
- `envelopeTimezone: "user"`는 `agents.defaults.userTimezone`을 사용하며 (호스트 시간대를 기본값으로 사용).
- 고정된 시간대를 사용하려면 명시적인 IANA 시간대 (예: `"America/Chicago"`)를 사용하십시오.
- `envelopeTimestamp: "off"`는 절대 타임스탬프를 엔벨로프 헤더에서 제거합니다.
- `envelopeElapsed: "off"`는 경과 시간 접미사 (`+2m` 스타일)를 제거합니다.

### 예시

**로컬 (기본):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] 안녕하세요
```

**사용자 시간대:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] 안녕하세요
```

**경과 시간 활성화:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] 후속 조치
```

## 시스템 프롬프트: 현재 날짜 & 시간

사용자 시간대가 알려진 경우, 시스템 프롬프트에는 **현재 날짜 & 시간** 섹션이 포함되며, **시간대만** 포함됩니다 (시간/시간 형식 없음). 이는 프롬프트 캐싱을 안정화하기 위해서입니다:

```
시간대: America/Chicago
```

에이전트가 현재 시간을 필요로 할 때는 `session_status` 도구를 사용하십시오. 상태 카드에는 타임스탬프 라인이 포함됩니다.

## 시스템 이벤트 라인 (기본적으로 로컬)

에이전트 컨텍스트에 삽입된 큐 시스템 이벤트들은 메시지 엔벨로프와 동일한 시간대 선택으로 타임스탬프로 접두어가 붙습니다 (기본: 호스트 로컬).

```
시스템: [2026-01-12 12:19:17 PST] 모델 전환됨.
```

### 사용자 시간대 + 포맷 구성

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

- `userTimezone`은 프롬프트 컨텍스트에 대한 **사용자 로컬 시간대**를 설정합니다.
- `timeFormat`은 프롬프트에서 **12시간/24시간 표시**를 제어합니다. `auto`는 OS 환경 설정을 따릅니다.

## 시간 형식 감지 (자동)

`timeFormat: "auto"`일 때, OpenClaw는 OS 환경 설정 (macOS/Windows)을 검사하고 지역 형식으로 대체합니다. 감지된 값은 반복적인 시스템 호출을 피하기 위해 **프로세스당 캐시됩니다**.

## 도구 페이로드 + 커넥터 (원시 프로바이더 시간 + 정규화 필드)

채널 도구는 **프로바이더 고유의 타임스탬프**를 반환하고 일관성을 위한 정규화된 필드를 추가합니다:

- `timestampMs`: 에포크 밀리초 (UTC)
- `timestampUtc`: ISO 8601 UTC 문자열

원시 프로바이더 필드는 보존되므로 손실이 없습니다.

- Slack: API에서의 에포크 유사 문자열
- Discord: UTC ISO 타임스탬프
- Telegram/WhatsApp: 프로바이더 고유의 숫자/ISO 타임스탬프

로컬 시간이 필요하면 알려진 시간대를 사용해 하위 단계에서 변환하십시오.

## 관련 문서

- [시스템 프롬프트](/concepts/system-prompt)
- [시간대](/concepts/timezone)
- [메시지](/concepts/messages)
