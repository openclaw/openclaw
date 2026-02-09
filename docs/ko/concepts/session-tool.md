---
summary: "세션을 나열하고, 기록을 가져오며, 세션 간 메시지를 전송하기 위한 에이전트 세션 도구"
read_when:
  - 세션 도구를 추가하거나 수정할 때
title: "세션 도구"
---

# 세션 도구

목표: 에이전트가 세션을 나열하고, 기록을 가져오며, 다른 세션으로 전송할 수 있도록 하는 작고 오용하기 어려운 도구 세트입니다.

## 도구 이름

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## 키 모델

- 메인 다이렉트 채팅 버킷은 항상 리터럴 키 `"main"` 입니다(현재 에이전트의 메인 키로 해석됨).
- 그룹 채팅은 `agent:<agentId>:<channel>:group:<id>` 또는 `agent:<agentId>:<channel>:channel:<id>` 를 사용합니다(전체 키를 전달).
- 크론 작업은 `cron:<job.id>` 를 사용합니다.
- 훅은 명시적으로 설정하지 않는 한 `hook:<uuid>` 을 사용합니다.
- 노드 세션은 명시적으로 설정하지 않는 한 `node-<nodeId>` 을 사용합니다.

`global` 와 `unknown` 은 예약된 값이며 절대 나열되지 않습니다. `session.scope = "global"` 인 경우, 모든 도구에서 이를 `main` 로 별칭 처리하여 호출자가 `global` 을 보지 않도록 합니다.

## sessions_list

세션을 행 배열로 나열합니다.

매개변수:

- `kinds?: string[]` 필터: `"main" | "group" | "cron" | "hook" | "node" | "other"` 중 하나
- `limit?: number` 최대 행 수(기본값: 서버 기본값, 예: 200으로 제한)
- `activeMinutes?: number` N 분 이내에 업데이트된 세션만 포함
- `messageLimit?: number` 0 = 메시지 없음(기본값 0); 0 초과 = 마지막 N 개 메시지 포함

동작:

- `messageLimit > 0` 는 세션당 `chat.history` 을 가져오고 마지막 N 개 메시지를 포함합니다.
- 도구 결과는 목록 출력에서 필터링됩니다. 도구 메시지는 `sessions_history` 를 사용하십시오.
- **샌드박스화된** 에이전트 세션에서 실행할 때, 세션 도구는 기본적으로 **생성된 세션만 가시** 합니다(아래 참조).

행 형태(JSON):

- `key`: 세션 키(string)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (가능한 경우 그룹 표시 레이블)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (설정된 경우 세션 오버라이드)
- `lastChannel`, `lastTo`
- `deliveryContext` (사용 가능한 경우 정규화된 `{ channel, to, accountId }`)
- `transcriptPath` (스토어 디렉토리 + sessionId 에서 파생된 최선 노력 경로)
- `messages?` (`messageLimit > 0` 인 경우에만)

## sessions_history

하나의 세션에 대한 트랜스크립트를 가져옵니다.

매개변수:

- `sessionKey` (필수; 세션 키 또는 `sessions_list` 의 `sessionId` 를 허용)
- `limit?: number` 최대 메시지 수(서버에서 제한)
- `includeTools?: boolean` (기본값 false)

동작:

- `includeTools=false` 는 `role: "toolResult"` 메시지를 필터링합니다.
- 원본 트랜스크립트 형식의 메시지 배열을 반환합니다.
- `sessionId` 가 주어지면, OpenClaw 는 이를 해당 세션 키로 해석합니다(누락된 id 는 오류).

## sessions_send

다른 세션으로 메시지를 전송합니다.

매개변수:

- `sessionKey` (필수; 세션 키 또는 `sessions_list` 의 `sessionId` 를 허용)
- `message` (필수)
- `timeoutSeconds?: number` (기본값 >0; 0 = fire-and-forget)

동작:

- `timeoutSeconds = 0`: 큐에 넣고 `{ runId, status: "accepted" }` 를 반환합니다.
- `timeoutSeconds > 0`: 완료될 때까지 최대 N 초 대기한 후 `{ runId, status: "ok", reply }` 를 반환합니다.
- 대기가 타임아웃되면: `{ runId, status: "timeout", error }`. 실행은 계속되며, 나중에 `sessions_history` 를 호출하십시오.
- 실행이 실패하면: `{ runId, status: "error", error }`.
- 전달 알림 실행은 기본 실행이 완료된 후에 수행되며 최선 노력 방식입니다. `status: "ok"` 는 알림 전달을 보장하지 않습니다.
- 대기는 게이트웨이 `agent.wait` (서버 측)를 통해 이루어지므로 재연결 시에도 대기가 중단되지 않습니다.
- 기본 실행을 위해 에이전트 간 메시지 컨텍스트가 주입됩니다.
- 기본 실행이 완료된 후, OpenClaw 는 **응답-되돌림 루프** 를 실행합니다:
  - 2 라운드 이상에서는 요청자와 대상 에이전트가 번갈아가며 응답합니다.
  - 핑퐁을 중지하려면 정확히 `REPLY_SKIP` 으로 응답하십시오.
  - 최대 턴 수는 `session.agentToAgent.maxPingPongTurns` (0–5, 기본값 5)입니다.
