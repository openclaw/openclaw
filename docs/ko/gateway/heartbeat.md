---
summary: "Heartbeat 폴링 메시지 및 알림 규칙"
read_when:
  - Heartbeat 주기 또는 메시지를 조정할 때
  - 예약 작업에 Heartbeat 와 cron 중 무엇을 사용할지 결정할 때
title: "Heartbeat"
---

# Heartbeat (Gateway(게이트웨이))

> **Heartbeat vs Cron?** 각각을 언제 사용해야 하는지에 대한 안내는 [Cron vs Heartbeat](/automation/cron-vs-heartbeat)를 참고하십시오.

Heartbeat 는 메인 세션에서 **주기적인 에이전트 턴**을 실행하여,
모델이 주의를 기울여야 할 사항을 과도한 알림 없이 표시할 수 있도록 합니다.

문제 해결: [/automation/troubleshooting](/automation/troubleshooting)

## 빠른 시작 (초보자)

1. Heartbeat 를 활성화된 상태로 유지합니다 (기본값은 `30m`, Anthropic OAuth/setup-token 의 경우 `1h`) 또는 원하는 주기를 설정합니다.
2. 에이전트 워크스페이스에 작은 `HEARTBEAT.md` 체크리스트를 생성합니다 (선택 사항이지만 권장).
3. Heartbeat 메시지를 보낼 위치를 결정합니다 (기본값은 `target: "last"`).
4. 선택 사항: 투명성을 위해 Heartbeat 추론 전달을 활성화합니다.
5. 선택 사항: Heartbeat 를 활성 시간 (로컬 시간)으로 제한합니다.

예시 설정:

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

- 간격: `30m` (Anthropic OAuth/setup-token 이 감지된 인증 모드인 경우 `1h`). 전역으로는 `agents.defaults.heartbeat.every` 를, 에이전트별로는 `agents.list[].heartbeat.every` 를 설정합니다. 비활성화하려면 `0m` 를 사용합니다.
- 프롬프트 본문 (`agents.defaults.heartbeat.prompt` 를 통해 구성 가능):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- Heartbeat 프롬프트는 사용자 메시지로 **그대로** 전송됩니다. 시스템
  프롬프트에는 “Heartbeat” 섹션이 포함되며 실행은 내부적으로 플래그 처리됩니다.
- 활성 시간 (`heartbeat.activeHours`)은 구성된 타임존에서 확인됩니다.
  해당 시간대 밖에서는 다음 활성 시간 내 틱까지 Heartbeat 가 건너뛰어집니다.

## Heartbeat 프롬프트의 용도

기본 프롬프트는 의도적으로 포괄적입니다.

- **백그라운드 작업**: “미완료 작업을 고려”는 에이전트가
  후속 작업 (수신함, 캘린더, 리마인더, 대기 작업)을 검토하고 긴급한 항목을 표시하도록 유도합니다.
- **사람 확인**: “낮 시간대에 가끔 사람에게 체크인”은
  가벼운 “필요한 것이 있나요?” 메시지를 유도하지만,
  구성된 로컬 타임존을 사용하여 야간 스팸을 피합니다 (참고: [/concepts/timezone](/concepts/timezone)).

Heartbeat 가 매우 구체적인 작업을 수행하길 원한다면 (예: “Gmail PubSub 통계 확인” 또는 “게이트웨이 상태 확인”),
`agents.defaults.heartbeat.prompt` (또는 `agents.list[].heartbeat.prompt`)에 사용자 정의 본문을 설정하십시오 (그대로 전송됨).

## 응답 계약

- 주의가 필요하지 않다면 **`HEARTBEAT_OK`** 로 응답합니다.
- Heartbeat 실행 중에는, OpenClaw 가 `HEARTBEAT_OK` 를
  응답의 **시작 또는 끝**에 표시될 경우 확인(ack)으로 처리합니다. 해당 토큰은 제거되며, 남은 내용이 **≤ `ackMaxChars`** (기본값: 300)인 경우 응답은 폐기됩니다.
- `HEARTBEAT_OK` 가 응답의 **중간**에 나타나면 특별 취급되지 않습니다.
- 알림의 경우 `HEARTBEAT_OK` 를 **포함하지 말고** 알림 텍스트만 반환하십시오.

Heartbeat 외의 경우, 메시지 시작/끝에 있는 `HEARTBEAT_OK` 는 제거되어 기록되며,
메시지가 `HEARTBEAT_OK` 만으로 구성된 경우 폐기됩니다.

## 설정

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

