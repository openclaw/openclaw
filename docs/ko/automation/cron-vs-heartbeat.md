---
read_when:
    - 반복되는 작업을 예약하는 방법 결정
    - 백그라운드 모니터링 또는 알림 설정
    - 정기 점검을 위한 토큰 사용 최적화
summary: 자동화를 위한 하트비트 작업과 크론 작업 중에서 선택하기 위한 지침
title: 크론 대 하트비트
x-i18n:
    generated_at: "2026-02-08T15:46:56Z"
    model: gtx
    provider: google-translate
    source_hash: fca1006df9d2e842e70d06998fd4a8528e4eef70492e4d9ba0f55dfcf08e6b84
    source_path: automation/cron-vs-heartbeat.md
    workflow: 15
---

# Cron 대 하트비트: 각각을 언제 사용해야 할까요?

하트비트와 크론 작업을 모두 사용하면 일정에 따라 작업을 실행할 수 있습니다. 이 가이드는 사용 사례에 적합한 메커니즘을 선택하는 데 도움이 됩니다.

## 빠른 결정 가이드

| Use Case                             | Recommended         | Why                                      |
| ------------------------------------ | ------------------- | ---------------------------------------- |
| Check inbox every 30 min             | Heartbeat           | Batches with other checks, context-aware |
| Send daily report at 9am sharp       | Cron (isolated)     | Exact timing needed                      |
| Monitor calendar for upcoming events | Heartbeat           | Natural fit for periodic awareness       |
| Run weekly deep analysis             | Cron (isolated)     | Standalone task, can use different model |
| Remind me in 20 minutes              | Cron (main, `--at`) | One-shot with precise timing             |
| Background project health check      | Heartbeat           | Piggybacks on existing cycle             |

## 하트비트: 주기적인 인식

심장박동이 뛰고 있다 **메인 세션** 정기적으로(기본값: 30분) 상담원이 사물을 확인하고 중요한 사항을 표면화할 수 있도록 설계되었습니다.

### 하트비트를 사용해야 하는 경우

- **여러 주기적인 점검**: 받은 편지함, 달력, 날씨, 알림 및 프로젝트 상태를 확인하는 5개의 개별 크론 작업 대신 단일 하트비트로 이 모든 항목을 일괄 처리할 수 있습니다.
- **상황 인식 결정**: 에이전트는 전체 기본 세션 컨텍스트를 갖고 있으므로 긴급한 사항과 대기할 수 있는 사항에 대해 현명한 결정을 내릴 수 있습니다.
- **대화의 연속성**: Heartbeat 실행은 동일한 세션을 공유하므로 상담원은 최근 대화를 기억하고 자연스럽게 후속 조치를 취할 수 있습니다.
- **낮은 오버헤드 모니터링**: 하나의 하트비트가 여러 개의 작은 폴링 작업을 대체합니다.

### 하트비트의 장점

- **여러 검사를 일괄 처리합니다.**: 한 번의 상담원 차례대로 받은 편지함, 캘린더, 알림을 함께 검토할 수 있습니다.
- **API 호출 감소**: 단일 하트비트는 5개의 격리된 크론 작업보다 저렴합니다.
- **상황 인식**: 상담원은 귀하가 진행 중인 작업을 알고 그에 따라 우선순위를 정할 수 있습니다.
- **스마트 억제**: 주의가 필요한 사항이 없으면 상담원이 답변합니다. `HEARTBEAT_OK` 메시지가 전달되지 않습니다.
- **자연스러운 타이밍**: 대기열 로드에 따라 약간의 변동이 있으며 이는 대부분의 모니터링에 적합합니다.

### 하트비트 예: HEARTBEAT.md 체크리스트

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

에이전트는 하트비트마다 이를 읽고 모든 항목을 한 번에 처리합니다.

### 하트비트 구성

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

보다 [하트비트](/gateway/heartbeat) 전체 구성을 위해.

## Cron: 정확한 스케줄링

크론 작업은 다음에서 실행됩니다. **정확한 시간** 기본 컨텍스트에 영향을 주지 않고 격리된 세션에서 실행할 수 있습니다.

### 크론을 사용해야 하는 경우

- **정확한 타이밍 필요**: "매주 월요일 오전 9시에 보냅니다."("언젠가 9시"가 아님)
- **독립형 작업**: 대화적 맥락이 필요하지 않은 작업입니다.
- **다른 모델/사고**: 보다 강력한 모델을 보장하는 철저한 분석입니다.
- **일회성 알림**: "20분 후에 알림"을 ​​사용하여 `--at`.
- **시끄럽고 빈번한 작업**: 기본 세션 기록을 복잡하게 만드는 작업입니다.
- **외부 트리거**: 에이전트의 활성 여부와 관계없이 독립적으로 실행되어야 하는 작업입니다.

### 크론의 장점

- **정확한 타이밍**: 시간대를 지원하는 5필드 cron 표현식입니다.
- **세션 격리**: 뛰어든다 `cron:<jobId>` 주요 기록을 오염시키지 않고.
- **모델 재정의**: 작업별로 더 저렴하거나 더 강력한 모델을 사용하세요.
- **배송 관리**: 격리된 작업의 기본값은 다음과 같습니다. `announce` (요약); 선택하다 `none` 필요에 따라.
- **즉시 배송**: 하트비트를 기다리지 않고 모드 게시물을 직접 공지합니다.
- **에이전트 컨텍스트가 필요하지 않습니다.**: 기본 세션이 유휴 상태이거나 압축된 경우에도 실행됩니다.
- **원샷 지원**: `--at` 정확한 미래 타임스탬프를 위해.

