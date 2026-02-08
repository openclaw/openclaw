---
read_when:
    - 세션 도구 추가 또는 수정
summary: 세션 나열, 기록 가져오기, 세션 간 메시지 전송을 위한 에이전트 세션 도구
title: 세션 도구
x-i18n:
    generated_at: "2026-02-08T15:54:25Z"
    model: gtx
    provider: google-translate
    source_hash: cb6e0982ebf507bcf9de4bb17719759c2b6d3e519731c845580a55279084e4c8
    source_path: concepts/session-tool.md
    workflow: 15
---

# 세션 도구

목표: 에이전트가 세션을 나열하고, 기록을 가져오고, 다른 세션으로 보낼 수 있는 작고 오용하기 어려운 도구 세트입니다.

## 도구 이름

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## 주요 모델

- 기본 직접 채팅 버킷은 항상 문자 그대로의 키입니다. `"main"` (현재 에이전트의 기본 키로 해석됨)
- 그룹 채팅 사용 `agent:<agentId>:<channel>:group:<id>` 또는 `agent:<agentId>:<channel>:channel:<id>` (전체 키 전달).
- 크론 작업 사용 `cron:<job.id>`.
- 후크 사용 `hook:<uuid>` 명시적으로 설정하지 않는 한.
- 노드 세션 사용 `node-<nodeId>` 명시적으로 설정하지 않는 한.

`global` 그리고 `unknown` 예약된 값이며 나열되지 않습니다. 만약에 `session.scope = "global"`, 우리는 그것을 다음과 같이 별칭으로 지정합니다. `main` 발신자가 볼 수 없도록 모든 도구에 대해 `global`.

## 세션_목록

세션을 행 배열로 나열합니다.

매개변수:

- `kinds?: string[]` 필터: 다음 중 하나 `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` 최대 행(기본값: 서버 기본값, 클램프, 예: 200)
- `activeMinutes?: number` N분 이내에 세션만 업데이트됨
- `messageLimit?: number` 0 = 메시지 없음(기본값 0); >0 = 마지막 N개 메시지 포함

행동:

- `messageLimit > 0` 가져오기 `chat.history` 세션당 마지막 N개 메시지를 포함합니다.
- 도구 결과는 목록 출력에서 ​​필터링됩니다. 사용 `sessions_history` 도구 메시지의 경우.
- 에서 실행할 때 **샌드박스 처리된** 상담원 세션, 세션 도구의 기본값은 다음과 같습니다. **생성된 전용 가시성** (아래 참조).

행 모양(JSON):

- `key`: 세션 키(문자열)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (사용 가능한 경우 그룹 표시 라벨)
- `updatedAt` (밀리초)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (설정된 경우 세션 재정의)
- `lastChannel`, `lastTo`
- `deliveryContext` (정규화 `{ channel, to, accountId }` 가능한 경우)
- `transcriptPath` (스토어 디렉토리 + sessionId에서 파생된 최선의 경로)
- `messages?` (때만 `messageLimit > 0`)

## 세션_기록

한 세션의 기록을 가져옵니다.

매개변수:

- `sessionKey` (필수; 세션 키 또는 `sessionId` ~에서 `sessions_list`)
- `limit?: number` 최대 메시지(서버 클램프)
- `includeTools?: boolean` (기본값은 거짓)

행동:

- `includeTools=false` 필터 `role: "toolResult"` 메시지.
- 원시 기록 형식으로 메시지 배열을 반환합니다.
- 주어진 때 `sessionId`, OpenClaw는 이를 해당 세션 키로 확인합니다(ID 누락 오류).

## 세션_전송

다른 세션에 메시지를 보냅니다.

매개변수:

- `sessionKey` (필수; 세션 키 또는 `sessionId` ~에서 `sessions_list`)
- `message` (필수의)
- `timeoutSeconds?: number` (기본값 >0; 0 = 실행 후 잊어버리기)

행동:

