---
summary: "Heartbeat polling messages and notification rules"
read_when:
  - Adjusting heartbeat cadence or messaging
  - Deciding between heartbeat and cron for scheduled tasks
title: "Heartbeat"
x-i18n:
  source_hash: e763caf86ef74488e925eb9555bab389ffa9e1c0b5f48da23441297f69ca5312
---

# 하트비트(게이트웨이)

> **하트비트 대 Cron?** 각각을 언제 사용해야 하는지에 대한 지침은 [Cron 대 하트비트](/automation/cron-vs-heartbeat)를 참조하세요.

Heartbeat는 모델이 다음을 수행할 수 있도록 기본 세션에서 **주기적인 에이전트 전환**을 실행합니다.
스팸을 보내지 않고도 주의가 필요한 모든 것을 표면화할 수 있습니다.

문제 해결: [/자동화/문제 해결](/automation/troubleshooting)

## 빠른 시작(초보자)

1. 하트비트를 활성화된 상태로 두거나(기본값은 `30m` 또는 Anthropic OAuth/setup-token의 경우 `1h`입니다) 자신만의 흐름을 설정하세요.
2. 상담원 작업 영역에 작은 `HEARTBEAT.md` 체크리스트를 만듭니다(선택 사항이지만 권장됨).
3. 하트비트 메시지를 어디로 보낼지 결정합니다(`target: "last"`가 기본값입니다).
4. 선택 사항: 투명성을 위해 하트비트 추론 전달을 활성화합니다.
5. 선택 사항: 하트비트를 활동 시간(현지 시간)으로 제한합니다.

예시 구성:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## 기본값

- 간격: `30m` (또는 Anthropic OAuth/setup-token이 감지된 인증 모드인 경우 `1h`). `agents.defaults.heartbeat.every` 또는 에이전트별 `agents.list[].heartbeat.every`를 설정합니다. 비활성화하려면 `0m`를 사용하세요.
- 프롬프트 본문(`agents.defaults.heartbeat.prompt`을 통해 구성 가능):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- 하트비트 프롬프트가 **동영상**으로 사용자 메시지로 전송됩니다. 시스템
  프롬프트에는 "하트비트" 섹션이 포함되어 있으며 실행은 내부적으로 플래그가 지정됩니다.
- 활동 시간(`heartbeat.activeHours`)은 설정된 시간대로 확인됩니다.
  창 밖에서는 창 내부의 다음 틱까지 하트비트를 건너뜁니다.

## 하트비트 프롬프트의 용도

기본 프롬프트는 의도적으로 광범위합니다.

- **백그라운드 작업**: '미해결 작업을 고려하세요'는 상담원이 검토하도록 유도합니다.
  후속 조치(받은 편지함, 캘린더, 미리 알림, 대기 중인 작업) 및 긴급한 사항을 표시합니다.
- **사람 체크인**: "낮 시간에 가끔 사람을 확인합니다."
  가끔 가벼운 "필요한 것 있으신가요?" 메시지를 보내지만 야간 스팸은 피합니다.
  구성된 현지 시간대를 사용합니다([/concepts/timezone](/concepts/timezone) 참조).

매우 구체적인 작업을 수행하기 위해 하트비트를 원하는 경우(예: 'Gmail PubSub를 확인하세요.
통계” 또는 “게이트웨이 상태 확인”), `agents.defaults.heartbeat.prompt` 설정(또는
`agents.list[].heartbeat.prompt`)를 사용자 정의 본문에 추가합니다(문자 그대로 전송됨).

## 응답 계약

- 주의할 사항이 없으면 **`HEARTBEAT_OK`**로 답장하세요.
- 하트비트 실행 중에 OpenClaw는 `HEARTBEAT_OK`가 나타날 때 ack로 처리합니다.
  답장의 **시작 또는 끝**에. 토큰이 제거되고 응답은 다음과 같습니다.
  남은 콘텐츠가 **≤ `ackMaxChars`**(기본값: 300)인 경우 삭제됩니다.
- 답글 **중간에** `HEARTBEAT_OK`가 나타나면 처리되지 않습니다.
  특별히.
- 경고의 경우 `HEARTBEAT_OK`를 포함하지 **않습니다**; 경고 텍스트만 반환합니다.

하트비트 외부에서 메시지 시작/끝의 길잃은 `HEARTBEAT_OK`가 제거됩니다.
그리고 기록되었습니다; `HEARTBEAT_OK`만 있는 메시지가 삭제됩니다.

## 구성

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### 범위 및 우선순위