### 크론 예시: 매일 아침 브리핑

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

이는 뉴욕 시간으로 정확히 오전 7시에 실행되며 품질을 위해 Opus를 사용하고 요약을 WhatsApp에 직접 알립니다.

### 크론 예: 일회성 알림

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

보다 [크론 작업](/automation/cron-jobs) 전체 CLI 참조를 위해.

## 결정 흐름도

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

## 둘 다 결합

가장 효율적인 설정은 다음과 같습니다. **둘 다**: 

1. **하트비트** 일상적인 모니터링(받은 편지함, 일정, 알림)을 30분마다 일괄적으로 처리합니다.
2. **크론** 정확한 일정(일일 보고서, 주간 검토) 및 일회성 알림을 처리합니다.

### 예: 효율적인 자동화 설정

**HEARTBEAT.md** (30분마다 확인):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**크론 작업** (정확한 타이밍):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: 승인이 포함된 결정적 워크플로

Lobster는 다음을 위한 워크플로 런타임입니다. **다단계 도구 파이프라인** 결정론적 실행과 명시적인 승인이 필요한 작업입니다.
작업이 단일 에이전트 차례 이상이고 사람 체크포인트가 있는 재개 가능한 워크플로를 원할 때 이 기능을 사용하세요.

### 랍스터가 맞을 때

- **다단계 자동화**: 일회성 프롬프트가 아닌 고정된 도구 호출 파이프라인이 필요합니다.
- **승인 게이트**: 승인할 때까지 부작용이 일시 중지된 다음 재개되어야 합니다.
- **재개 가능한 실행**: 이전 단계를 다시 실행하지 않고 일시 중지된 워크플로를 계속합니다.

### 하트비트 및 크론과 쌍을 이루는 방법

- **하트비트/크론** 결정하다 _언제_ 실행이 발생합니다.
- **새우** 정의하다 _어떤 단계_ 실행이 시작되면 발생합니다.

예약된 워크플로의 경우 cron 또는 하트비트를 사용하여 Lobster를 호출하는 에이전트 차례를 트리거합니다.
임시 워크플로의 경우 Lobster를 직접 호출하세요.

### 운영 참고사항(코드에서)

- 랍스터는 다음과 같이 실행됩니다. **로컬 하위 프로세스** (`lobster` CLI) 도구 모드에서 다음을 반환합니다. **JSON 봉투**.
- 도구가 반환되는 경우 `needs_approval`, 당신은 `resumeToken` 그리고 `approve` 깃발.
- 도구는 **선택적 플러그인**; 다음을 통해 추가적으로 활성화하십시오. `tools.alsoAllow: ["lobster"]` (권장).
- 합격하면 `lobsterPath`, 그것은 이어야 합니다 **절대 경로**.

보다 [새우](/tools/lobster) 전체 사용법과 예를 보려면.

## 기본 세션과 격리된 세션

heartbeat와 cron은 모두 기본 세션과 상호 작용할 수 있지만 다음과 같이 다릅니다.

|         | Heartbeat                       | Cron (main)              | Cron (isolated)            |
| ------- | ------------------------------- | ------------------------ | -------------------------- |
| Session | Main                            | Main (via system event)  | `cron:<jobId>`             |
| History | Shared                          | Shared                   | Fresh each run             |
| Context | Full                            | Full                     | None (starts clean)        |
| Model   | Main session model              | Main session model       | Can override               |
| Output  | Delivered if not `HEARTBEAT_OK` | Heartbeat prompt + event | Announce summary (default) |

### 기본 세션 cron을 사용해야 하는 경우

사용 `--session main` ~와 함께 `--system-event` 당신이 원할 때:

- 기본 세션 컨텍스트에 표시되는 알림/이벤트
- 전체 컨텍스트를 사용하여 다음 하트비트 동안 이를 처리할 에이전트
- 별도의 격리 실행 없음

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### 격리된 크론을 사용해야 하는 경우

사용 `--session isolated` 당신이 원할 때:

- 사전 맥락이 없는 깨끗한 상태
- 다른 모델 또는 사고 설정
- 요약을 채널에 직접 발표
- 메인 세션을 어지럽히지 않는 히스토리

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

| Mechanism       | Cost Profile                                            |
| --------------- | ------------------------------------------------------- |
| Heartbeat       | One turn every N minutes; scales with HEARTBEAT.md size |
| Cron (main)     | Adds event to next heartbeat (no isolated turn)         |
| Cron (isolated) | Full agent turn per job; can use cheaper model          |

**팁**: 

- 유지하다 `HEARTBEAT.md` 토큰 오버헤드를 최소화하기 위해 작습니다.
- 여러 cron 작업 대신 유사한 검사를 하트비트로 일괄 처리합니다.
- 사용 `target: "none"` 내부 처리만 원하는 경우 하트비트에 따라.
- 일상적인 작업에는 더 저렴한 모델과 함께 격리된 크론을 사용하세요.

## 관련된

- [하트비트](/gateway/heartbeat) - 전체 하트비트 구성
- [크론 작업](/automation/cron-jobs) - 전체 크론 CLI 및 API 참조
- [체계](/cli/system) - 시스템 이벤트 + 하트비트 제어