- 루프가 종료되면, OpenClaw 는 **에이전트 간 알림 단계** 를 실행합니다(대상 에이전트만):
  - 침묵을 유지하려면 정확히 `ANNOUNCE_SKIP` 로 응답하십시오.
  - 그 외의 응답은 대상 채널로 전송됩니다.
  - 알림 단계에는 원본 요청 + 1 라운드 응답 + 최신 핑퐁 응답이 포함됩니다.

## 채널 필드

- 그룹의 경우, `channel` 는 세션 항목에 기록된 채널입니다.
- 다이렉트 채팅의 경우, `channel` 는 `lastChannel` 에서 매핑됩니다.
- 크론/훅/노드의 경우, `channel` 는 `internal` 입니다.
- 누락된 경우, `channel` 는 `unknown` 입니다.

## 보안 / 전송 정책

채널/채팅 유형 기준의 정책 기반 차단(세션 id 기준이 아님).

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

런타임 오버라이드(세션 항목별):

- `sendPolicy: "allow" | "deny"` (미설정 = 구성 상속)
- `sessions.patch` 또는 소유자 전용 `/send on|off|inherit` (독립 메시지)로 설정 가능

적용 지점:

- `chat.send` / `agent` (Gateway(게이트웨이))
- 자동 응답 전달 로직

## sessions_spawn

격리된 세션에서 하위 에이전트 실행을 생성하고 결과를 요청자 채팅 채널로 알립니다.

매개변수:

- `task` (필수)
- `label?` (선택; 로그/UI 용)
- `agentId?` (선택; 허용되는 경우 다른 에이전트 id 하위에서 생성)
- `model?` (선택; 하위 에이전트 모델을 오버라이드; 유효하지 않은 값은 오류)
- `runTimeoutSeconds?` (기본값 0; 설정 시 N 초 후 하위 에이전트 실행 중단)
- `cleanup?` (`delete|keep`, 기본값 `keep`)

허용 목록:

- `agents.list[].subagents.allowAgents`: `agentId` 를 통해 허용되는 에이전트 id 목록(`["*"]` 로 모두 허용). 기본값: 요청자 에이전트만.

디스커버리:

- `agents_list` 를 사용하여 `sessions_spawn` 에 대해 허용되는 에이전트 id 를 확인합니다.

동작:

- `deliver: false` 를 사용하여 새로운 `agent:<agentId>:subagent:<uuid>` 세션을 시작합니다.
- 하위 에이전트는 기본적으로 전체 도구 세트에서 **세션 도구를 제외** 하고 사용합니다(`tools.subagents.tools` 를 통해 구성 가능).
- 하위 에이전트는 `sessions_spawn` 를 호출할 수 없습니다(하위 에이전트 → 하위 에이전트 생성 금지).
- 항상 논블로킹: 즉시 `{ status: "accepted", runId, childSessionKey }` 를 반환합니다.
- 완료 후, OpenClaw 는 하위 에이전트 **알림 단계** 를 실행하고 결과를 요청자 채팅 채널에 게시합니다.
- 알림 단계 중 침묵을 유지하려면 정확히 `ANNOUNCE_SKIP` 으로 응답하십시오.
- 알림 응답은 `Status`/`Result`/`Notes` 로 정규화됩니다. `Status` 는 모델 텍스트가 아닌 런타임 결과에서 가져옵니다.
- 하위 에이전트 세션은 `agents.defaults.subagents.archiveAfterMinutes` 후 자동 보관됩니다(기본값: 60).
- 알림 응답에는 통계 라인(실행 시간, 토큰, sessionKey/sessionId, 트랜스크립트 경로, 선택적 비용)이 포함됩니다.

## 샌드박스 세션 가시성

샌드박스화된 세션은 세션 도구를 사용할 수 있지만, 기본적으로 `sessions_spawn` 를 통해 생성한 세션만 볼 수 있습니다.

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