- `agents.defaults.heartbeat`는 전역 하트비트 동작을 설정합니다.
- `agents.list[].heartbeat`가 맨 위에 병합됩니다. 에이전트에 `heartbeat` 블록이 있으면 **해당 에이전트**만 하트비트를 실행합니다.
- `channels.defaults.heartbeat`는 모든 채널에 대한 가시성 기본값을 설정합니다.
- `channels.<channel>.heartbeat`는 채널 기본값을 무시합니다.
- `channels.<channel>.accounts.<id>.heartbeat` (다중 계정 채널)는 채널별 설정을 무시합니다.

### 에이전트별 하트비트

`agents.list[]` 항목에 `heartbeat` 블록이 포함된 경우 **해당 에이전트만**
심장박동을 뛰다. 에이전트별 블록은 `agents.defaults.heartbeat` 위에 병합됩니다.
(따라서 공유 기본값을 한 번 설정하고 에이전트별로 재정의할 수 있습니다).

예: 두 개의 에이전트, 두 번째 에이전트만 하트비트를 실행합니다.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### 활동 시간의 예

특정 시간대의 업무 시간으로 하트비트를 제한합니다.

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
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

이 기간 외부(동부 표준시 기준 오전 9시 이전 또는 오후 10시 이후)에는 하트비트가 건너뜁니다. 창 내부의 다음 예정된 틱은 정상적으로 실행됩니다.

### 다중 계정 예시

Telegram과 같은 다중 계정 채널에서 특정 계정을 타겟팅하려면 `accountId`를 사용하세요.

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
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

### 필드 노트

- `every`: 하트비트 간격(기간 문자열; 기본 단위 = 분).
- `model`: 하트비트 실행에 대한 선택적 모델 재정의(`provider/model`).
- `includeReasoning`: 활성화되면 별도의 `Reasoning:` 메시지도 전달합니다(`/reasoning on`와 같은 모양).
- `session`: 하트비트 실행을 위한 선택적 세션 키입니다.
  - `main` (기본값): 에이전트 기본 세션입니다.
  - 명시적 세션 키(`openclaw sessions --json` 또는 [세션 CLI](/cli/sessions)에서 복사).
  - 세션 키 형식: [세션](/concepts/session) 및 [그룹](/channels/groups)을 참조하세요.
- `target`:
  - `last` (기본값): 마지막으로 사용한 외부 채널로 전달합니다.
  - 명시적 채널: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: 하트비트를 실행하지만 외부로 **전달하지 않습니다**.
- `to`: 선택적 수신자 재정의(채널별 ID, 예: WhatsApp의 경우 E.164 또는 Telegram 채팅 ID).
- `accountId`: 다중 계정 채널의 선택적 계정 ID입니다. `target: "last"`인 경우, 계정을 지원하는 경우 계정 ID는 해결된 마지막 채널에 적용됩니다. 그렇지 않으면 무시됩니다. 계정 ID가 확인된 채널에 대해 구성된 계정과 일치하지 않으면 전달을 건너뜁니다.
- `prompt`: 기본 프롬프트 본문을 재정의합니다(병합되지 않음).
- `ackMaxChars`: 배송 전 `HEARTBEAT_OK` 뒤에 허용되는 최대 문자 수입니다.
- `activeHours`: 하트비트 실행을 시간 창으로 제한합니다. `start`(HH:MM, 포함), `end`(HH:MM 제외, `24:00` 하루 종료 시 허용) 및 선택 사항인 `timezone`가 포함된 개체입니다.
  - 생략 또는 `"user"`: 설정된 경우 `agents.defaults.userTimezone`를 사용하고, 그렇지 않으면 호스트 시스템 시간대로 대체합니다.
  - `"local"`: 항상 호스트 시스템 시간대를 사용합니다.
  - 모든 IANA 식별자(예: `America/New_York`): 직접 사용됩니다. 유효하지 않은 경우 위의 `"user"` 동작으로 돌아갑니다.
  - 활성 창 외부에서는 창 내부의 다음 틱까지 하트비트를 건너뜁니다.

## 배송 행동

- 하트비트는 기본적으로 에이전트의 기본 세션에서 실행됩니다(`agent:<id>:<mainKey>`).
  또는 `global` 일 때 `session.scope = "global"`. `session`를 설정하여 다음으로 재정의합니다.
  특정 채널 세션(Discord/WhatsApp 등).
- `session`는 실행 컨텍스트에만 영향을 미칩니다. 배송은 `target` 및 `to`에 의해 제어됩니다.
- 특정 채널/수신자에게 전달하려면 `target` + `to`를 설정하세요. 와
  `target: "last"`, 전달은 해당 세션의 마지막 외부 채널을 사용합니다.
- 기본 대기열이 사용 중인 경우 하트비트를 건너뛰고 나중에 다시 시도합니다.
- `target`가 외부 대상으로 확인되지 않은 경우에도 실행은 발생하지만 실행되지 않습니다.
  아웃바운드 메시지가 전송됩니다.
