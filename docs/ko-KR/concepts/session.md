---
summary: "채팅을 위한 세션 관리 규칙, 키, 지속성"
read_when:
  - 세션 처리 또는 저장소 수정
title: "세션 관리"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/concepts/session.md
  workflow: 15
---

# 세션 관리

OpenClaw는 **에이전트당 하나의 직접 채팅 세션**을 기본값으로 취급합니다. 직접 채팅은 `agent:<agentId>:<mainKey>` (기본값 `main`)로 축소되는 반면 그룹/채널 채팅은 자신의 키를 받습니다. `session.mainKey`가 표시됩니다.

**직접 메시지**가 어떻게 그룹화되는지 제어하려면 `session.dmScope`를 사용하세요:

- `main` (기본값): 연속성을 위해 모든 DM이 메인 세션을 공유합니다.
- `per-peer`: 채널 전체에서 발신자 id별로 격리.
- `per-channel-peer`: 채널 + 발신자별 격리(다중 사용자 수신함 권장).
- `per-account-channel-peer`: 계정 + 채널 + 발신자별 격리(다중 계정 수신함 권장).
  `session.identityLinks`를 사용하여 제공자 접두사가 있는 피어 id를 정규 정체성에 매핑하여 `per-peer`, `per-channel-peer`, 또는 `per-account-channel-peer`를 사용할 때 같은 사람이 채널 간에 DM 세션을 공유하도록 합니다.

## 보안 DM 모드(다중 사용자 설정 권장)

> **보안 경고:** 에이전트가 **여러 사람**으로부터 DM을 받을 수 있다면 보안 DM 모드를 활성화하는 것을 강력히 권장합니다. 없으면 모든 사용자가 동일한 대화 컨텍스트를 공유하므로 사용자 간에 개인 정보가 유출될 수 있습니다.

**기본 설정의 문제 예제:**

- Alice (`<SENDER_A>`)는 개인적인 주제(예: 의료 약속)에 대해 에이전트에 메시지를 보냅니다.
- Bob (`<SENDER_B>`)은 "우리가 무엇에 대해 이야기하고 있었나요?"라고 묻는 에이전트에 메시지를 보냅니다.
- 두 DM이 동일한 세션을 공유하므로 모델은 Alice의 이전 컨텍스트를 사용하여 Bob에게 답할 수 있습니다.

