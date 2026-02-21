---
summary: "Heartbeat 폴링 메시지 및 알림 규칙"
read_when:
  - Heartbeat 주기 또는 메시지를 조정
  - 예약 작업에 대해 Heartbeat와 cron 중 결정
title: "Heartbeat"
---

# Heartbeat (게이트웨이)

> **Heartbeat vs Cron?** 각 사용 경우에 대한 지침은 [Cron vs Heartbeat](/ko-KR/automation/cron-vs-heartbeat)을 참조하세요.

Heartbeat는 메인 세션에서 **주기적인 에이전트 턴**을 실행하여 스팸 없이 주의를 기울일 필요가 있는 모든 것을 모델이 표면에 드러낼 수 있도록 합니다.

문제 해결: [/automation/troubleshooting](/ko-KR/automation/troubleshooting)

## 빠른 시작 (초보자)

1. Heartbeat를 활성화 상태로 유지합니다 (기본값은 `30m`, 또는 Anthropic OAuth/설치 토큰의 경우 `1h`) 또는 직접 주기를 설정합니다.
2. 에이전트 작업 공간에 작은 `HEARTBEAT.md` 체크리스트를 만듭니다 (선택 사항이지만 권장됨).
3. Heartbeat 메시지가 어디로 갈지 결정합니다 (`target: "last"`는 기본값입니다).
4. 선택 사항: 투명성을 위해 Heartbeat 추론 전달을 활성화합니다.
5. 선택 사항: 활동 시간을 로컬 시간으로 제한합니다.

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

- 간격: `30m` (또는 Anthropic OAuth/설치 토큰이 감지된 인증 모드일 때는 `1h`). `agents.defaults.heartbeat.every` 또는 에이전트별 `agents.list[].heartbeat.every`를 설정합니다; `0m`을 사용하여 비활성화합니다.
- 프롬프트 본문 (개인 설정 가능 `agents.defaults.heartbeat.prompt`):
  `HEARTBEAT.md가 존재하는 경우 읽기 (작업 공간 컨텍스트). 이를 엄격히 따르십시오. 이전 대화에서 이전 작업을 유추하거나 반복하지 마십시오. 주의가 필요하지 않은 경우, HEARTBEAT_OK로 응답하십시오.`
- Heartbeat 프롬프트는 **문자 그대로** 사용자 메시지로 전송됩니다. 시스템
  프롬프트에는 "Heartbeat" 섹션이 포함되며 런이 내부적으로 플래그 처리됩니다.
- 활동 시간 (`heartbeat.activeHours`)은 구성된 시간대에서 확인됩니다.
  창 밖에서는, Heartbeat가 다음 창 안의 틱까지 건너뜁니다.

## Heartbeat 프롬프트의 목적

기본 프롬프트는 의도적으로 폭넓게 구성되어 있습니다:

- **배경 작업**: “미결 과제 고려하기”는 에이전트가 다음 작업 목록(메일, 일정, 알림, 대기 작업)을 검토하고 긴급한 사항을 표시하도록 유도합니다.
- **인간 체크인**: “주간에 인간 확인”은 가끔 가벼운 "필요한 것 있습니까?" 메시지를 유도하되 로컬 시간대를 설정하여 야간 스팸을 피합니다 (자세한 내용은 [/concepts/timezone](/ko-KR/concepts/timezone)).

Heartbeat가 특정 작업을 수행하도록 원한다면 (예: “Gmail PubSub 통계 확인” 또는 “게이트웨이 상태 검증”), `agents.defaults.heartbeat.prompt` (또는 `agents.list[].heartbeat.prompt`)를 사용자 정의 본문으로 설정합니다 (문자 그대로 전송).

## 응답 계약

- 주의가 필요하지 않은 경우, **`HEARTBEAT_OK`**로 응답합니다.
- Heartbeat가 실행되는 동안, OpenClaw는 응답의 **시작 또는 끝**에 `HEARTBEAT_OK`가 나타날 때 이를 승인으로 처리합니다. 토큰이 제거되고 남은 내용이 **≤ `ackMaxChars`** (기본값: 300)인 경우 응답은 삭제됩니다.
- `HEARTBEAT_OK`가 응답의 **중간**에 나타날 경우, 특별히 처리되지 않습니다.
- 경고의 경우, **`HEARTBEAT_OK`**를 포함하지 않습니다; 경고 텍스트만 반환합니다.

