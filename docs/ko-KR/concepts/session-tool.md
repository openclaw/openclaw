---
summary: "Agent session tools for listing sessions, fetching history, and sending cross-session messages"
read_when:
  - Adding or modifying session tools
title: "Session Tools"
x-i18n:
  source_hash: b0df5808ae5016ceedaf1ff9f1872fcb5da982b35459da86dcd27d4bea24497d
---

# 세션 도구

목표: 에이전트가 세션을 나열하고, 기록을 가져오고, 다른 세션으로 보낼 수 있는 작고 오용하기 어려운 도구 세트입니다.

## 도구 이름

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## 주요 모델

- 기본 직접 채팅 버킷은 항상 리터럴 키 `"main"`입니다(현재 상담원의 기본 키로 확인됨).
- 그룹 채팅에서는 `agent:<agentId>:<channel>:group:<id>` 또는 `agent:<agentId>:<channel>:channel:<id>`(전체 키 전달)을 사용합니다.
- Cron 작업은 `cron:<job.id>`를 사용합니다.
- 후크는 명시적으로 설정하지 않는 한 `hook:<uuid>`을 사용합니다.
- 노드 세션은 명시적으로 설정하지 않는 한 `node-<nodeId>`을 사용합니다.

`global` 및 `unknown`는 예약된 값이며 나열되지 않습니다. `session.scope = "global"`인 경우 모든 도구에 대해 `main`로 별칭을 지정하므로 호출자는 `global`를 볼 수 없습니다.

## 세션\_목록

세션을 행 배열로 나열합니다.

매개변수:

- `kinds?: string[]` 필터: `"main" | "group" | "cron" | "hook" | "node" | "other"` 중 하나
- `limit?: number` 최대 행(기본값: 서버 기본값, 클램프 예: 200)
- `activeMinutes?: number` N분 이내에 세션만 업데이트됨
- `messageLimit?: number` 0 = 메시지 없음(기본값 0); >0 = 마지막 N개 메시지 포함

행동:

- `messageLimit > 0`는 세션당 `chat.history`를 가져오고 마지막 N개의 메시지를 포함합니다.
- 도구 결과는 목록 출력에서 ​​필터링됩니다. 도구 메시지에는 `sessions_history`를 사용하세요.
- **샌드박스** 에이전트 세션에서 실행할 때 세션 도구는 기본적으로 **생성 전용 가시성**으로 설정됩니다(아래 참조).

행 모양(JSON):

- `key`: 세션 키(문자열)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (사용 가능한 경우 그룹 표시 라벨)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (설정된 경우 세션 재정의)
- `lastChannel`, `lastTo`
- `deliveryContext` (사용 가능한 경우 정규화 `{ channel, to, accountId }`)
- `transcriptPath` (스토어 디렉토리 + sessionId에서 파생된 최선의 경로)
- `messages?` (`messageLimit > 0`인 경우에만)

## session_history

한 세션의 기록을 가져옵니다.

매개변수:

- `sessionKey` (필수; `sessions_list`에서 세션 키 또는 `sessionId`를 허용합니다.)
- `limit?: number` 최대 메시지(서버 클램프)
- `includeTools?: boolean` (기본값은 false)

행동:

- `includeTools=false`는 `role: "toolResult"` 메시지를 필터링합니다.
- 원시 기록 형식으로 메시지 배열을 반환합니다.
- `sessionId`가 주어지면 OpenClaw는 이를 해당 세션 키로 해결합니다(ID 누락 오류).

## session_send

다른 세션에 메시지를 보냅니다.

매개변수:

- `sessionKey` (필수; `sessions_list`에서 세션 키 또는 `sessionId`를 허용합니다.)
- `message` (필수)
- `timeoutSeconds?: number` (기본값 >0; 0 = 실행 후 잊어버리기)

행동:

- `timeoutSeconds = 0`: 대기열에 추가하고 `{ runId, status: "accepted" }`를 반환합니다.
- `timeoutSeconds > 0`: 완료될 때까지 최대 N초를 기다린 후 `{ runId, status: "ok", reply }`를 반환합니다.
- 대기 시간이 초과된 경우: `{ runId, status: "timeout", error }`. 계속 실행됩니다. 나중에 `sessions_history`를 호출하세요.
- 실행에 실패한 경우: `{ runId, status: "error", error }`.
- 기본 실행이 완료된 후 최선의 방법으로 전달 실행을 발표합니다. `status: "ok"`는 공지가 전달되었음을 보장하지 않습니다.
- 게이트웨이 `agent.wait`(서버 측)를 통해 대기하므로 다시 연결해도 대기 시간이 중단되지 않습니다.
- 기본 실행을 위해 에이전트 간 메시지 컨텍스트가 주입됩니다.
- 세션 간 메시지는 `message.provenance.kind = "inter_session"`로 유지되므로 기록 독자는 라우팅된 에이전트 지침과 외부 사용자 입력을 구별할 수 있습니다.
- 기본 실행이 완료된 후 OpenClaw는 **응답 루프**를 실행합니다.
  - 2라운드 이상은 요청자와 대상 에이전트가 번갈아 진행됩니다.
  - 탁구를 멈추려면 정확히 `REPLY_SKIP`라고 답하세요.
  - 최대 회전 수는 `session.agentToAgent.maxPingPongTurns` (0–5, 기본값 5)입니다.
- 루프가 끝나면 OpenClaw는 **에이전트 간 알림 단계**를 실행합니다(대상 에이전트에만 해당).
  - 조용히 `ANNOUNCE_SKIP`라고 정확하게 답장해 주세요.
  - 기타 응답은 대상 채널로 전송됩니다.
  - 공지 단계에는 원래 요청 + 1라운드 응답 + 최신 핑퐁 응답이 포함됩니다.

## 채널 필드

- 그룹의 경우 `channel`는 세션 항목에 녹화된 채널입니다.
- 직접 채팅의 경우 `channel`는 `lastChannel`에서 매핑됩니다.
- cron/hook/node의 경우 `channel`는 `internal`입니다.
- 누락된 경우 `channel`는 `unknown`입니다.

## 보안/전송 정책

채널/채팅 유형별 정책 기반 차단(세션 ID별 아님)

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

런타임 재정의(세션 항목별):

- `sendPolicy: "allow" | "deny"` (설정 해제 = 구성 상속)
- `sessions.patch` 또는 소유자 전용 `/send on|off|inherit`(독립형 메시지)을 통해 설정 가능합니다.

시행 포인트:

- `chat.send` / `agent` (게이트웨이)
- 자동 응답 전달 로직

## session_spawn

격리된 세션에서 하위 에이전트 실행을 생성하고 결과를 요청자 채팅 채널에 다시 알립니다.

매개변수:

- `task` (필수)
- `label?` (선택사항, 로그/UI에 사용됨)
- `agentId?` (선택 사항, 허용되는 경우 다른 에이전트 ID로 생성)
- `model?` (선택 사항, 하위 에이전트 모델 재정의, 잘못된 값 오류)
- `runTimeoutSeconds?` (기본값 0; 설정 시 N초 후에 하위 에이전트 실행을 중단합니다.)
- `cleanup?` (`delete|keep`, 기본값 `keep`)

허용 목록:

- `agents.list[].subagents.allowAgents`: `agentId`(`["*"]`를 통해 허용되는 에이전트 ID 목록). 기본값: 요청자 에이전트만.

발견:

- `agents_list`를 사용하여 `sessions_spawn`에 어떤 에이전트 ID가 허용되는지 확인하세요.

행동:

- `deliver: false`를 사용하여 새로운 `agent:<agentId>:subagent:<uuid>` 세션을 시작합니다.
- 하위 에이전트는 기본적으로 전체 도구 세트 **세션 도구 제외**(`tools.subagents.tools`를 통해 구성 가능)로 설정됩니다.
- 하위 에이전트는 `sessions_spawn`를 호출할 수 없습니다. (하위 에이전트 없음 → 하위 에이전트 스폰)
- 항상 비차단: `{ status: "accepted", runId, childSessionKey }`를 즉시 반환합니다.
- 완료 후 OpenClaw는 하위 에이전트 **공지 단계**를 실행하고 결과를 요청자 채팅 채널에 게시합니다.
- 발표 단계에서는 `ANNOUNCE_SKIP`라고 정확하게 답해 침묵을 유지하세요.
- 알림 답변은 `Status`/`Result`/`Notes`로 정규화됩니다. `Status`는 런타임 결과(모델 텍스트 아님)에서 나옵니다.
- 하위 에이전트 세션은 `agents.defaults.subagents.archiveAfterMinutes` 이후 자동으로 보관됩니다(기본값: 60).
- 발표 답변에는 통계 줄(런타임, 토큰, sessionKey/sessionId, 성적표 경로 및 선택적 비용)이 포함됩니다.

## 샌드박스 세션 가시성

샌드박스 세션은 세션 도구를 사용할 수 있지만 기본적으로 `sessions_spawn`를 통해 생성된 세션만 볼 수 있습니다.

구성:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