**해결책:** 사용자당 세션을 격리하려면 `dmScope`을 설정하세요:

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // 보안 DM 모드: 채널 + 발신자별 DM 컨텍스트 격리.
    dmScope: "per-channel-peer",
  },
}
```

**이를 활성화해야 하는 경우:**

- 둘 이상의 발신자에 대한 페어링 승인이 있습니다.
- DM 허용 목록을 여러 항목으로 사용합니다.
- `dmPolicy: "open"` 설정
- 여러 전화번호 또는 계정이 에이전트에 메시지를 보낼 수 있습니다.

주의사항:

- 기본값은 `dmScope: "main"` (모든 DM이 메인 세션을 공유)입니다. 이는 단일 사용자 설정에 적합합니다.
- 로컬 CLI 온보딩은 미설정 시 기본값으로 `session.dmScope: "per-channel-peer"`를 기본값으로 씁니다(기존 명시적 값은 유지됨).
- 동일한 채널의 다중 계정 수신함의 경우 `per-account-channel-peer`를 선호합니다.
- 같은 사람이 여러 채널에 연락하는 경우 `session.identityLinks`를 사용하여 DM 세션을 하나의 정규 정체성으로 축소합니다.
- `openclaw security audit`으로 DM 설정을 확인할 수 있습니다([보안](/cli/security) 참조).

## Gateway는 진실의 원천

모든 세션 상태는 **Gateway에 소유됩니다**(마스터 OpenClaw). UI 클라이언트(macOS 앱, WebChat 등)는 로컬 파일을 읽는 대신 세션 목록 및 토큰 수에 대해 Gateway를 쿼리해야 합니다.

- **원격 모드**에서 신경 쓸 세션 저장소는 Mac이 아닌 원격 Gateway 호스트에 있습니다.
- UI에 표시되는 토큰 수는 Gateway의 저장소 필드(`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`)에서 나옵니다. 클라이언트는 JSONL 기록을 파싱하여 합계를 "수정"하지 않습니다.

## 상태가 있는 곳

- **Gateway 호스트에서:**
  - 저장소 파일: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (에이전트당).
- 기록: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (Telegram 주제 세션은 `.../<SessionId>-topic-<threadId>.jsonl` 사용).
- 저장소는 `sessionKey -> { sessionId, updatedAt, ... }` 맵입니다. 항목 삭제는 안전합니다; 필요에 따라 다시 생성됩니다.
- 그룹 항목에는 UI에서 세션 레이블을 지정하기 위해 `displayName`, `channel`, `subject`, `room`, `space`가 포함될 수 있습니다.
- 세션 항목에는 UI가 세션의 출처를 설명할 수 있도록 `origin` 메타데이터(레이블 + 라우팅 힌트)가 포함됩니다.
- OpenClaw는 **레거시 Pi/Tau 세션 폴더를 읽지 않습니다**.

## 유지보수

OpenClaw는 세션 저장소 유지 보수를 적용하여 `sessions.json` 및 기록 아티팩트를 시간 경과에 따라 바운드로 유지합니다.

### 기본값

- `session.maintenance.mode`: `warn`
- `session.maintenance.pruneAfter`: `30d`
- `session.maintenance.maxEntries`: `500`
- `session.maintenance.rotateBytes`: `10mb`
- `session.maintenance.resetArchiveRetention`: `pruneAfter` (기본값 `30d`)
- `session.maintenance.maxDiskBytes`: 미설정(비활성화)
- `session.maintenance.highWaterBytes`: 예산 편성이 활성화되면 `maxDiskBytes`의 `80%`로 기본값 설정

### 동작 방식

유지 보수는 세션 저장소 쓰기 중에 실행되며 `openclaw sessions cleanup`으로 필요에 따라 트리거할 수 있습니다.

- `mode: "warn"`: 무엇이 제거될 것인지 보고하지만 항목/기록을 변경하지 않습니다.
- `mode: "enforce"`: 이 순서로 정리를 적용합니다:
  1. `pruneAfter`보다 오래된 기한 만료된 항목 제거
  2. 항목 수를 `maxEntries`로 제한(가장 오래된 것 먼저)
  3. 제거된 항목이 더 이상 참조되지 않는 기록 파일 보관
  4. 보존 정책별 이전 `*.deleted.<timestamp>` 및 `*.reset.<timestamp>` 보관 제거
  5. `sessions.json`이 `rotateBytes`를 초과할 때 회전
  6. `maxDiskBytes`가 설정되면 `highWaterBytes`를 향해 디스크 예산 시행(가장 오래된 아티팩트 먼저, 그 다음 가장 오래된 세션)

### 큰 저장소에 대한 성능 주의사항

큰 세션 저장소는 높은 볼륨 설정에서 흔합니다. 유지 보수 작업은 쓰기 경로 작업이므로 매우 큰 저장소는 쓰기 지연을 증가시킬 수 있습니다.

비용을 가장 많이 증가시키는 것:

- 매우 높은 `session.maintenance.maxEntries` 값
- 기한이 만료된 항목을 유지하는 긴 `pruneAfter` 창
- `~/.openclaw/agents/<agentId>/sessions/`의 많은 기록/보관 아티팩트
- 디스크 예산 활성화(`maxDiskBytes`) - 합리적인 정리/제한 없음

해야 할 일:

- 프로덕션에서 `mode: "enforce"`를 사용하여 성장이 자동으로 바운드됩니다.
- 하나만이 아닌 시간 및 수 제한 설정(`pruneAfter` + `maxEntries`)
- 큰 배포에서 `maxDiskBytes` + `highWaterBytes` 설정 - 하드 상한선
- `highWaterBytes`를 `maxDiskBytes` 아래로 의미있게 유지(기본값은 80%)
- 설정 변경 후 `openclaw sessions cleanup --dry-run --json`을 실행하여 시행 전에 예상 영향 확인
- 자주 활성화되는 세션의 경우 수동 정리 실행 시 `--active-key`를 전달합니다.

### 예제 사용자 정의

보수적인 시행 정책을 사용합니다:

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      pruneAfter: "45d",
      maxEntries: 800,
      rotateBytes: "20mb",
      resetArchiveRetention: "14d",
    },
  },
}
```