Heartbeat 외부에서는, 메시지의 시작/끝에 있는 불필요한 `HEARTBEAT_OK`는 제거되고 기록됩니다; 메시지가 오직 `HEARTBEAT_OK`인 경우 삭제됩니다.

## 설정

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // 기본값: 30m (0m 비활성화)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // 기본값: false (사용 가능한 경우 별도의 Reasoning: 메시지 전달)
        target: "last", // last | none | <채널 id> (코어 또는 플러그인, 예: "bluebubbles")
        to: "+15551234567", // 선택적인 채널-특정 오버라이드
        accountId: "ops-bot", // 선택적 멀티-계정 채널 id
        prompt: "HEARTBEAT.md가 존재하는 경우 읽기 (작업 공간 컨텍스트). 이를 엄격히 따르십시오. 이전 대화에서 이전 작업을 유추하거나 반복하지 마십시오. 주의가 필요하지 않은 경우, HEARTBEAT_OK로 응답하십시오.",
        ackMaxChars: 300, // HEARTBEAT_OK 후 허용되는 최대 문자 수
      },
    },
  },
}
```

### 범위와 우선순위

- `agents.defaults.heartbeat`는 글로벌 Heartbeat 동작을 설정합니다.
- `agents.list[].heartbeat`는 상위로 통합됩니다; 어떤 에이전트가 `heartbeat` 블록을 가지면, **해당 에이전트만** Heartbeats를 실행합니다.
- `channels.defaults.heartbeat`는 모든 채널의 가시성 기본값을 설정합니다.
- `channels.<channel>.heartbeat`는 채널 기본값을 재정의합니다.
- `channels.<channel>.accounts.<id>.heartbeat` (멀티-계정 채널)은 채널 설정을 재정의합니다.

### 에이전트별 Heartbeat

어떤 `agents.list[]` 항목에 `heartbeat` 블록이 포함된 경우, **해당 에이전트만** Heartbeats를 실행합니다. 에이전트별 블록은 `agents.defaults.heartbeat` 위에 통합됩니다 (따라서 공유 기본값을 한 번 설정하고 에이전트별로 재정의할 수 있습니다).

예제: 두 개의 에이전트 중, 두 번째 에이전트만 Heartbeats를 실행합니다.

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
          prompt: "HEARTBEAT.md가 존재하는 경우 읽기 (작업 공간 컨텍스트). 이를 엄격히 따르십시오. 이전 대화에서 이전 작업을 유추하거나 반복하지 마십시오. 주의가 필요하지 않은 경우, HEARTBEAT_OK로 응답하십시오.",
        },
      },
    ],
  },
}
```

### 활동 시간의 예시

