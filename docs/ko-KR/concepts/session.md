---
summary: "챗 대화에 대한 세션 관리 규칙, 키, 지속성"
read_when:
  - 세션 처리 또는 저장소 수정
title: "세션 관리"
---

# 세션 관리

OpenClaw는 **하나의 다이렉트 챗 세션을 에이전트 별로** 기본값으로 간주합니다. 다이렉트 챗은 `agent:<agentId>:<mainKey>` (기본값 `main`)으로 축소되며, 그룹/채널 챗은 자체 키를 갖습니다. `session.mainKey`가 사용됩니다.

`session.dmScope`를 사용하여 **다이렉트 메시지**를 그룹화하는 방법을 제어하세요:

- `main` (기본값): 모든 다이렉트 메시지가 연속성을 위해 메인 세션을 공유합니다.
- `per-peer`: 채널을 넘어 발신자 ID로 격리합니다.
- `per-channel-peer`: 채널 + 발신자로 격리합니다 (다중 사용자 수신함에 권장됨).
- `per-account-channel-peer`: 계정 + 채널 + 발신자로 격리합니다 (다중 계정 수신함에 권장됨).
  `session.identityLinks`를 사용하여 프로바이더가 접두사로 붙인 동료 ID를 정규화된 신원으로 매핑하여 `per-peer`, `per-channel-peer`, 또는 `per-account-channel-peer` 사용 시 동일한 사람이 여러 채널에서 다이렉트 메시지 세션을 공유하도록 합니다.

## 보안 다이렉트 메시지 모드 (다중 사용자 설정에 권장됨)

> **보안 경고:** 에이전트가 **여러 명** 으로부터 다이렉트 메시지를 받을 수 있는 경우, 보안 다이렉트 메시지 모드를 켜는 것을 강력히 고려해야 합니다. 그렇지 않으면 모든 사용자가 동일한 대화 컨텍스트를 공유하게 되어 사용자 간 개인 정보가 누출될 수 있습니다.

**기본 설정의 문제 예시:**

- Alice (`<SENDER_A>`)는 비공개 주제(예: 의료 예약)에 대해 에이전트에게 메시지를 전송합니다.
- Bob (`<SENDER_B>`)는 에이전트에게 "무슨 얘기하고 있었더라?"라고 메시지를 보냅니다.
- 두 다이렉트 메시지가 같은 세션을 공유하기 때문에 모델이 Alice의 이전 컨텍스트를 사용하여 Bob에게 답변할 수 있습니다.

**해결 방법:** 세션을 사용자가 별도로 격리하도록 `dmScope`를 설정합니다:

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // 보안 다이렉트 메시지 모드: 채널 + 발신자 별로 다이렉트 메시지 컨텍스트를 격리합니다.
    dmScope: "per-channel-peer",
  },
}
```

**이 기능을 활성화해야 할 경우:**

- 여러 발신자를 위한 페어링 승인이 있는 경우
- 다이렉트 메시지 허용 목록에 여러 항목이 있는 경우
- `dmPolicy: "open"`을 설정한 경우
- 여러 전화번호나 계정이 에이전트에 메시지를 보낼 수 있는 경우

노트:

- 기본값은 `dmScope: "main"`으로, 연속성을 위해 모든 다이렉트 메시지가 메인 세션을 공유합니다. 이는 단일 사용자 설정에 적합합니다.
- 동일한 채널에서 여러 계정 수신함을 사용하는 경우 `per-account-channel-peer`를 선호합니다.
- 동일한 사람이 여러 채널에서 연락하는 경우, `session.identityLinks`를 사용하여 그들의 다이렉트 메시지 세션을 하나의 정규화된 신원으로 결합하세요.
- `openclaw security audit`로 다이렉트 메시지 설정을 확인할 수 있습니다 (참조: [security](/ko-KR/cli/security)).

## 게이트웨이는 신뢰할 수 있는 소스입니다

모든 세션 상태는 **게이트웨이가 소유**합니다 (중앙 OpenClaw). UI 클라이언트 (macOS 앱, WebChat 등)는 로컬 파일을 읽지 말고, 세션 목록과 토큰 수를 게이트웨이에서 조회해야 합니다.

- **원격 모드**에서는 귀하가 관리하는 세션 저장소가 Mac이 아니라 원격 게이트웨이 호스트에 존재합니다.
- UI에 표시되는 토큰 카운트는 게이트웨이의 저장 필드 (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`)에서 가져옵니다. 클라이언트는 JSONL 전사를 파싱하여 합계를 "수정"하지 않습니다.

## 상태가 어디서 유지되는가

- **게이트웨이 호스트**에:
  - 저장 파일: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (에이전트 당).
