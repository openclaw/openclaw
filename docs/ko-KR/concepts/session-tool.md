---
summary: "세션 나열, 기록 가져오기, 교차 세션 메시지 전송을 위한 에이전트 세션 도구"
read_when:
  - 세션 도구 추가 또는 수정
title: "세션 도구"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/concepts/session-tool.md
  workflow: 15
---

# 세션 도구

목표: 에이전트가 세션을 나열하고, 기록을 가져오고, 다른 세션으로 메시지를 보낼 수 있는 작고 오용하기 어려운 도구 세트입니다.

## 도구 이름

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## 키 모델

- 메인 직접 채팅 버킷은 항상 리터럴 키 `"main"`입니다(현재 에이전트의 메인 키로 확인됨).
- 그룹 채팅은 `agent:<agentId>:<channel>:group:<id>` 또는 `agent:<agentId>:<channel>:channel:<id>`를 사용합니다(전체 키를 전달).
- Cron 작업은 `cron:<job.id>`를 사용합니다.
- 훅은 명시적으로 설정되지 않은 한 `hook:<uuid>`를 사용합니다.
- 노드 세션은 명시적으로 설정되지 않은 한 `node-<nodeId>`를 사용합니다.

`global` 및 `unknown`은 예약된 값이며 나열되지 않습니다. `session.scope = "global"`이면 호출자가 `global`을 볼 수 없도록 모든 도구에서 `main`으로 별칭을 지정합니다.

## sessions_list

행의 배열로 세션을 나열합니다.

매개변수:

- `kinds?: string[]` 필터: `"main" | "group" | "cron" | "hook" | "node" | "other"` 중 하나
- `limit?: number` 최대 행(기본값: 서버 기본값, 예: 200으로 고정)
- `activeMinutes?: number` N분 이내에 업데이트된 세션만
- `messageLimit?: number` 0 = 메시지 없음(기본값 0); >0 = 마지막 N개 메시지 포함

동작:

- `messageLimit > 0` - 세션당 `chat.history`를 가져오고 마지막 N개 메시지를 포함합니다.
- 도구 결과는 목록 출력에서 필터링됩니다; 도구 메시지의 경우 `sessions_history`를 사용하세요.
- **샌드박스화된** 에이전트 세션에서 실행할 때 세션 도구는 기본값으로 **생성된 것만 표시**(아래 참조)합니다.

행 형태(JSON):

- `key`: 세션 키(문자열)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (그룹 표시 레이블이 사용 가능한 경우)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (설정된 경우 세션 무시)
- `lastChannel`, `lastTo`
- `deliveryContext` (사용 가능한 경우 정규화된 `{ channel, to, accountId }`)
- `transcriptPath` (저장소 디렉터리 + sessionId에서 파생된 최선의 경로)
- `messages?` (`messageLimit > 0`일 때만)

## sessions_history

하나의 세션에 대한 기록을 가져옵니다.

매개변수:

- `sessionKey` (필수; 세션 키 또는 `sessions_list`의 `sessionId` 허용)
- `limit?: number` 최대 메시지(서버 고정)
- `includeTools?: boolean` (기본값 false)

동작:

- `includeTools=false` - `role: "toolResult"` 메시지를 필터링합니다.
- 원본 기록 형식의 메시지 배열을 반환합니다.
- `sessionId`가 주어지면 OpenClaw는 해당 세션 키로 확인합니다(누락된 id 오류).

## sessions_send

다른 세션으로 메시지를 보냅니다.

매개변수:

- `sessionKey` (필수; 세션 키 또는 `sessions_list`의 `sessionId` 허용)
- `message` (필수)
- `timeoutSeconds?: number` (기본값 >0; 0 = 실행 후 잊음)

동작:

- `timeoutSeconds = 0`: 대기열에 추가하고 `{ runId, status: "accepted" }`를 반환합니다.
- `timeoutSeconds > 0`: 최대 N초 동안 완료를 기다린 다음 `{ runId, status: "ok", reply }`를 반환합니다.
- 대기가 시간 초과되면: `{ runId, status: "timeout", error }`. 실행은 계속됩니다; 나중에 `sessions_history`를 호출하세요.
- 실행이 실패하면: `{ runId, status: "error", error }`.
- 공지 전달 실행은 기본 실행이 완료된 후 최선의 방법으로 실행됩니다; `status: "ok"`는 공지가 전달되었음을 보장하지 않습니다.
- Gateway `agent.wait`(서버 측)을 통해 대기하므로 재연결이 대기를 중단하지 않습니다.
- 에이전트 간 메시지 컨텍스트는 기본 실행을 위해 주입됩니다.
- 세션 간 메시지는 `message.provenance.kind = "inter_session"`으로 지속되므로 기록 리더는 라우팅된 에이전트 지침을 외부 사용자 입력과 구분할 수 있습니다.
- 기본 실행이 완료되면 OpenClaw는 **회신 루프**를 실행합니다:
  - 라운드 2 이상은 요청자와 대상 에이전트 간에 교대로 진행합니다.
  - 정확히 `REPLY_SKIP`으로 회신하여 핑-퐁을 중지하세요.
  - 최대 턴은 `session.agentToAgent.maxPingPongTurns` (0–5, 기본값 5)입니다.
