---
summary: "자동화를 위해 heartbeat 와 cron 작업 중 무엇을 선택할지에 대한 가이드"
read_when:
  - 반복 작업을 어떻게 스케줄링할지 결정할 때
  - 백그라운드 모니터링 또는 알림을 설정할 때
  - 주기적 점검을 위한 토큰 사용량을 최적화할 때
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat: 각각을 언제 사용해야 할까

heartbeat 와 cron 작업은 모두 일정에 따라 작업을 실행할 수 있게 해줍니다. 이 가이드는 사용 사례에 맞는 올바른 메커니즘을 선택하는 데 도움을 줍니다.

## 빠른 결정 가이드

| 사용 사례                   | 권장 사항                                  | 이유                           |
| ----------------------- | -------------------------------------- | ---------------------------- |
| 30 분마다 받은편지함 확인         | Heartbeat                              | 다른 점검과 함께 배치 처리, 컨텍스트 인지     |
| 매일 정확히 오전 9 시에 보고서 전송   | Cron (isolated)     | 정확한 타이밍 필요                   |
| 다가오는 일정 이벤트 모니터링        | Heartbeat                              | 주기적 인지에 자연스럽게 적합             |
| 매주 심층 분석 실행             | Cron (isolated)     | 독립 작업, 다른 모델 사용 가능           |
| Remind me in 20 minutes | Cron (main, `--at`) | 정확한 타이밍의 단발성 작업              |
| 백그라운드 프로젝트 상태 점검        | Heartbeat                              | Piggybacks on existing cycle |

## Heartbeat: 주기적 인지

heartbeat 는 **메인 세션**에서 정기적인 간격(기본값: 30 분)으로 실행됩니다. 에이전트가 상태를 점검하고 중요한 사항을 드러내도록 설계되었습니다.

### heartbeat 를 사용해야 할 때

- **여러 주기적 점검**: 받은편지함, 캘린더, 날씨, 알림, 프로젝트 상태를 각각 확인하는 5 개의 cron 작업 대신, 하나의 heartbeat 로 모두 배치 처리할 수 있습니다.
- **컨텍스트 인지 결정**: 에이전트는 메인 세션의 전체 컨텍스트를 가지므로, 무엇이 긴급한지와 무엇이 기다릴 수 있는지를 현명하게 판단할 수 있습니다.
- **대화 연속성**: heartbeat 실행은 동일한 세션을 공유하므로, 에이전트가 최근 대화를 기억하고 자연스럽게 후속 조치를 할 수 있습니다.
- **낮은 오버헤드 모니터링**: 하나의 heartbeat 가 여러 작은 폴링 작업을 대체합니다.

### heartbeat 의 장점

- **여러 점검을 배치 처리**: 한 번의 에이전트 턴으로 받은편지함, 캘린더, 알림을 함께 검토합니다.
- **API 호출 감소**: 단일 heartbeat 는 5 개의 독립적인 cron 작업보다 비용이 적게 듭니다.
- **컨텍스트 인지**: 에이전트는 사용자가 무엇을 작업 중인지 알고 우선순위를 정할 수 있습니다.
- **스마트 억제**: 주의를 요하는 것이 없으면 에이전트는 `HEARTBEAT_OK` 로 응답하며 메시지는 전달되지 않습니다.
- **자연스러운 타이밍**: 큐 부하에 따라 약간 드리프트가 발생하지만, 대부분의 모니터링에는 문제가 되지 않습니다.

### heartbeat 예시: HEARTBEAT.md 체크리스트

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

에이전트는 각 heartbeat 마다 이를 읽고 모든 항목을 한 번의 턴에서 처리합니다.

### heartbeat 구성

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // where to deliver alerts
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

자세한 내용은 [Heartbeat](/gateway/heartbeat) 를 참고하십시오.

## Cron: 정밀한 스케줄링

cron 작업은 **정확한 시각**에 실행되며, 메인 컨텍스트에 영향을 주지 않는 isolated 세션에서 실행될 수 있습니다.

### cron 을 사용해야 할 때

- **정확한 타이밍이 필요한 경우**: "매주 월요일 오전 9:00 에 전송"과 같이, "대략 9 시쯤"이 아닌 경우.
- **독립 작업**: 대화 컨텍스트가 필요 없는 작업.
- **다른 모델/사고 방식**: 더 강력한 모델이 필요한 무거운 분석.
- **단발성 알림**: `--at` 와 함께 "20 분 후에 알림".
- **시끄럽거나 빈번한 작업**: 메인 세션 기록을 어지럽힐 수 있는 작업.
- **외부 트리거**: 에이전트가 다른 활동을 하지 않더라도 독립적으로 실행되어야 하는 작업.

### cron 의 장점

- **정확한 타이밍**: 타임존을 지원하는 5 필드 cron 표현식.
- **세션 격리**: 메인 기록을 오염시키지 않고 `cron:<jobId>` 에서 실행.
- **모델 재정의**: 작업별로 더 저렴하거나 더 강력한 모델 사용.
- **전달 제어**: isolated 작업은 기본값으로 `announce` (요약); 필요 시 `none` 선택.
- **즉시 전달**: announce 모드는 heartbeat 를 기다리지 않고 직접 게시.
- **에이전트 컨텍스트 불필요**: 메인 세션이 유휴 상태이거나 압축되어 있어도 실행.
- **단발성 지원**: 정확한 미래 타임스탬프를 위한 `--at`.

### cron 예시: 일일 아침 브리핑

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

이는 뉴욕 시간 기준 정확히 오전 7:00 에 실행되며, 품질을 위해 Opus 를 사용하고 요약을 WhatsApp 으로 직접 알립니다.