- 전사: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (Telegram 주제 세션은 `.../<SessionId>-topic-<threadId>.jsonl`을 사용).
- 저장소는 `sessionKey -> { sessionId, updatedAt, ... }` 맵입니다. 항목을 삭제해도 안전합니다. 필요한 경우 자동으로 재생성됩니다.
- 그룹 항목에는 세션을 UI에서 레이블링하기 위해 `displayName`, `channel`, `subject`, `room`, `space`가 포함될 수 있습니다.
- 세션 항목에는 세션이 어디서 왔는지 설명할 수 있도록 `origin` 메타데이터 (레이블 + 라우팅 힌트)가 포함됩니다.
- OpenClaw는 **이전 Pi/Tau 세션 폴더를** 읽지 않습니다.

## 세션 가지치기

OpenClaw는 기본적으로 LLM 호출 직전에 **이전 도구 결과**를 메모리 컨텍스트에서 제거합니다.
이는 JSONL 기록을 다시 쓰지 않습니다. [/concepts/session-pruning](/ko-KR/concepts/session-pruning)를 참조하세요.

## 사전 압축 메모리 플러시

세션이 자동 압축에 가까워질 때, OpenClaw는 모델에게 디스크에 영구적인 노트를 쓰도록 상기시키는 **조용한 메모리 플러시** 턴을 실행할 수 있습니다. 이는 작업 공간이 쓰기 가능한 경우에만 실행됩니다. [메모리](/ko-KR/concepts/memory) 및 [압축](/ko-KR/concepts/compaction)를 참조하세요.

## 전송 → 세션 키 매핑

- 다이렉트 챗은 `session.dmScope` (기본 `main`)을 따릅니다.
  - `main`: `agent:<agentId>:<mainKey>` (디바이스/채널 전반에 걸친 연속성).
    - 여러 전화번호와 채널이 동일한 에이전트 메인 키에 매핑될 수 있습니다; 그들은 하나의 대화에 대한 전송 수단으로 작용합니다.
  - `per-peer`: `agent:<agentId>:dm:<peerId>`.
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`.
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId 기본값은 `default`).
  - `session.identityLinks`가 프로바이더가 붙인 동료 ID (예: `telegram:123`)와 일치하면, 정규화된 키가 `<peerId>`를 대체하여 동일한 사람이 여러 채널에서 세션을 공유합니다.
- 그룹 챗은 상태를 격리합니다: `agent:<agentId>:<channel>:group:<id>` (회의실/채널은 `agent:<agentId>:<channel>:channel:<id>`를 사용).
  - Telegram 포럼 주제는 격리를 위해 그룹 ID에 `:topic:<threadId>`를 추가합니다.
  - 레거시 `group:<id>` 키는 여전히 마이그레이션에 인식됩니다.
- 인바운드 컨텍스트는 여전히 `group:<id>`를 사용할 수 있으며, 채널은 `Provider`에서 추론되고 정규화된 `agent:<agentId>:<channel>:group:<id>` 형식으로 정규화됩니다.
- 다른 소스:
  - Cron 작업: `cron:<job.id>`
  - Webhooks: `hook:<uuid>` (명시적으로 설정되지 않는 한)
  - 노드 실행: `node-<nodeId>`

## 생애 주기

- 초기화 정책: 세션은 만료될 때까지 재사용되며, 만료는 다음 인바운드 메시지에서 평가됩니다.
- 일일 초기화: 기본값은 **4:00 AM 게이트웨이 호스트 현지 시간**입니다. 세션의 마지막 업데이트가 가장 최근의 일일 초기화 시간보다 이전일 때 세션은 오래된 것으로 간주됩니다.
- 유휴 초기화 (선택 사항): `idleMinutes`는 슬라이딩 유휴 창을 추가합니다. 일일 초기화와 유휴 초기화가 모두 구성된 경우, **먼저 만료되는 것이** 새로운 세션을 강제합니다.
- 레거시 유휴 전용: `session.idleMinutes`를 설정했지만 `session.reset`/`resetByType` 구성이 없는 경우, OpenClaw는 백워드 호환성을 위해 유휴 전용 모드에 머무릅니다.
- 타입별 오버라이드 (선택 사항): `resetByType`을 사용하여 `direct`, `group`, 및 `thread` 세션에 대한 정책을 오버라이드할 수 있습니다 (thread = Slack/Discord 스레드, Telegram 주제, Matrix 스레드가 커넥터에 의해 제공될 때).
- 채널별 오버라이드 (선택 사항): `resetByChannel`은 채널에 대한 초기화 정책을 오버라이드합니다 (해당 채널의 모든 세션 타입에 적용되며 `reset`/`resetByType`보다 우선합니다).
- 초기화 트리거: 정확한 `/new` 또는 `/reset` (및 `resetTriggers`에 추가된 모든 항목)이 새로운 세션 ID를 시작하고 메시지의 나머지 부분을 통과시킵니다. `/new <model>`은 모델 별칭, `provider/model`, 또는 프로바이더 이름 (퍼지 매치)을 받아 새로운 세션 모델을 설정합니다. `/new` 또는 `/reset`이 단독으로 전송되면, OpenClaw는 초기화를 확인하기 위해 짧은 "안녕하세요" 인사 턴을 실행합니다.
- 수동 초기화: 저장소에서 특정 키를 삭제하거나 JSONL 전사를 제거하세요; 다음 메시지가 이를 재생성합니다.
- 격리된 cron jobs는 항상 실행 당 새로운 `sessionId`를 발급합니다 (유휴 재사용 없음).

## 전송 정책 (선택 사항)

개별 ID를 나열하지 않고 특정 세션 유형에 대한 전송을 차단합니다.

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
        // Raw 세션 키 (포함 `agent:<id>:` 접두사)와 일치합니다.
        { action: "deny", match: { rawKeyPrefix: "agent:main:discord:" } },
      ],
      default: "allow",
    },
  },
}
```

