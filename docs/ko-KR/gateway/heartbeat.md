---
summary: "하트비트 폴링 메시지 및 알림 규칙"
read_when:
  - 하트비트 케이던스 또는 메시징 조정
  - 하트비트와 cron 중 선택
title: "하트비트"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/heartbeat.md
  workflow: 15
---

# 하트비트(게이트웨이)

> **하트비트 vs Cron?** 각각을 사용할 시기에 대한 지침은 [Cron vs Heartbeat](/automation/cron-vs-heartbeat)을 참조하세요.

하트비트는 메인 세션에서 **주기적 에이전트 차례**를 실행하므로 모델이 당신을 스팸하지 않고 관심이 필요한 모든 것을 표시할 수 있습니다.

문제 해결: [/automation/troubleshooting](/automation/troubleshooting)

## 빠른 시작(초보자)

1. 하트비트를 활성화된 상태로 유지합니다(기본값 `30m` 또는 Anthropic OAuth/setup-token의 경우 `1h`) 또는 고유한 케이던스를 설정합니다.
2. 에이전트 작업 공간에 작은 `HEARTBEAT.md` 체크리스트를 만듭니다(선택사항이지만 권장).
3. 하트비트 메시지를 어디로 보낼지 결정합니다(`target: "none"`은 기본값; 마지막 연락처로 라우팅하려면 `target: "last"` 설정).
4. 선택사항: 투명성을 위해 하트비트 추론 전달 활성화.
5. 선택사항: 하트비트를 활동 시간으로 제한합니다(로컬 시간).

예제 설정:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // 마지막 연락처로의 명시적 배달(기본값 "none")
        directPolicy: "allow", // 기본값: 직접/DM 대상 허용; "block"으로 설정하여 억제
      },
    },
  },
}
```

## 기본값

- 간격: `30m` (또는 Anthropic OAuth/setup-token이 감지된 인증 모드인 경우 `1h`). `agents.defaults.heartbeat.every` 또는 에이전트별 `agents.list[].heartbeat.every` 설정; 비활성화하려면 `0m` 사용.
- 프롬프트 본문(기본값): `HEARTBEAT.md`가 있으면 읽고(작업 공간 컨텍스트) 엄격하게 따릅니다. 관심이 없으면 HEARTBEAT_OK로 회신하세요.`
- 하트비트 프롬프트는 **그대로** 사용자 메시지로 전송됩니다. 시스템 프롬프트는 "하트비트" 섹션을 포함하고 실행이 내부적으로 플래그됩니다.
- 활동 시간(`heartbeat.activeHours`)은 구성된 시간대에서 확인됩니다. 창 밖에서는 창 내의 다음 스케줄된 틱까지 하트비트가 건너뜁니다.

## 하트비트 프롬프트의 목적

기본 프롬프트는 의도적으로 광범위합니다:

- **백그라운드 작업**: "미해결 작업 고려" 에이전트에 후속 조치(받은편지함, 캘린더, 알림, 대기열 작업)를 검토하고 긴급 사항을 표시하도록 권장합니다.
- **인간 확인**: "낮 시간에 때때로 인간 체크업" 가끔 가벼운 "뭔가 필요합니까?" 메시지를 권장하지만 구성된 로컬 시간대를 사용하여 밤시간 스팸을 방지합니다([/concepts/timezone](/concepts/timezone) 참조).

매우 구체적인 작업을 수행하기 원하면(예: "Gmail PubSub 통계 확인") `agents.defaults.heartbeat.prompt`를 설정하세요(또는 에이전트별 `agents.list[].heartbeat.prompt`) 사용자 정의 본문으로(그대로 전송).

## 응답 계약

- 관심이 없으면 **`HEARTBEAT_OK`**로 회신하세요.
- 하트비트 실행 중 OpenClaw는 회신의 **시작 또는 끝**에 `HEARTBEAT_OK`가 나타날 때 이를 ack로 취급합니다. 토큰이 제거되고 나머지 컨텐츠가 **≤ `ackMaxChars`**(기본값: 300)인 경우 회신이 삭제됩니다.
- `HEARTBEAT_OK`가 회신의 **중간**에 나타나면 특별하게 취급되지 않습니다.
- 경고의 경우 `HEARTBEAT_OK`를 포함하지 마세요. 경고 텍스트만 반환하세요.

하트비트 외부에서 회신 시작/끝의 불규칙한 `HEARTBEAT_OK`는 제거되고 로깅됩니다. `HEARTBEAT_OK`만인 메시지는 삭제됩니다.

## 설정

자세한 설정 옵션은 원본 문서를 참조하세요.

### 범위 및 우선 순위

- `agents.defaults.heartbeat`는 전체 하트비트 동작을 설정합니다.
- `agents.list[].heartbeat`은 맨 위에 병합됩니다. 에이전트가 `heartbeat` 블록을 포함하면 **해당 에이전트만** 하트비트를 실행합니다.

### 활동 시간 예제

비즈니스 시간으로 하트비트를 제한합니다:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York",
        },
      },
    },
  },
}
```

이 창 밖(동부 시간 오전 9시 전 또는 밤 10시 후) 하트비트가 건너뜁니다. 창 내의 다음 예약된 틱이 정상적으로 실행됩니다.

### 다중 계정 예제

Telegram과 같은 다중 계정 채널에서 특정 계정을 대상으로 하려면 `accountId`를 사용하세요:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678:topic:42", // 선택사항: 특정 주제/스레드로 라우팅
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

## HEARTBEAT.md(선택사항)

작업 공간에 `HEARTBEAT.md` 파일이 있으면 기본 프롬프트는 에이전트에게 읽도록 지시합니다. 이를 "하트비트 체크리스트"로 생각하세요: 작고 안정적이며 30분마다 포함하기에 안전합니다.

`HEARTBEAT.md`가 존재하지만 실제로 비어 있으면(공백 줄만 및 마크다운 헤더) OpenClaw는 API 호출을 절약하기 위해 하트비트 실행을 건너뜁니다.
파일이 누락되면 하트비트가 여전히 실행되고 모델은 수행할 작업을 결정합니다.

작게 유지하세요(짧은 체크리스트 또는 알림) 프롬프트 블로트를 방지합니다.

예제 `HEARTBEAT.md`:

```md
# 하트비트 체크리스트

- 빠른 스캔: 받은편지함에 긴급 사항?
- 낮 시간이면 다른 것이 없으면 가벼운 체크인을 수행하세요.
- 작업이 차단된 경우 _누락된 항목을 작성하고_ 다음에 Peter에게 요청하세요.
```

## 수동 깨우기(요청 시)

시스템 이벤트를 큐에 넣고 즉시 하트비트로 트리거:

```bash
openclaw system event --text "긴급한 후속 조치 확인" --mode now
```

여러 에이전트가 `heartbeat`를 구성한 경우 수동 깨우기는 각 에이전트 하트비트를 즉시 실행합니다.

다음 스케줄된 틱을 기다리려면 `--mode next-heartbeat`를 사용하세요.

## 관련 문서

- [Heartbeat를 사용할 때](/automation/cron-vs-heartbeat)
- [Cron 작업](/automation/cron-jobs)
- [구성](/gateway/configuration)