세션 디렉터리에 하드 디스크 예산을 활성화합니다:

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      maxDiskBytes: "1gb",
      highWaterBytes: "800mb",
    },
  },
}
```

더 큰 설치에 맞게 조정(예제):

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      pruneAfter: "14d",
      maxEntries: 2000,
      rotateBytes: "25mb",
      maxDiskBytes: "2gb",
      highWaterBytes: "1.6gb",
    },
  },
}
```

CLI에서 유지 보수 미리보기 또는 강제:

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --enforce
```

## 세션 정리

OpenClaw는 LLM 호출 직전에 기본값으로 **이전 도구 결과**를 메모리 내 컨텍스트에서 트리밍합니다.
이는 JSONL 기록을 다시 쓰지 **않습니다**. [/concepts/session-pruning](/concepts/session-pruning)을 참조하세요.

## 압축 전 메모리 플러시

세션이 자동 압축에 가까워지면 OpenClaw는 **자동 메모리 플러시** 턴을 실행할 수 있습니다. 이는 워크스페이스가 쓰기 가능할 때만 실행됩니다. [메모리](/concepts/memory) 및 [압축](/concepts/compaction)을 참조하세요.

## 전송 매핑 → 세션 키

- 직접 채팅은 `session.dmScope` (기본값 `main`)을 따릅니다.
  - `main`: `agent:<agentId>:<mainKey>` (장치/채널 간 연속성).
    - 여러 전화번호 및 채널은 동일한 에이전트 메인 키로 매핑될 수 있으며; 이들은 하나의 대화로 전송됩니다.
  - `per-peer`: `agent:<agentId>:dm:<peerId>`.
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`.
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId는 기본값으로 `default`).
  - `session.identityLinks`가 제공자 접두사가 있는 피어 id (예: `telegram:123`)와 일치하면 정규 키가 `<peerId>`를 대체하여 같은 사람이 채널 간에 세션을 공유합니다.
- 그룹 채팅 격리 상태: `agent:<agentId>:<channel>:group:<id>` (방/채널은 `agent:<agentId>:<channel>:channel:<id>` 사용).
  - Telegram 포럼 주제는 격리를 위해 `:topic:<threadId>`를 그룹 id에 추가합니다.
  - 레거시 `group:<id>` 키는 마이그레이션을 위해 여전히 인식됩니다.
- 인바운드 컨텍스트는 여전히 `group:<id>`를 사용할 수 있습니다; 채널은 `Provider`에서 추론되고 정규 `agent:<agentId>:<channel>:group:<id>` 형식으로 정규화됩니다.
- 기타 소스:
  - Cron 작업: `cron:<job.id>`
  - Webhook: `hook:<uuid>` (명시적으로 설정되지 않은 경우)
  - 노드 실행: `node-<nodeId>`

## 수명 주기

- 재설정 정책: 세션은 만료될 때까지 재사용되며 만료는 다음 인바운드 메시지에서 평가됩니다.
- 일일 재설정: **Gateway 호스트의 현지 시간 오전 4시** 기본값. 세션은 가장 최근의 일일 재설정 시간보다 이전에 마지막으로 업데이트되면 기한이 만료됩니다.
- 유휴 재설정(선택적): `idleMinutes`는 슬라이딩 유휴 창을 추가합니다. 일일 및 유휴 재설정이 모두 설정되면 **먼저 만료되는 것**이 새 세션을 강제합니다.
- 레거시 유휴 전용: `session.idleMinutes`를 `session.reset`/`resetByType` 설정 없이 설정하면 OpenClaw는 이전 호환성을 위해 유휴 전용 모드로 유지됩니다.
- 유형당 무시(선택적): `resetByType`을 사용하면 `direct`, `group`, `thread` 세션에 대한 정책을 무시할 수 있습니다(thread = Slack/Discord 스레드, Telegram 주제, 커넥터에서 제공할 때 Matrix 스레드).
- 채널당 무시(선택적): `resetByChannel`은 채널의 재설정 정책을 무시합니다(해당 채널의 모든 세션 유형에 적용되고 `reset`/`resetByType`보다 우선).
- 재설정 트리거: 정확한 `/new` 또는 `/reset` (plus any extras in `resetTriggers`) 시작 새 sessionId는 메시지의 나머지 부분을 전달합니다. `/new <model>`은 모델 별칭, `provider/model`, 또는 제공자 이름(모호한 일치)을 수락하여 새 세션 모델을 설정합니다. `/new` 또는 `/reset`만 단독으로 전송되면 OpenClaw는 짧은 "hello" 인사 턴을 실행하여 재설정을 확인합니다.
- 수동 재설정: 저장소에서 특정 키를 삭제하거나 JSONL 기록을 제거합니다; 다음 메시지는 이들을 다시 생성합니다.
- 격리된 Cron 작업은 항상 실행당 새로운 `sessionId`를 발행합니다(유휴 재사용 없음).