특정 시간대의 업무 시간에 Heartbeats를 제한합니다:

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
          timezone: "America/New_York", // 선택적; 사용자 시간대가 설정된 경우 이를 사용하고, 그렇지 않을 경우 호스트 시간대를 사용
        },
      },
    },
  },
}
```

이 창 밖(오전 9시 이전 또는 오후 10시 이후 동부 시간)에서는 Heartbeat가 건너뛰어집니다. 창 안의 다음 예약된 틱은 정상적으로 실행됩니다.

### 24시간 설정

Heartbeat를 하루 종일 실행하고 싶다면 다음 패턴 중 하나를 사용하세요:

- `activeHours`를 완전히 생략합니다 (시간 창 제한 없음; 이것이 기본 동작입니다).
- 전체 하루 창을 설정합니다: `activeHours: { start: "00:00", end: "24:00" }`.

`start`와 `end`를 같은 시간으로 설정하지 마세요 (예: `08:00`부터 `08:00`).
이는 폭이 0인 창으로 처리되어 Heartbeat가 항상 건너뛰어집니다.

### 멀티 계정의 예시

`accountId`를 사용하여 Telegram과 같은 멀티-계정 채널의 특정 계정을 대상으로 합니다:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678:topic:42", // 선택적: 특정 토픽/스레드로 라우팅
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

- `every`: Heartbeat 간격 (기간 문자열; 기본 단위 = 분).
- `model`: Heartbeat 실행을 위한 선택적 모델 오버라이드 (`provider/model`).
- `includeReasoning`: 활성화된 경우, 사용 가능한 경우 별도의 `Reasoning:` 메시지를 전달 (동일한 형태 `/reasoning on`).
- `session`: Heartbeat 실행을 위한 선택적 세션 키.
  - `main` (기본값): 에이전트 메인 세션.
  - 명시적 세션 키 (`openclaw sessions --json`이나 [sessions CLI](/ko-KR/cli/sessions)에서 복사).
  - 세션 키 형식: [Sessions](/ko-KR/concepts/session) 및 [Groups](/ko-KR/channels/groups) 참조.
- `target`:
  - `last` (기본값): 마지막으로 사용된 외부 채널로 전달.
  - 명시적 채널: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: Heartbeat를 실행하되, 외부로 **전달하지 않음**.
- `to`: 선택적인 수신자 오버라이드 (채널-특정 id, 예: WhatsApp의 E.164 또는 Telegram 채팅 id). Telegram 토픽/스레드의 경우 `<chatId>:topic:<messageThreadId>` 형식을 사용하세요.
- `accountId`: 멀티-계정 채널을 위한 선택적 계정 id. `target: "last"`일 때, 계정 id는 계정을 지원하는 해석된 마지막 채널에 적용됩니다; 그렇지 않으면 무시됩니다. 계정 id가 해석된 채널의 구성된 계정과 일치하지 않으면, 전달이 건너뛰어집니다.
- `prompt`: 기본 프롬프트 본문을 재정의합니다 (병합되지 않음).
- `ackMaxChars`: 전달 전 `HEARTBEAT_OK` 후 허용되는 최대 문자 수.
- `suppressToolErrorWarnings`: true일 경우, Heartbeat 실행 중 도구 에러 경고 페이로드를 억제합니다.
- `activeHours`: Heartbeat 실행을 시간 창으로 제한. `start` (HH:MM, 포함; 하루 시작은 `00:00` 사용), `end` (HH:MM 제외; `24:00`은 하루의 끝까지 허용), 그리고 선택적 `timezone`을 가진 객체.
  - 생략되었거나 `"user"`: 설정된 경우 `agents.defaults.userTimezone`를 사용합니다; 그렇지 않을 경우 호스트 시스템 시간대를 기본으로 사용합니다.
  - `"local"`: 항상 호스트 시스템 시간대를 사용합니다.
  - 모든 IANA 식별자 (예: `America/New_York`): 직접 사용됨; 유효하지 않은 경우 위의 `"user"` 동작으로 대체됩니다.
  - `start`와 `end`는 활성 창이 되려면 같아서는 안 됩니다; 같은 값은 폭이 0인 창(항상 창 밖)으로 처리됩니다.
  - 활동 창 밖에서는, Heartbeat가 다음 창 안쪽의 틱까지 건너뜁니다.

## 전달 동작

- 기본적으로 Heartbeat는 에이전트의 메인 세션에서 실행됩니다 (`agent:<id>:<mainKey>`),
  또는 `session.scope = "global"`일 때는 `global`. 특정 채널 세션으로 변경하려면 `session`을 설정합니다 (Discord/WhatsApp/등등).
- `session`는 실행 컨텍스트에만 영향을 미칩니다; 전달은 `target`과 `to`에 의해 제어됩니다.
- 특정 채널/수신자에게 전달하려면, `target` + `to`를 설정합니다. `target: "last"`로 설정할 경우, 해당 세션의 마지막 외부 채널로 전달됩니다.
- 메인 큐가 바쁠 경우, Heartbeat는 건너뛰어지고 나중에 다시 시도됩니다.
- `target`이 외부 목표로 해석되지 않으면, 실행은 여전히 발생하지만 아웃바운드 메시지는 전송되지 않습니다.
- Heartbeat 전용 응답은 **세션을 유지**하지 않습니다; 마지막 `updatedAt`이 복원되어 유휴 만료가 정상적으로 작동합니다.

## 가시성 제어

기본적으로 `HEARTBEAT_OK` 확인은 억제되며 경고 내용이 전달됩니다. 채널 또는 계정별로 이를 조정할 수 있습니다:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # HEARTBEAT_OK 숨기기 (기본값)
      showAlerts: true # 경고 메시지 표시 (기본값)
      useIndicator: true # 표시기 이벤트 생성 (기본값)
  telegram:
    heartbeat:
      showOk: true # Telegram에서 OK 확인 표시
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # 이 계정을 위한 경고 전달 억제
```

우선순위: 계정별 → 채널별 → 채널 기본값 → 내장 기본값.

### 각 플래그의 기능

- `showOk`: 모델이 OK-전용 응답을 반환할 때 `HEARTBEAT_OK` 확인을 보냅니다.
- `showAlerts`: 모델이 OK가 아닌 응답을 반환할 때 경고 내용을 보냅니다.
- `useIndicator`: UI 상태 표면을 위한 표시기 이벤트를 생성합니다.

