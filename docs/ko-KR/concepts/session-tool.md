---
summary: "에이전트 세션 도구는 세션 목록을 나열하고, 이력을 가져오며, 세션 간 메시지를 전송합니다."
read_when:
  - 세션 도구 추가 또는 수정
title: "세션 도구"
---

# 세션 도구

목표: 에이전트가 세션을 나열하고, 이력을 가져오고, 다른 세션에 메시지를 보낼 수 있도록 하는 작고 사용하기 어려운 도구 세트입니다.

## 도구 이름

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## 키 모델

- 메인 다이렉트 채팅 버킷은 항상 리터럴 키 `"main"`입니다 (현재 에이전트의 메인 키로 해석됨).
- 그룹 채팅은 `agent:<agentId>:<channel>:group:<id>` 또는 `agent:<agentId>:<channel>:channel:<id>`를 사용합니다 (전체 키 전달).
- 크론 작업은 `cron:<job.id>`를 사용합니다.
- 훅은 명시적으로 설정하지 않으면 `hook:<uuid>`를 사용합니다.
- 노드 세션은 명시적으로 설정하지 않으면 `node-<nodeId>`를 사용합니다.

`global`과 `unknown`은 예약된 값이며 나열되지 않습니다. 만약 `session.scope = "global"`이면, 모든 도구에게 이를 `main`으로 대체하여 호출자가 `global`을 보지 않도록 합니다.

## sessions_list

세션을 행의 배열로 나열합니다.

매개변수:

- `kinds?: string[]` 필터: `"main" | "group" | "cron" | "hook" | "node" | "other"` 중 하나
- `limit?: number` 최대 행 수 (기본값: 서버 기본값, 예: 200)
- `activeMinutes?: number` N분 이내에 업데이트된 세션만
- `messageLimit?: number` 0 = 메시지 없음 (기본값 0); >0 = 마지막 N개의 메시지 포함

동작:

- `messageLimit > 0`이면 세션별로 `chat.history`를 가져와 마지막 N개의 메시지를 포함합니다.
- 도구 결과는 목록 출력에서 제외됩니다; 도구 메시지는 `sessions_history`를 사용하세요.
- **샌드박스 격리**된 에이전트 세션에서 실행될 때, 세션 도구는 기본값으로 **생성된 세션만 보기**로 설정됩니다 (아래 참조).

행 형식 (JSON):

- `key`: 세션 키 (문자열)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (가능하면 그룹 표시 레이블)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (세션이 설정된 경우 재정의)
- `lastChannel`, `lastTo`
- `deliveryContext` (사용 가능할 때 정규화된 `{ channel, to, accountId }`)
- `transcriptPath` (스토어 디렉터리 및 sessionId에서 파생된 최선의 경로)
- `messages?` (`messageLimit > 0`일 때만)

## sessions_history

하나의 세션에 대한 기록을 가져옵니다.

매개변수:

- `sessionKey` (필수; `sessions_list`에서 세션 키 또는 `sessionId` 수락)
- `limit?: number` 최대 메시지 수 (서버에서 제한)
- `includeTools?: boolean` (기본값 false)

동작:

- `includeTools=false`는 `role: "toolResult"` 메시지를 필터링합니다.
- 원시 기록 형식의 메시지 배열을 반환합니다.
- `sessionId`가 주어지면, OpenClaw는 해당하는 세션 키로 해석합니다 (없는 id 오류).

## sessions_send

다른 세션으로 메시지를 보냅니다.

매개변수:

- `sessionKey` (필수; `sessions_list`에서 세션 키 또는 `sessionId` 수락)
- `message` (필수)
- `timeoutSeconds?: number` (기본값 >0; 0 = 비동기 처리)

동작:

- `timeoutSeconds = 0`: 큐에 추가하고 `{ runId, status: "accepted" }`를 반환합니다.
- `timeoutSeconds > 0`: 완료될 때까지 최대 N초 대기한 후 `{ runId, status: "ok", reply }`를 반환합니다.
- 대기 시간이 초과되면: `{ runId, status: "timeout", error }`. 실행은 계속되며, 나중에 `sessions_history`를 호출합니다.
- 실행이 실패하면: `{ runId, status: "error", error }`.
- 주요 실행이 완료된 후 알림 전달이 시도되며 최선의 노력을 기울입니다; `status: "ok"`는 알림이 전달되었음을 보장하지 않습니다.
- 게이트웨이 `agent.wait`를 통해 대기하여 (서버 사이드) 재연결이 대기를 끊지 않습니다.
- 주요 실행에는 에이전트 간 메시지 컨텍스트가 주입됩니다.
- 세션 간 메시지는 `message.provenance.kind = "inter_session"`으로 보존되어 전사 독자가 라우팅된 에이전트 지침과 외부 사용자 입력을 구별할 수 있습니다.
- 주요 실행이 완료된 후, OpenClaw는 **응답회귀 루프**를 실행합니다:
  - 2라운드 이상은 요청자와 대상 에이전트 간에 번갈아 가며 이루어집니다.
  - 정확히 `REPLY_SKIP`을 응답하여 핑퐁을 멈춥니다.
  - 최대 회전 수는 `session.agentToAgent.maxPingPongTurns` (0–5, 기본값 5)입니다.
