---
summary: "Session management rules, keys, and persistence for chats"
read_when:
  - Modifying session handling or storage
title: "Session Management"
x-i18n:
  source_hash: 266781bc5c2f446b70c312099c1cff9dbefee983529a1605b0ba71e4948efbf9
---

# 세션 관리

OpenClaw는 **에이전트당 하나의 직접 채팅 세션**을 기본 세션으로 처리합니다. 직접 채팅은 `agent:<agentId>:<mainKey>`(기본값 `main`)로 축소되지만 그룹/채널 채팅은 자체 키를 갖습니다. `session.mainKey`님이 영광입니다.

`session.dmScope`를 사용하여 **직접 메시지** 그룹화 방법을 제어하세요.

- `main`(기본값): 모든 DM은 연속성을 위해 기본 세션을 공유합니다.
- `per-peer`: 채널 전반에 걸쳐 보낸 사람 ID로 격리합니다.
- `per-channel-peer`: 채널 + 발신자별로 격리합니다(다중 사용자 받은 편지함에 권장).
- `per-account-channel-peer`: 계정 + 채널 + 발신자별로 격리합니다(다중 계정 받은편지함에 권장).
  `session.identityLinks`를 사용하여 공급자 접두사가 붙은 피어 ID를 표준 ID에 매핑하여 `per-peer`, `per-channel-peer` 또는 `per-account-channel-peer`를 사용할 때 동일한 사람이 채널 간에 DM 세션을 공유하도록 합니다.

## 보안 DM 모드(다중 사용자 설정에 권장)

> **보안 경고:** 에이전트가 **여러 사람**으로부터 DM을 받을 수 있는 경우 보안 DM 모드 활성화를 강력히 고려해야 합니다. 그렇지 않으면 모든 사용자가 동일한 대화 컨텍스트를 공유하므로 사용자 간의 개인 정보가 유출될 수 있습니다.

**기본 설정 문제의 예:**

- Alice(`<SENDER_A>`)는 비공개 주제(예: 의료 약속)에 관해 에이전트에게 메시지를 보냅니다.
- Bob(`<SENDER_B>`)은 에이전트에게 "우리가 무슨 얘기를 하고 있었나요?"라고 묻는 메시지를 보냅니다.
- 두 DM이 동일한 세션을 공유하기 때문에 모델은 Alice의 이전 컨텍스트를 사용하여 Bob에게 응답할 수 있습니다.

**수정 사항:** 사용자별 세션을 격리하려면 `dmScope`를 설정하세요.

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Secure DM mode: isolate DM context per channel + sender.
    dmScope: "per-channel-peer",
  },
}
```

**이 기능을 활성화하는 경우:**

- 두 명 이상의 발신자에 대한 페어링 승인이 있습니다.
- 여러 항목이 포함된 DM 허용 목록을 사용합니다.
- `dmPolicy: "open"`를 설정했습니다.
- 여러 전화번호나 계정으로 상담원에게 메시지를 보낼 수 있습니다.

참고:

- 연속성을 위한 기본값은 `dmScope: "main"`입니다(모든 DM은 기본 세션을 공유합니다). 이는 단일 사용자 설정에 적합합니다.
- 동일한 채널에 다중 계정 받은 편지함의 경우 `per-account-channel-peer`를 선호합니다.
- 동일한 사람이 여러 채널에서 연락하는 경우 `session.identityLinks`를 사용하여 DM 세션을 하나의 정식 ID로 축소하세요.
- `openclaw security audit`로 DM 설정을 확인할 수 있습니다([보안](/cli/security) 참조).

## 게이트웨이는 진실의 원천입니다

모든 세션 상태는 **게이트웨이**("마스터" OpenClaw)가 소유합니다. UI 클라이언트(macOS 앱, WebChat 등)는 로컬 파일을 읽는 대신 게이트웨이에 세션 목록 및 토큰 수를 쿼리해야 합니다.

- **원격 모드**에서는 관심 있는 세션 저장소가 Mac이 아닌 원격 게이트웨이 호스트에 있습니다.
- UI에 표시되는 토큰 수는 게이트웨이의 저장소 필드(`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`)에서 가져옵니다. 클라이언트는 총계를 "수정"하기 위해 JSONL 기록을 구문 분석하지 않습니다.

## 국가가 사는 곳

- **게이트웨이 호스트**에서:
  - 저장 파일: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (에이전트별).
- 성적 증명서: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (텔레그램 주제 세션은 `.../<SessionId>-topic-<threadId>.jsonl`를 사용합니다).
- 매장은 맵 `sessionKey -> { sessionId, updatedAt, ... }`입니다. 항목을 삭제하는 것은 안전합니다. 요청 시 다시 생성됩니다.
- 그룹 항목에는 `displayName`, `channel`, `subject`, `room` 및 `space`가 포함되어 UI에서 세션에 레이블을 지정할 수 있습니다.
- 세션 항목에는 `origin` 메타데이터(레이블 + 라우팅 힌트)가 포함되어 UI가 세션의 출처를 설명할 수 있습니다.
- OpenClaw는 레거시 Pi/Tau 세션 폴더를 읽지 **않습니다**.

## 세션 가지치기

OpenClaw는 기본적으로 LLM 호출 직전에 메모리 내 컨텍스트에서 **이전 도구 결과**를 잘라냅니다.
JSONL 기록을 다시 작성하지 **않습니다**. [/concepts/session-pruning](/concepts/session-pruning)을 참조하세요.

## 사전 압축 메모리 플러시

세션이 자동 압축에 가까워지면 OpenClaw는 **자동 메모리 플러시**를 실행할 수 있습니다.
모델이 디스크에 내구성 있는 메모를 기록하도록 상기시키는 회전입니다. 이 경우에만 실행됩니다.
작업 공간은 쓰기 가능합니다. [메모리](/concepts/memory) 및
[압축](/concepts/compaction).

## 전송 매핑 → 세션 키

- 직접 채팅은 `session.dmScope`(기본값 `main`)을 따릅니다.
  - `main`: `agent:<agentId>:<mainKey>` (장치/채널 간 연속성).
    - 여러 전화번호와 채널이 동일한 에이전트 기본 키에 매핑될 수 있습니다. 그들은 하나의 대화로 이동하는 역할을 합니다.
  - `per-peer`: `agent:<agentId>:dm:<peerId>`.
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`.
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (계정 ID의 기본값은 `default`).
  - `session.identityLinks`가 공급자 접두사가 붙은 피어 ID(예: `telegram:123`)와 일치하는 경우 정식 키가 `<peerId>`를 대체하므로 동일한 사람이 채널 전체에서 세션을 공유합니다.