**세 가지 모두**가 false일 경우, OpenClaw는 Heartbeat 실행을 건너뜁니다 (모델 호출 없음).

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
      showOk: true # 모든 Slack 계정
    accounts:
      ops:
        heartbeat:
          showAlerts: false # ops 계정에 대한 경고 억제
  telegram:
    heartbeat:
      showOk: true
```

### 일반 패턴

| 목표                                   | 설정                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| 기본 동작 (조용한 OK, 경고 표시)       | _(구성 필요 없음)_                                                                       |
| 완전히 조용 (메시지 없음, 표시기 없음) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| 표시기 전용 (메시지 없음)              | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| 한 채널에서만 OK 표시                  | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (선택 사항)

작업 공간에 `HEARTBEAT.md` 파일이 있으면, 기본 프롬프트는 에이전트에게 이를 읽도록 지시합니다. 이를 "heartbeat 체크리스트"로 생각하십시오: 작고 안정적이며 매 30분마다 안전하게 포함할 수 있습니다.

`HEARTBEAT.md`가 존재하지만 사실상 비어 있으면 (빈 줄과 `# Heading`과 같은 마크다운 헤더만 있을 경우), OpenClaw는 API 호출을 절약하기 위해 Heartbeat 실행을 건너뜁니다. 파일이 없으면, Heartbeat는 여전히 실행되며 모델이 무엇을 할지 결정합니다.

프롬프트 부담을 피하기 위해 작게 유지하십시오 (짧은 체크리스트 또는 알림).

예시 `HEARTBEAT.md`:

```md
# Heartbeat 체크리스트

- 빠른 스캔: 메일함에 긴급한 일이 있습니까?
- 주간이라면, 다른 대기 작업이 없을 경우 가벼운 체크인을 수행하십시오.
- 작업이 차단된 경우, _무엇이 필요한지_ 적어두고 다음에 Peter에게 문의하십시오.
```

### 에이전트가 HEARTBEAT.md를 업데이트할 수 있습니까?

예 — 요청하면 가능합니다.

`HEARTBEAT.md`는 에이전트 작업 공간의 일반 파일이므로 에이전트에게 (일반 채팅에서) 다음과 같이 요청할 수 있습니다:

- "매일 일정 확인을 추가하기 위해 `HEARTBEAT.md`를 업데이트하세요."
- "`HEARTBEAT.md`를 더 짧고 받은 편지함 후속 작업에 초점을 맞춰 다시 작성하세요."

이 작업을 주도적으로 수행하고 싶다면, Heartbeat 프롬프트에 명시적으로 포함할 수도 있습니다: "체크리스트가 오래되었을 경우, 더 나은 내용으로 HEARTBEAT.md를 업데이트하세요."

안전 메모: 비밀을 포함시키지 마십시오 (API 키, 전화번호, 개인 토큰) — 이는 프롬프트 컨텍스트의 일부가 됩니다.

## 수동 웨이크 (주문형)

시스템 이벤트를 큐에 넣고 즉시 Heartbeat를 트리거할 수 있습니다:

```bash
openclaw system event --text "긴급한 후속 조치를 확인하세요" --mode now
```

다수의 에이전트가 `heartbeat`로 구성된 경우, 수동 웨이크가 해당 에이전트의 Heartbeat를 즉시 실행합니다.

`--mode next-heartbeat`를 사용하여 다음 예약 틱을 기다립니다.

## 추론 전달 (선택 사항)

기본적으로 Heartbeat는 최종 "답변" 페이로드만 전달합니다.

투명성을 원한다면, 활성화하세요:

- `agents.defaults.heartbeat.includeReasoning: true`

활성화될 경우, Heartbeat는 `Reasoning:` 접두어가 붙은 별도의 메시지도 전달합니다 (동일한 형태 `/reasoning on`). 이는 에이전트가 여러 세션/코덱스를 관리할 때 매우 유용할 수 있으며, 왜 당신이 핑을 받았는지를 볼 수 있게 해주지만, 원하지 않는 더 많은 내부 정보를 노출시킬 수 있습니다. 그룹 채팅에서는 비활성 상태로 유지하는 것이 좋습니다.

## 비용 인식

Heartbeats는 전체 에이전트 턴을 실행합니다. 짧은 간격은 더 많은 토큰을 소모합니다. `HEARTBEAT.md`를 작게 유지하고 더 저렴한 `model`을 고려하거나 `target: "none"`을 사용하여 내부 상태 업데이트만 원하는 경우를 대비하세요.