- 하트비트 전용 응답은 세션을 활성 상태로 유지 **하지 않습니다**. 마지막 `updatedAt`
  복원되어 유휴 만료가 정상적으로 작동합니다.

## 가시성 제어

기본적으로 `HEARTBEAT_OK` 확인은 경고 내용이 표시되는 동안 억제됩니다.
배달되었습니다. 채널별 또는 계정별로 이를 조정할 수 있습니다.

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

우선순위: 계정별 → 채널별 → 채널 기본값 → 내장 기본값.

### 각 플래그의 기능

- `showOk`: 모델이 OK-only 응답을 반환하면 `HEARTBEAT_OK` 승인을 보냅니다.
- `showAlerts`: 모델이 OK가 아닌 응답을 반환하면 경고 내용을 보냅니다.
- `useIndicator`: UI 상태 표면에 대한 표시기 이벤트를 내보냅니다.

**세 가지 모두** 거짓인 경우 OpenClaw는 하트비트 실행을 완전히 건너뜁니다(모델 호출 없음).

### 채널별 vs 계정별 예시

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### 일반적인 패턴

| 목표                                | 구성                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| 기본 동작(자동 확인, 경고 켜짐)     | _(구성이 필요하지 않음)_                                                                 |
| 완전 무음(메시지 없음, 표시기 없음) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| 표시기 전용(메시지 없음)            | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| 한 채널에서만 OK                    | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (선택사항)

작업공간에 `HEARTBEAT.md` 파일이 존재하는 경우 기본 프롬프트는
상담원이 읽어 보세요. 이를 작고 안정적이며 "심장박동 체크리스트"로 생각하십시오.
30분마다 포함하는 것이 안전합니다.

`HEARTBEAT.md`가 존재하지만 실질적으로 비어 있는 경우(빈 줄과 마크다운만 해당)
`# Heading`)와 같은 헤더를 사용하면 OpenClaw는 API 호출을 저장하기 위해 하트비트 실행을 건너뜁니다.
파일이 누락된 경우에도 하트비트는 계속 실행되며 모델이 수행할 작업을 결정합니다.

즉각적인 부풀림을 방지하려면 작게 유지하십시오(짧은 체크리스트 또는 알림).

예시 `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### 에이전트가 HEARTBEAT.md를 업데이트할 수 있나요?

예 — 요청하시면 가능합니다.

`HEARTBEAT.md`는 에이전트 작업공간에 있는 일반 파일이므로,
상담원(일반 채팅에서)은 다음과 같습니다.

- “일일 달력 확인을 추가하려면 `HEARTBEAT.md`을 업데이트하세요.”
- "`HEARTBEAT.md`를 다시 작성하여 더 짧게 작성하고 받은 편지함 후속 작업에 집중하도록 하세요."

이 작업이 사전에 수행되도록 하려면
하트비트 메시지는 다음과 같습니다. “체크리스트가 오래되면 HEARTBEAT.md를 업데이트하세요.
더 나은 것으로.”

안전 참고사항: 비밀번호(API 키, 전화번호, 개인 토큰)를 입력하지 마세요.
`HEARTBEAT.md` — 프롬프트 컨텍스트의 일부가 됩니다.

## 수동 깨우기(요청 시)

다음을 사용하여 시스템 이벤트를 대기열에 추가하고 즉시 하트비트를 트리거할 수 있습니다.

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

여러 에이전트가 `heartbeat` 구성되어 있는 경우 수동 깨우기는 각 에이전트를 실행합니다.
에이전트는 즉시 하트비트를 보냅니다.

다음 예정된 틱을 기다리려면 `--mode next-heartbeat`를 사용하세요.

## 추론 전달(선택)

기본적으로 하트비트는 최종 "답변" 페이로드만 전달합니다.

투명성을 원하면 다음을 활성화하십시오.

- `agents.defaults.heartbeat.includeReasoning: true`

활성화되면 하트비트는 접두사가 붙은 별도의 메시지도 전달합니다.
`Reasoning:` (`/reasoning on`와 같은 모양). 이는 상담원이
여러 세션/코덱스를 관리하고 있는데 왜 ping을 결정했는지 알고 싶습니다.
하지만 원하는 것보다 더 많은 내부 세부 정보가 유출될 수도 있습니다. 보관하는 것을 선호함
그룹 채팅에서 꺼집니다.

## 비용 인식

하트비트는 전체 에이전트 회전을 실행합니다. 간격이 짧을수록 더 많은 토큰이 소모됩니다. 유지하다
`HEARTBEAT.md` 작고 더 저렴한 `model` 또는 `target: "none"`를 고려하십시오.
내부 상태 업데이트만 원합니다.