실행 중 오버라이드 (소유자만):

- `/send on` → 이 세션을 허용합니다
- `/send off` → 이 세션을 거부합니다
- `/send inherit` → 오버라이드를 지우고 구성 규칙을 사용합니다
  이들을 독립된 메시지로 전송하여 등록되도록 합니다.

## 설정 (선택적 이름 변경 예시)

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // 그룹 키를 별도로 유지합니다
    dmScope: "main", // DM 연속성 (공유 수신함에 대해 per-channel-peer/per-account-channel-peer 설정)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // 기본값: mode=daily, atHour=4 (게이트웨이 호스트 현지 시간).
      // idleMinutes를 설정한 경우, 먼저 만료되는 것이 이깁니다.
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      direct: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    mainKey: "main",
  },
}
```

## 검사

- `openclaw status` — 저장 경로와 최근 세션을 표시합니다.
- `openclaw sessions --json` — 모든 항목을 덤프합니다 (`--active <minutes>`로 필터링).
- `openclaw gateway call sessions.list --params '{}'` — 실행 중인 게이트웨이에서 세션을 가져옵니다 (`--url`/`--token` 사용하여 원격 게이트웨이 접근).
- /상태`를 채팅에서 독립된 메시지로 보내 에이전트가 도달 가능한지, 세션 컨텍스트가 얼마나 사용 중인지, 현재 생각/상세 설명 토글, 그리고 WhatsApp 웹 인증 정보가 마지막으로 새로고침된 시기를 확인할 수 있습니다 (재링크 필요를 발견하는 데 도움됩니다).
- `/context list` 또는 `/context detail`을 보내 시스템 프롬프트 및 삽입된 작업 공간 파일에 무엇이 있는지 (그리고 가장 큰 컨텍스트 기여자) 확인할 수 있습니다.
- `/stop`을 독립된 메시지로 보내 현재 실행을 중단하고, 해당 세션에 대해 대기중인 후속 작업들을 지우며, 거기에서 파생된 모든 하위 에이전트 실행을 중단합니다 (응답에는 중단된 수가 포함).
- `/compact` (선택적 지침)를 독립된 메시지로 보내 이전 컨텍스트를 요약하고 창 공간을 확보하세요. [/concepts/compaction](/ko-KR/concepts/compaction)을 참조하세요.
- JSONL 전사를 직접 열어 전체 턴을 검토할 수 있습니다.

## 팁

- 기본 키는 1:1 트래픽에 전용하세요; 그룹이 자체 키를 유지하도록 하세요.
- 정리 자동화 시, 전체 저장소를 삭제하지 말고 개별 키를 삭제하여 다른 곳의 컨텍스트를 보존하세요.

## 세션 출처 메타데이터

각 세션 항목은 `origin`에 그것이 어디서 왔는지를 기록합니다 (최선의 노력으로):

- `label`: 사람의 레이블 (대화 레이블 + 그룹 주제/채널에서 해결됨)
- `provider`: 표준화된 채널 ID (확장 포함)
- `from`/`to`: 인바운드 봉투의 Raw 라우팅 ID
- `accountId`: 프로바이더 계정 ID (다중 계정인 경우)
- `threadId`: 채널에서 지원할 때 스레드/주제 ID
  출처 필드는 다이렉트 메시지, 채널, 그룹에 대해 채워져 있습니다. 만약 커넥터가 단지 전달 라우팅만 업데이트하는 경우 (예를 들어, 다이렉트 메시지 메인 세션을 신선하게 유지하기 위해), 인바운드 컨텍스트를 제공하여 세션이 설명자 메타데이터를 보존하도록 해야 합니다. 확장 기능은 `ConversationLabel`, `GroupSubject`, `GroupChannel`, `GroupSpace`, 및 `SenderName`을 인바운드 컨텍스트에서 보내고 `recordSessionMetaFromInbound`를 호출하여 (또는 동일한 컨텍스트를 `updateLastRoute`에 전달하여) 이를 수행할 수 있습니다.