- 루프가 끝나면, OpenClaw는 **에이전트 대 에이전트 알림 단계**를 수행합니다 (대상 에이전트만):
  - 정확히 `ANNOUNCE_SKIP`을 응답하여 침묵을 유지합니다.
  - 다른 모든 응답은 대상 채널로 전송됩니다.
  - 알림 단계는 원래 요청 + 1라운드 응답 + 최신 핑퐁 응답을 포함합니다.

## 채널 필드

- 그룹의 경우, `channel`은 세션 항목에 기록된 채널입니다.
- 다이렉트 채팅의 경우, `channel`은 `lastChannel`에서 맵핑됩니다.
- 크론/훅/노드의 경우, `channel`은 `internal`입니다.
- 누락될 경우, `channel`은 `unknown`입니다.

## 보안 / 전송 정책

채널/채팅 유형별 정책 기반 차단 (세션 id별 아님).

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

런타임 재정의 (세션 항목별):

- `sendPolicy: "allow" | "deny"` (설정되지 않음 = 설정 상속)
- `sessions.patch`를 통해 또는 소유자 전용 `/send on|off|inherit` (독립형 메시지)로 설정 가능합니다.

집행 지점:

- `chat.send` / `agent` (게이트웨이)
- 자동 응답 전송 로직

## sessions_spawn

격리된 세션에서 하위 에이전트 실행을 생성하고 요청자 채팅 채널에 결과를 알립니다.

매개변수:

- `task` (필수)
- `label?` (옵션; 로그/UI에 사용)
- `agentId?` (옵션; 허용되면 다른 에이전트 id 아래에서 생성)
- `model?` (옵션; 하위 에이전트 모델 재정의; 잘못된 값은 오류 발생)
- `runTimeoutSeconds?` (기본값 0; 설정되면 하위 에이전트 실행이 N초 후에 중단됨)
- `cleanup?` (`delete|keep`, 기본값 `keep`)

허용 목록:

- `agents.list[].subagents.allowAgents`: `agentId`를 통해 허용되는 에이전트 ids 목록 (`["*"]`은 모두 허용). 기본값: 요청자 에이전트만.

디바이스 검색:

- `agents_list`를 사용하여 `sessions_spawn`에 허용되는 에이전트 ids를 발견합니다.

동작:

- `agent:<agentId>:subagent:<uuid>` 세션을 `deliver: false`로 시작합니다.
- 하위 에이전트는 **세션 도구를 제외한** 전체 도구 세트를 기본값으로 사용합니다 (`tools.subagents.tools`을 통해 구성 가능).
- 하위 에이전트는 `sessions_spawn`을 호출할 수 없습니다 (하위 에이전트 → 하위 에이전트 생성 없음).
- 항상 비동기 처리: `{ status: "accepted", runId, childSessionKey }`를 즉시 반환합니다.
- 완료 후, OpenClaw는 하위 에이전트 **알림 단계**를 실행하고 요청자 채팅 채널에 결과를 게시합니다.
  - 어시스턴트 최종 응답이 비어 있으면, 하위 에이전트 기록의 최신 `toolResult`가 `Result`로 포함됩니다.
- 알림 단계 동안 정확히 `ANNOUNCE_SKIP`로 응답하여 침묵을 유지합니다.
- 알림 응답은 `Status`/`Result`/`Notes`로 정규화됩니다; `Status`는 모델 텍스트가 아닌 런타임 결과에서 가져옵니다.
- 하위 에이전트 세션은 `agents.defaults.subagents.archiveAfterMinutes` (기본값: 60) 후 자동 아카이브됩니다.
- 알림 응답은 실행 시간, 토큰, sessionKey/sessionId, 전사 경로 및 선택적 비용을 포함한 통계 라인을 포함합니다.

## 샌드박스 세션 가시성

세션 도구는 크로스 세션 접근을 줄이기 위해 스코프를 설정할 수 있습니다.

기본 동작:

- `tools.sessions.visibility`는 `tree`(현재 세션 + 생성된 하위 에이전트 세션)로 기본 설정됩니다.
- 샌드박스 격리 세션의 경우, `agents.defaults.sandbox.sessionToolsVisibility`가 가시성을 굳이 고정할 수 있습니다.

구성:

```json5
{
  tools: {
    sessions: {
      // "self" | "tree" | "agent" | "all"
      // 기본값: "tree"
      visibility: "tree",
    },
  },
  agents: {
    defaults: {
      sandbox: {
        // 기본값: "spawned"
        sessionToolsVisibility: "spawned", // 또는 "all"
      },
    },
  },
}
```

주의사항:

- `self`: 현재 세션 키만.
- `tree`: 현재 세션 + 현재 세션에서 생성된 세션.
- `agent`: 현재 에이전트 id에 속하는 모든 세션.
- `all`: 모든 세션 (크로스 에이전트 접근은 여전히 `tools.agentToAgent`가 필요).
- 세션이 샌드박스 격리되고 `sessionToolsVisibility="spawned"`이면, OpenClaw는 가시성을 `tree`로 고정합니다. `tools.sessions.visibility="all"`로 설정하더라도 마찬가지입니다.