## 전송 정책(선택적)

개별 id를 나열하지 않고 특정 세션 유형에 대한 전달을 차단합니다.

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
        // 원본 세션 키 일치(`agent:<id>:` 접두사 포함).
        { action: "deny", match: { rawKeyPrefix: "agent:main:discord:" } },
      ],
      default: "allow",
    },
  },
}
```

런타임 무시(소유자만):

- `/send on` → 이 세션에 허용
- `/send off` → 이 세션 거부
- `/send inherit` → 무시를 지우고 설정 규칙 사용
  이들을 독립 실행형 메시지로 보내서 등록하세요.

## 설정(선택적 이름 바꾸기 예제)

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // 그룹 키를 별도로 유지
    dmScope: "main", // DM 연속성(공유 수신함의 경우 per-channel-peer/per-account-channel-peer 설정)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // 기본값: mode=daily, atHour=4 (Gateway 호스트 현지 시간).
      // idleMinutes도 설정하면 먼저 만료되는 것이 우선합니다.
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

- `openclaw status` — 저장소 경로 및 최근 세션 표시.
- `openclaw sessions --json` — 모든 항목 덤프(`--active <minutes>`로 필터링).
- `openclaw gateway call sessions.list --params '{}'` — 실행 중인 Gateway에서 세션 가져오기(원격 Gateway 접근을 위해 `--url`/`--token` 사용).
- 채팅에서 독립 실행형 메시지로 `/status`를 보내 에이전트에 연결할 수 있는지, 세션 컨텍스트의 양, 현재 사고/자세한 전환, WhatsApp 웹 자격증명이 마지막으로 새로 고쳐진 경우 확인(재연결 필요 확인).
- `/context list` 또는 `/context detail`을 보내 시스템 프롬프트에 있는 것과 주입된 워크스페이스 파일, 가장 큰 컨텍스트 기여자 확인.
- `/stop` (또는 `stop`, `stop action`, `stop run`, `stop openclaw`와 같은 독립 실행형 중단 문구)을 보내 현재 실행을 중단하고 해당 세션에 대해 대기 중인 후속 작업을 지우고 이를 통해 생성된 모든 하위 에이전트 실행 중지(회신에 중지된 수 포함).
- `/compact` (선택적 지침)을 독립 실행형 메시지로 보내 이전 컨텍스트를 요약하고 창 공간 확보. [/concepts/compaction](/concepts/compaction)을 참조하세요.
- JSONL 기록은 직접 열어 전체 턴을 검토할 수 있습니다.

## 팁

- 기본 키를 1:1 트래픽 전용으로 유지합니다; 그룹이 자신의 키를 유지하도록 하세요.
- 정리를 자동화할 때 전체 저장소 대신 개별 키를 삭제하여 다른 곳의 컨텍스트 보존.

## 세션 출처 메타데이터

각 세션 항목은 `origin`에서(최선의 노력) 출처를 기록합니다:

- `label`: 인간 레이블(대화 레이블 + 그룹 주제/채널에서 확인됨)
- `provider`: 정규화된 채널 id(확장 포함)
- `from`/`to`: 인바운드 봉투의 원본 라우팅 id
- `accountId`: 제공자 계정 id(다중 계정인 경우)
- `threadId`: 채널이 지원할 때 스레드/주제 id
  원본 필드는 직접 메시지, 채널, 그룹에 채워집니다. 커넥터가 전달 라우팅만 업데이트하는 경우(예: DM 메인 세션을 신선하게 유지하려면), 세션이 설명 메타데이터를 유지하도록 인바운드 컨텍스트를 제공해야 합니다. 확장은 인바운드 컨텍스트에서 `ConversationLabel`, `GroupSubject`, `GroupChannel`, `GroupSpace`, `SenderName`을 보내고 `recordSessionMetaFromInbound`를 호출하거나 동일한 컨텍스트를 `updateLastRoute`로 전달할 수 있습니다.