- `agents.defaults.heartbeat` 는 전역 Heartbeat 동작을 설정합니다.
- `agents.list[].heartbeat` 는 그 위에 병합됩니다. 어떤 에이전트든 `heartbeat` 블록이 있으면 **해당 에이전트만** Heartbeat 를 실행합니다.
- `channels.defaults.heartbeat` 는 모든 채널의 가시성 기본값을 설정합니다.
- `channels.<channel>.heartbeat` 는 채널 기본값을 재정의합니다.
- `channels.<channel>.accounts.<id>.heartbeat` (다중 계정 채널) 는 채널별 설정을 재정의합니다.

### 에이전트별 Heartbeat

어떤 `agents.list[]` 항목이든 `heartbeat` 블록을 포함하면,
**해당 에이전트만** Heartbeat 를 실행합니다. 에이전트별 블록은 `agents.defaults.heartbeat` 위에 병합됩니다
(공통 기본값을 한 번 설정하고 에이전트별로 재정의할 수 있습니다).

예시: 두 개의 에이전트 중 두 번째 에이전트만 Heartbeat 를 실행합니다.

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

### 활성 시간 예시

특정 타임존에서 업무 시간으로 Heartbeat 를 제한합니다.

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

이 창 (동부 시간 기준 오전 9시 이전 또는 오후 10시 이후) 밖에서는 Heartbeat 가 건너뛰어집니다. 다음으로 활성 시간 내에 도달하는 예약 틱에서 정상적으로 실행됩니다.

### 다중 계정 예시

Telegram 과 같은 다중 계정 채널에서 특정 계정을 대상으로 하려면 `accountId` 를 사용합니다.

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

- `every`: Heartbeat 간격 (지속 시간 문자열; 기본 단위 = 분).
- `model`: Heartbeat 실행 시 선택적 모델 재정의 (`provider/model`).
- `includeReasoning`: 활성화 시, 사용 가능할 때 별도의 `Reasoning:` 메시지도 전달합니다 (`/reasoning on` 와 동일한 형태).
- `session`: Heartbeat 실행을 위한 선택적 세션 키.
  - `main` (기본값): 에이전트 메인 세션.
  - 명시적 세션 키 (`openclaw sessions --json` 또는 [sessions CLI](/cli/sessions)에서 복사).
  - 세션 키 형식: [Sessions](/concepts/session) 및 [Groups](/channels/groups) 참고.
- `target`:
  - `last` (기본값): 마지막으로 사용된 외부 채널로 전달합니다.
  - 명시적 채널: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: Heartbeat 는 실행하지만 외부로 **전달하지 않습니다**.
- `to`: 선택적 수신자 재정의 (채널별 id, 예: WhatsApp 의 E.164 또는 Telegram 채팅 id).
- `accountId`: 다중 계정 채널을 위한 선택적 계정 id. `target: "last"` 인 경우,
  계정 id 는 계정을 지원하는 경우에만 해석된 마지막 채널에 적용되며, 그렇지 않으면 무시됩니다. 계정 id 가 해석된 채널에 구성된 계정과 일치하지 않으면 전달은 건너뛰어집니다.
- `prompt`: 기본 프롬프트 본문을 재정의합니다 (병합되지 않음).
- `ackMaxChars`: `HEARTBEAT_OK` 이후 전달 전까지 허용되는 최대 문자 수.
- `activeHours`: Heartbeat 실행을 시간 창으로 제한합니다. `start` (HH:MM, 포함), `end` (HH:MM, 제외; 일 종료를 위한 `24:00` 허용), 선택적 `timezone` 를 포함하는 객체입니다.
  - 생략되거나 `"user"`: 설정된 `agents.defaults.userTimezone` 가 있으면 이를 사용하고, 없으면 호스트 시스템 타임존으로 대체합니다.
  - `"local"`: 항상 호스트 시스템 타임존을 사용합니다.
  - 임의의 IANA 식별자 (예: `America/New_York`): 직접 사용되며, 유효하지 않으면 위의 `"user"` 동작으로 대체됩니다.
  - 활성 창 밖에서는 다음 활성 시간 내 틱까지 Heartbeat 가 건너뛰어집니다.

## 전달 동작

- Heartbeat 는 기본적으로 에이전트의 메인 세션에서 실행됩니다 (`agent:<id>:<mainKey>`),
  또는 `session.scope = "global"` 인 경우 `global` 에서 실행됩니다. 특정 채널 세션 (Discord/WhatsApp 등)으로 재정의하려면 `session` 를 설정하십시오.
- `session` 는 실행 컨텍스트에만 영향을 주며, 전달은 `target` 및 `to` 로 제어됩니다.
- 특정 채널/수신자로 전달하려면 `target` + `to` 를 설정하십시오. `target: "last"` 를 사용하면 해당 세션의 마지막 외부 채널을 사용하여 전달됩니다.
- 메인 큐가 바쁜 경우 Heartbeat 는 건너뛰어지며 나중에 재시도됩니다.
- `target` 가 외부 대상이 없는 것으로 해석되면, 실행은 수행되지만
  외부로 전송되는 메시지는 없습니다.