- 그룹 채팅은 상태를 격리합니다: `agent:<agentId>:<channel>:group:<id>` (방/채널은 `agent:<agentId>:<channel>:channel:<id>`를 사용합니다).
  - 텔레그램 포럼 주제는 격리를 위해 그룹 ID에 `:topic:<threadId>`를 추가합니다.
  - 레거시 `group:<id>` 키는 여전히 마이그레이션용으로 인식됩니다.
- 인바운드 컨텍스트는 여전히 `group:<id>`를 사용할 수 있습니다. 채널은 `Provider`에서 추론되고 정식 `agent:<agentId>:<channel>:group:<id>` 형식으로 정규화됩니다.
- 기타 출처:
  - 크론 작업: `cron:<job.id>`
  - 웹후크: `hook:<uuid>` (후크에 의해 명시적으로 설정되지 않는 한)
  - 노드 실행: `node-<nodeId>`

## 수명주기

- 정책 재설정: 세션은 만료될 때까지 재사용되며 만료는 다음 인바운드 메시지에서 평가됩니다.
- 일일 재설정: 기본값은 **게이트웨이 호스트의 현지 시간 오전 4시**입니다. 마지막 업데이트가 가장 최근의 일일 재설정 시간보다 빠르면 세션이 오래됩니다.
- 유휴 재설정(선택 사항): `idleMinutes` 슬라이딩 유휴 기간을 추가합니다. 일일 재설정과 유휴 재설정이 모두 구성된 경우 **먼저 만료되는 것**은 새 세션을 강제 실행합니다.
- 레거시 유휴 전용: `session.reset`/`resetByType` 구성 없이 `session.idleMinutes`를 설정하면 OpenClaw는 이전 버전과의 호환성을 위해 유휴 전용 모드로 유지됩니다.
- 유형별 재정의(선택 사항): `resetByType`를 사용하면 `direct`, `group` 및 `thread` 세션에 대한 정책을 재정의할 수 있습니다(스레드 = Slack/Discord 스레드, Telegram 주제, 커넥터에서 제공하는 매트릭스 스레드).
- 채널별 재정의(선택 사항): `resetByChannel`는 채널의 재설정 정책을 재정의합니다(해당 채널의 모든 세션 유형에 적용되며 `reset`/`resetByType`보다 우선합니다).
- 트리거 재설정: 정확한 `/new` 또는 `/reset` (`resetTriggers`의 추가 항목 포함) 새로운 세션 ID를 시작하고 메시지의 나머지 부분을 전달합니다. `/new <model>`는 모델 별칭인 `provider/model` 또는 공급자 이름(퍼지 일치)을 허용하여 새 세션 모델을 설정합니다. `/new` 또는 `/reset`가 단독으로 전송되는 경우 OpenClaw는 재설정을 확인하기 위해 짧은 "hello" 인사말을 실행합니다.
- 수동 재설정: 저장소에서 특정 키를 삭제하거나 JSONL 기록을 제거합니다. 다음 메시지에서 다시 생성됩니다.
- 격리된 크론 작업은 항상 실행당 새로운 `sessionId`를 생성합니다(유휴 재사용 없음).