- 루프가 끝나면 OpenClaw는 **에이전트 간 공지 단계**(대상 에이전트만)를 실행합니다:
  - 정확히 `ANNOUNCE_SKIP`으로 회신하여 침묵 유지.
  - 다른 회신은 대상 채널로 전송됩니다.
  - 공지 단계에는 원본 요청 + 라운드 1 회신 + 최신 핑-퐁 회신이 포함됩니다.

## 채널 필드

- 그룹의 경우 `channel`은 세션 항목에 기록된 채널입니다.
- 직접 채팅의 경우 `channel`은 `lastChannel`에서 매핑됩니다.
- cron/hook/node의 경우 `channel`은 `internal`입니다.
- 누락된 경우 `channel`은 `unknown`입니다.

## 보안 / 전송 정책

채널/채팅 유형별 정책 기반 차단(세션 id당 아님).

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

런타임 무시(세션 항목당):

- `sendPolicy: "allow" | "deny"` (미설정 = 설정 상속)
- `sessions.patch` 또는 소유자 전용 `/send on|off|inherit` (독립 실행형 메시지)을 통해 설정 가능합니다.

시행 지점:

- `chat.send` / `agent` (Gateway)
- 자동 회신 전달 로직

## sessions_spawn

격리된 세션에서 하위 에이전트 실행을 생성하고 결과를 요청자 채팅 채널로 공지합니다.

매개변수:

- `task` (필수)
- `label?` (선택적; 로그/UI에 사용됨)
- `agentId?` (선택적; 허용되면 다른 에이전트 id 아래에서 생성)
- `model?` (선택적; 하위 에이전트 모델 무시; 잘못된 값 오류)
- `thinking?` (선택적; 하위 에이전트 실행을 위한 사고 수준 무시)
- `runTimeoutSeconds?` (설정되면 `agents.defaults.subagents.runTimeoutSeconds`로 기본값 설정, 그렇지 않으면 `0`; 설정되면 N초 후 하위 에이전트 실행 중단)
- `thread?` (기본값 false; 채널/플러그인에서 지원할 때 이 생성을 위한 스레드 바운드 라우팅 요청)
- `mode?` (`run|session`; 기본값은 `run`이지만 `thread=true`일 때 `session`으로 기본값 설정; `mode="session"`은 `thread=true` 필요)
- `cleanup?` (`delete|keep`, 기본값 `keep`)
- `sandbox?` (`inherit|require`, 기본값 `inherit`; `require`는 대상 자식 런타임이 샌드박스화되지 않은 한 생성 거부)

허용 목록:

- `agents.list[].subagents.allowAgents`: `agentId`를 통해 허용된 에이전트 id 목록(`["*"]`은 모두 허용). 기본값: 요청자 에이전트만.
- 샌드박스 상속 가드: 요청자 세션이 샌드박스화되면 `sessions_spawn`은 샌드박스화되지 않은 대상을 거부합니다.

발견:

- 생성 어느 에이전트 id가 `sessions_spawn`을 위해 허용되는지 알아보려면 `agents_list`를 사용하세요.

동작:

- 새로운 `agent:<agentId>:subagent:<uuid>` 세션을 `deliver: false`로 시작합니다.
- 하위 에이전트는 기본값으로 전체 도구 세트 **세션 도구 제외**(도구를 통해 설정 가능)입니다.
- 하위 에이전트는 `sessions_spawn`을 호출할 수 없습니다(하위 에이전트 → 하위 에이전트 생성 없음).
- 항상 논-블로킹: `{ status: "accepted", runId, childSessionKey }`을 즉시 반환합니다.
- `thread=true`일 때 채널 플러그인은 스레드 대상에 전달/라우팅을 바인딩할 수 있습니다(Discord 지원은 `session.threadBindings.*` 및 `channels.discord.threadBindings.*`로 제어됨).
- 완료 후 OpenClaw는 하위 에이전트 **공지 단계**를 실행하고 결과를 요청자 채팅 채널에 게시합니다.
  - 어시스턴트 최종 회신이 비어 있으면 하위 에이전트 기록의 최신 `toolResult`가 `Result`로 포함됩니다.
- 공지 단계 중 정확히 `ANNOUNCE_SKIP`으로 회신하여 침묵 유지.
- 공지 회신은 `Status`/`Result`/`Notes`로 정규화됩니다; `Status`는 런타임 결과에서 나옵니다(모델 텍스트 아님).
- 하위 에이전트 세션은 `agents.defaults.subagents.archiveAfterMinutes` (기본값: 60) 후 자동 보관됩니다.
- 공지 회신에는 통계 라인(런타임, 토큰, sessionKey/sessionId, 기록 경로, 선택적 비용)이 포함됩니다.

## 샌드박스 세션 표시

세션 도구는 교차 세션 접근을 줄이기 위해 범위를 지정할 수 있습니다.

기본 동작:

- `tools.sessions.visibility`는 `tree`로 기본값 설정됩니다(현재 세션 + 생성된 하위 에이전트 세션).
- 샌드박스화된 세션의 경우 `agents.defaults.sandbox.sessionToolsVisibility`는 표시를 하드 클램프할 수 있습니다.

설정:

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
- `all`: 모든 세션(교차 에이전트 접근은 여전히 `tools.agentToAgent` 필요).
- 세션이 샌드박스화되고 `sessionToolsVisibility="spawned"`일 때 OpenClaw는 `tools.sessions.visibility="all"`로 설정하더라도 표시를 `tree`로 클램프합니다.