### cron 예시: 단발성 알림

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

전체 CLI 참조는 [Cron jobs](/automation/cron-jobs) 를 참고하십시오.

## 결정 플로차트

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Does it need a different model or thinking level?
  YES -> Use cron (isolated) with --model/--thinking
  NO  -> Use heartbeat
```

## 둘을 함께 사용하기

가장 효율적인 설정은 **둘 다** 사용하는 것입니다:

1. **Heartbeat** 는 받은편지함, 캘린더, 알림과 같은 일상적 모니터링을 30 분마다 한 번의 배치된 턴으로 처리합니다.
2. **Cron** 은 정확한 스케줄(일일 보고서, 주간 리뷰)과 단발성 알림을 처리합니다.

### 예시: 효율적인 자동화 설정

**HEARTBEAT.md** (30 분마다 확인):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Cron 작업** (정밀한 타이밍):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: 승인 기반의 결정적 워크플로

Lobster 는 **다단계 도구 파이프라인**을 위한 워크플로 런타임으로, 결정적 실행과 명시적 승인이 필요할 때 사용합니다.
작업이 단일 에이전트 턴을 넘어서며, 사람의 체크포인트가 있는 재개 가능한 워크플로가 필요할 때 사용하십시오.

### Lobster 가 적합한 경우

- **다단계 자동화**: 일회성 프롬프트가 아닌, 고정된 도구 호출 파이프라인이 필요한 경우.
- **승인 게이트**: 부작용이 승인 전까지 일시 중지되었다가, 승인 후 재개되어야 하는 경우.
- **재개 가능한 실행**: 이전 단계를 다시 실행하지 않고 일시 중지된 워크플로를 계속하는 경우.

### heartbeat 및 cron 과의 조합

- **Heartbeat/cron** 은 실행 _시점_ 을 결정합니다.
- **Lobster** 는 실행이 시작된 후 _어떤 단계_ 가 수행되는지를 정의합니다.

스케줄된 워크플로의 경우, cron 또는 heartbeat 를 사용해 Lobster 를 호출하는 에이전트 턴을 트리거하십시오.
임시 워크플로의 경우, Lobster 를 직접 호출하십시오.

### 운영 참고 사항 (코드 기준)

- Lobster 는 도구 모드에서 **로컬 서브프로세스** (`lobster` CLI) 로 실행되며 **JSON 엔벨로프**를 반환합니다.
- 도구가 `needs_approval` 를 반환하면, `resumeToken` 와 `approve` 플래그로 재개합니다.
- 이 도구는 **선택적 플러그인**이며, `tools.alsoAllow: ["lobster"]` 을 통해 추가적으로 활성화합니다(권장).
- `lobsterPath` 를 전달하는 경우, **절대 경로**여야 합니다.

전체 사용법과 예시는 [Lobster](/tools/lobster) 를 참고하십시오.

## 메인 세션 vs Isolated 세션

heartbeat 와 cron 은 모두 메인 세션과 상호작용할 수 있지만, 방식은 다릅니다:

|      | Heartbeat               | Cron (main)     | Cron (isolated) |
| ---- | ----------------------- | ---------------------------------- | ---------------------------------- |
| 세션   | 메인                      | 메인 (시스템 이벤트 경유) | `cron:<jobId>`                     |
| 기록   | 공유됨                     | 공유됨                                | 실행마다 새로 시작                         |
| 컨텍스트 | 전체                      | 전체                                 | 없음 (깨끗하게 시작)    |
| 모델   | 메인 세션 모델                | 메인 세션 모델                           | Can override                       |
| 출력   | `HEARTBEAT_OK` 이 아니면 전달 | Heartbeat 프롬프트 + 이벤트               | 요약 공지 (기본값)     |

### 메인 세션 cron 을 사용해야 할 때

다음과 같은 경우 `--session main` 와 `--system-event` 를 사용하십시오:

- 알림/이벤트가 메인 세션 컨텍스트에 나타나길 원하는 경우
- 에이전트가 다음 heartbeat 동안 전체 컨텍스트로 이를 처리하길 원하는 경우
- 별도의 isolated 실행이 필요 없는 경우

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### isolated cron 을 사용해야 할 때

다음과 같은 경우 `--session isolated` 를 사용하십시오:

- 이전 컨텍스트 없이 깨끗한 시작이 필요한 경우
- 다른 모델 또는 사고 설정이 필요한 경우
- 요약 공지를 채널로 직접 보내고 싶은 경우
- 메인 세션을 어지럽히지 않는 기록이 필요한 경우

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## 비용 고려 사항

| 메커니즘                               | 비용 특성                                                    |
| ---------------------------------- | -------------------------------------------------------- |
| Heartbeat                          | N 분마다 한 턴; HEARTBEAT.md 크기에 따라 확장        |
| Cron (main)     | 다음 heartbeat 에 이벤트 추가 (isolated 턴 없음) |
| Cron (isolated) | 작업당 전체 에이전트 턴; 더 저렴한 모델 사용 가능                            |

**팁**:

- 토큰 오버헤드를 최소화하려면 `HEARTBEAT.md` 를 작게 유지하십시오.
- 여러 cron 작업 대신 유사한 점검을 heartbeat 에 배치하십시오.
- 내부 처리만 원한다면 heartbeat 에 `target: "none"` 를 사용하십시오.
- 일상적인 작업에는 더 저렴한 모델로 isolated cron 을 사용하십시오.

## 관련

- [Heartbeat](/gateway/heartbeat) - 전체 heartbeat 구성
- [Cron jobs](/automation/cron-jobs) - 전체 cron CLI 및 API 참조
- [System](/cli/system) - 시스템 이벤트 + heartbeat 제어