## 전송 정책(선택 사항)

개별 ID를 나열하지 않고 특정 세션 유형에 대한 전달을 차단합니다.

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
      ],
      default: "allow",
    },
  },
}
```

런타임 재정의(소유자 전용):

- `/send on` → 이 세션을 허용합니다.
- `/send off` → 이 세션에 대해 거부
- `/send inherit` → 재정의를 지우고 구성 규칙을 사용합니다.
  등록할 수 있도록 독립형 메시지로 보내세요.

## 구성(선택적 이름 바꾸기 예)

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // keep group keys separate
    dmScope: "main", // DM continuity (set per-channel-peer/per-account-channel-peer for shared inboxes)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // Defaults: mode=daily, atHour=4 (gateway host local time).
      // If you also set idleMinutes, whichever expires first wins.
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

## 검사 중

- `openclaw status` — 매장 경로와 최근 세션을 보여줍니다.
- `openclaw sessions --json` — 모든 항목을 덤프합니다(`--active <minutes>`로 필터링).
- `openclaw gateway call sessions.list --params '{}'` — 실행 중인 게이트웨이에서 세션을 가져옵니다(원격 게이트웨이 액세스에는 `--url`/`--token` 사용).
- 채팅에서 `/status`를 독립 실행형 메시지로 보내 상담원 연결 가능 여부, 세션 컨텍스트가 얼마나 사용되는지, 현재 생각/자세한 토글, WhatsApp 웹 자격 증명이 마지막으로 새로 고쳐진 시기를 확인합니다(재링크 요구 사항을 파악하는 데 도움이 됨).
- `/context list` 또는 `/context detail`를 보내 시스템 프롬프트와 삽입된 작업 공간 파일(및 가장 큰 컨텍스트 기여자)에 무엇이 있는지 확인하세요.
- `/stop`를 독립 실행형 메시지로 보내 현재 실행을 중단하고, 해당 세션에 대해 대기 중인 후속 작업을 지우고, 해당 세션에서 생성된 모든 하위 에이전트 실행을 중지합니다(응답에는 중지된 개수가 포함됩니다).
- 이전 컨텍스트를 요약하고 창 공간을 확보하기 위해 `/compact`(선택적 지침)를 독립 실행형 메시지로 보냅니다. [/concepts/compaction](/concepts/compaction)를 참조하세요.
- JSONL 성적표를 직접 열어 전체 차례를 검토할 수 있습니다.

## 팁

- 기본 키를 1:1 트래픽 전용으로 유지하세요. 그룹이 자신의 키를 유지하도록 합니다.
- 정리를 자동화할 때 전체 저장소 대신 개별 키를 삭제하여 다른 곳에서 컨텍스트를 보존하세요.

## 세션 출처 메타데이터

각 세션 항목은 `origin`에서 해당 세션 항목이 어디에서 왔는지 기록합니다(최선을 다해):

- `label`: 휴먼 라벨(대화 라벨 + 그룹 제목/채널로 해결)
- `provider`: 정규화된 채널 ID(확장자 포함)
- `from`/`to`: 인바운드 봉투의 원시 라우팅 ID
- `accountId` : 제공자 계정ID (다중계정인 경우)
- `threadId`: 채널이 지원하는 경우 스레드/주제 ID
  다이렉트 메시지, 채널 및 그룹에 대한 원본 필드가 채워집니다. 만약
  커넥터는 배달 라우팅만 업데이트합니다(예: DM 기본 세션을 유지하기 위해)
  최신) 세션이 계속해서 인바운드 컨텍스트를 유지하도록 인바운드 컨텍스트를 제공해야 합니다.
  설명자 메타데이터. 확장 프로그램은 `ConversationLabel`를 전송하여 이를 수행할 수 있습니다.
  인바운드의 `GroupSubject`, `GroupChannel`, `GroupSpace` 및 `SenderName`
  컨텍스트 및 `recordSessionMetaFromInbound` 호출(또는 동일한 컨텍스트 전달)
  `updateLastRoute`)로 변경됩니다.