- `timeoutSeconds = 0`: 대기열에 추가하고 반환 `{ runId, status: "accepted" }`.
- `timeoutSeconds > 0`: 완료될 때까지 최대 N초를 기다린 후 반환합니다. `{ runId, status: "ok", reply }`.
- 대기 시간이 초과된 경우: `{ runId, status: "timeout", error }`. 계속 실행됩니다. 부르다 `sessions_history` 나중에.
- 실행이 실패하는 경우: `{ runId, status: "error", error }`.
- 기본 실행이 완료된 후 전달 실행을 알리는 것이 최선의 방법입니다. `status: "ok"` 발표 내용이 전달되었음을 보장하지 않습니다.
- 게이트웨이를 통해 대기 `agent.wait` (서버 측) 다시 연결해도 대기 시간이 중단되지 않습니다.
- 기본 실행을 위해 에이전트 간 메시지 컨텍스트가 삽입됩니다.
- 기본 실행이 완료된 후 OpenClaw는 다음을 실행합니다. **회신 루프**: 
  - 2라운드 이상에서는 요청자와 대상 에이전트가 번갈아 진행됩니다.
  - 정확하게 답장하세요 `REPLY_SKIP` 탁구를 멈추려고 합니다.
  - 최대 턴은 `session.agentToAgent.maxPingPongTurns` (0–5, 기본값은 5).
- 루프가 끝나면 OpenClaw는 다음을 실행합니다. **에이전트 간 알림 단계** (대상 에이전트에만 해당):
  - 정확하게 답장하세요 `ANNOUNCE_SKIP` 침묵을 유지하기 위해.
  - 다른 모든 응답은 대상 채널로 전송됩니다.
  - 공지 단계에는 원래 요청 + 1라운드 응답 + 최신 핑퐁 응답이 포함됩니다.

## 채널 필드

- 단체의 경우, `channel` 세션 항목에 녹화된 채널입니다.
- 직접 채팅의 경우, `channel` 지도 `lastChannel`.
- 크론/후크/노드의 경우 `channel` ~이다 `internal`.
- 누락된 경우, `channel` ~이다 `unknown`.

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

- `sendPolicy: "allow" | "deny"` (설정되지 않음 = 구성 상속)
- 다음을 통해 설정 가능 `sessions.patch` 또는 소유자 전용 `/send on|off|inherit` (독립형 메시지).

시행 포인트:

- `chat.send` / `agent` (게이트웨이)
- 자동 회신 전달 논리

## session_spawn

격리된 세션에서 하위 에이전트 실행을 생성하고 결과를 요청자 채팅 채널에 다시 알립니다.

매개변수:

- `task` (필수의)
- `label?` (선택사항, 로그/UI에 사용됨)
- `agentId?` (선택 사항, 허용되는 경우 다른 에이전트 ID로 생성)
- `model?` (선택 사항, 하위 에이전트 모델 재정의, 잘못된 값 오류)
- `runTimeoutSeconds?` (기본값 0; 설정 시 N초 후에 하위 에이전트 실행을 중단합니다.)
- `cleanup?` (`delete|keep`, 기본 `keep`)

허용 목록:

- `agents.list[].subagents.allowAgents`: 다음을 통해 허용되는 에이전트 ID 목록 `agentId` (`["*"]` 허용하려면). 기본값: 요청자 에이전트만.

발견:

- 사용 `agents_list` 어떤 에이전트 ID가 허용되는지 확인하려면 `sessions_spawn`.

행동:

- 새로운 시작 `agent:<agentId>:subagent:<uuid>` 세션 `deliver: false`.
- 하위 에이전트는 기본적으로 전체 도구 세트를 사용합니다. **마이너스 세션 도구** (다음을 통해 구성 가능 `tools.subagents.tools`).
- 하위 상담원은 통화할 수 없습니다. `sessions_spawn` (하위 에이전트 없음 → 하위 에이전트 생성)
- 항상 비차단: 반환 `{ status: "accepted", runId, childSessionKey }` 즉시.
- 완료 후 OpenClaw는 하위 에이전트를 실행합니다. **단계를 발표하다** 결과를 요청자 채팅 채널에 게시합니다.
- 정확하게 답장하세요 `ANNOUNCE_SKIP` 발표 단계에서는 침묵을 지킵니다.
- 공지 답변은 다음과 같이 정규화됩니다. `Status` / `Result` / `Notes`; `Status` 런타임 결과(모델 텍스트 아님)에서 옵니다.
- 하위 에이전트 세션은 다음 이후에 자동 보관됩니다. `agents.defaults.subagents.archiveAfterMinutes` (기본값: 60).
- 공지 답변에는 통계 줄(런타임, 토큰, sessionKey/sessionId, 기록 경로 및 선택적 비용)이 포함됩니다.

## 샌드박스 세션 가시성

샌드박스 세션은 세션 도구를 사용할 수 있지만 기본적으로는 자신이 생성한 세션만 ​​볼 수 있습니다. `sessions_spawn`.

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