- Heartbeat 전용 응답은 세션을 유지하지 않습니다. 마지막 `updatedAt` 가 복원되어 유휴 만료가 정상적으로 동작합니다.

## 가시성 제어

기본적으로 `HEARTBEAT_OK` 확인(ack)은 억제되고 알림 콘텐츠만 전달됩니다. 채널별 또는 계정별로 이를 조정할 수 있습니다.

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

### 각 플래그의 동작

- `showOk`: 모델이 OK 전용 응답을 반환할 때 `HEARTBEAT_OK` 확인을 전송합니다.
- `showAlerts`: 모델이 비 OK 응답을 반환할 때 알림 콘텐츠를 전송합니다.
- `useIndicator`: UI 상태 표시를 위한 인디케이터 이벤트를 발생시킵니다.

**세 가지 모두** false 인 경우, OpenClaw 는 Heartbeat 실행을 완전히 건너뜁니다 (모델 호출 없음).

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

| 목표                                          | 설정                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 기본 동작 (OK 는 무음, 알림은 전달)  | _(설정 불필요)_                                                            |
| 완전 무음 (메시지 없음, 인디케이터 없음) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| 인디케이터 전용 (메시지 없음)        | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| 한 채널에서만 OK 전달                               | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (선택 사항)

워크스페이스에 `HEARTBEAT.md` 파일이 존재하면, 기본 프롬프트는
에이전트에게 해당 파일을 읽도록 지시합니다. 이를 “Heartbeat 체크리스트”로 생각하십시오. 작고, 안정적이며,
30 분마다 포함해도 안전해야 합니다.

`HEARTBEAT.md` 가 존재하지만 사실상 비어 있는 경우
(빈 줄과 `# Heading` 와 같은 마크다운 헤더만 있는 경우),
OpenClaw 는 API 호출을 절약하기 위해 Heartbeat 실행을 건너뜁니다.
파일이 없으면 Heartbeat 는 계속 실행되며 모델이 수행할 작업을 결정합니다.

프롬프트 비대화를 피하기 위해 짧게 (간단한 체크리스트 또는 리마인더) 유지하십시오.

예시 `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### 에이전트가 HEARTBEAT.md 를 업데이트할 수 있나요?

네 — 요청하면 가능합니다.

`HEARTBEAT.md` 는 에이전트 워크스페이스의 일반 파일이므로,
일반 채팅에서 다음과 같이 지시할 수 있습니다.

- “`HEARTBEAT.md` 를 업데이트하여 일일 캘린더 확인을 추가하세요.”
- “`HEARTBEAT.md` 를 더 짧고 수신함 후속 작업에 집중하도록 다시 작성하세요.”

이를 사전에 수행하도록 하려면, Heartbeat 프롬프트에
“체크리스트가 오래되면 HEARTBEAT.md 를 더 나은 내용으로 업데이트하라”와 같은
명시적인 문장을 포함할 수도 있습니다.

안전 참고: 비밀 정보 (API 키, 전화번호, 개인 토큰)를
`HEARTBEAT.md` 에 넣지 마십시오. 프롬프트 컨텍스트의 일부가 됩니다.

## 수동 웨이크 (온디맨드)

다음으로 시스템 이벤트를 큐에 넣어 즉시 Heartbeat 를 트리거할 수 있습니다.

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

여러 에이전트에 `heartbeat` 가 구성되어 있으면,
수동 웨이크는 해당 에이전트들의 Heartbeat 를 즉시 각각 실행합니다.

다음 예약 틱을 기다리려면 `--mode next-heartbeat` 를 사용하십시오.

## 추론 전달 (선택 사항)

기본적으로 Heartbeat 는 최종 “답변” 페이로드만 전달합니다.

투명성을 원한다면 다음을 활성화하십시오.

- `agents.defaults.heartbeat.includeReasoning: true`

활성화되면, Heartbeat 는
`Reasoning:` 로 접두된 별도의 메시지도 전달합니다
(`/reasoning on` 와 동일한 형태). 에이전트가 여러 세션/코덱스를 관리하며
왜 알림을 보냈는지 확인하고 싶을 때 유용하지만,
원치 않는 내부 정보가 노출될 수 있습니다. 그룹 채팅에서는 비활성화를 권장합니다.

## 비용 고려

Heartbeat 는 전체 에이전트 턴을 실행합니다. 짧은 간격일수록 토큰 소모가 증가합니다. `HEARTBEAT.md` 를 작게 유지하고,
내부 상태 업데이트만 필요하다면 더 저렴한 `model` 또는 `target: "none"` 를 고려하십시오.
