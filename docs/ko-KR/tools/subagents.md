---
summary: "Sub-agents: spawning isolated agent runs that announce results back to the requester chat"
read_when:
  - 에이전트를 통한 백그라운드/병렬 작업을 원하는 경우
  - sessions_spawn 또는 하위 에이전트 도구 정책을 변경하는 경우
  - 스레드 바인딩 서브에이전트 세션을 구현하거나 문제를 해결하는 경우
title: "하위 에이전트"
---

# 하위 에이전트

하위 에이전트는 기존 에이전트 실행에서 생성된 백그라운드 에이전트 실행입니다. 이들은 자신만의 세션(`agent:<agentId>:subagent:<uuid>`)에서 실행되며, 완료되면 요청자 채팅 채널에 **결과를 알립니다**.

## 슬래시 명령어

현재 세션의 하위 에이전트 실행을 검사하거나 제어하기 위해 `/subagents`를 사용하세요:

- `/subagents list`
- `/subagents kill <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`
- `/subagents steer <id|#> <message>`
- `/subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]`

Discord 스레드 바인딩 제어:

- `/focus <subagent-label|session-key|session-id|session-label>`
- `/unfocus`
- `/agents`
- `/session ttl <duration|off>`

`/subagents info`는 실행 메타데이터(상태, 타임스탬프, 세션 ID, 전사 경로, 정리)를 보여줍니다.

### Spawn 동작

`/subagents spawn`은 내부 릴레이가 아닌 사용자 명령으로 백그라운드 하위 에이전트를 시작하며, 실행이 완료될 때 요청자 채팅에 하나의 최종 완료 업데이트를 보냅니다.

- spawn 명령은 비차단입니다; 즉시 실행 ID를 반환합니다.
- 완료 시, 하위 에이전트는 요약/결과 메시지를 요청자 채팅 채널로 알립니다.
- 수동 생성의 경우, 전달은 복원력이 있습니다:
  - OpenClaw는 먼저 안정적인 멱등성 키로 직접 `agent` 전달을 시도합니다.
  - 직접 전달이 실패하면 대기열 라우팅으로 대체합니다.
  - 대기열 라우팅도 사용할 수 없는 경우, 최종 포기 전 짧은 지수 백오프로 공지가 재시도됩니다.
- 완료 메시지는 시스템 메시지이며 다음을 포함합니다:
  - `Result` (`assistant` 답장 텍스트, 또는 어시스턴트 답장이 비어 있는 경우 최신 `toolResult`)
  - `Status` (`completed successfully` / `failed` / `timed out`)
  - 간단한 실행 시간/토큰 통계
- `--model`과 `--thinking`은 해당 특정 실행의 기본값을 재정의합니다.
- 완료 후 세부 정보 및 출력을 검사하려면 `info`/`log`를 사용하세요.
- `/subagents spawn`은 일회성 모드 (`mode: "run"`)입니다. 지속적인 스레드 바인딩 세션을 위해서는 `sessions_spawn`에서 `thread: true` 및 `mode: "session"`을 사용하세요.

주요 목표:

- 메인 실행을 차단하지 않고 "연구/긴 작업/느린 도구" 작업을 병렬화합니다.
- 기본적으로 하위 에이전트를 격리된 상태로 유지합니다 (세션 구분 + 선택적 샌드박스 적용).
- 도구 표면을 오용하기 어렵게 만듭니다: 하위 에이전트는 기본적으로 세션 도구를 받지 않습니다.
- 오케스트레이터 패턴에 대한 구성 가능한 중첩 깊이를 지원합니다.

비용 참고: 각 하위 에이전트에는 자신의 컨텍스트와 토큰 사용량이 있습니다. 무겁거나 반복적인 작업의 경우, 하위 에이전트에 더 저렴한 모델을 설정하고 메인 에이전트를 더 높은 품질의 모델로 유지하세요. 이는 `agents.defaults.subagents.model` 또는 에이전트 별 오버라이드를 통해 구성할 수 있습니다.

## 도구

`sessions_spawn`을 사용하세요:

- 하위 에이전트 실행을 시작합니다 (`deliver: false`, 글로벌 레인: `subagent`)
- 그런 다음 알림 단계를 실행하고 요청자 채팅 채널에 알림 응답을 게시합니다.
- 기본 모델: `agents.defaults.subagents.model`을 설정하지 않는 한 호출자를 상속합니다 (또는 에이전트 별 `agents.list[].subagents.model`); 명시적인 `sessions_spawn.model`이 여전히 우선합니다.
- 기본 사고: `agents.defaults.subagents.thinking`을 설정하지 않는 한 호출자를 상속합니다 (또는 에이전트 별 `agents.list[].subagents.thinking`); 명시적인 `sessions_spawn.thinking`이 여전히 우선합니다.

도구 매개 변수:

- `task` (필수)
- `label?` (옵션)
- `agentId?` (옵션; 다른 에이전트 ID 아래에 생성할 수 있는 경우)
- `model?` (옵션; 하위 에이전트 모델을 재정의합니다. 잘못된 값은 건너뛰고 하위 에이전트는 기본 모델에서 경고와 함께 실행됩니다)
- `thinking?` (옵션; 하위 에이전트 실행의 사고 수준을 재정의합니다)
- `runTimeoutSeconds?` (기본값 `0`; 설정된 경우, 하위 에이전트 실행은 N초 후에 중단됩니다)
- `thread?` (기본값 `false`; `true`이면 이 하위 에이전트 세션에 대한 채널 스레드 바인딩을 요청)
- `mode?` (`run|session`)
  - 기본값은 `run`
  - `thread: true`이고 `mode`가 생략되면 기본값은 `session`
  - `mode: "session"`은 `thread: true`가 필요
- `cleanup?` (`delete|keep`, 기본값 `keep`)

## Discord 스레드 바인딩 세션

스레드 바인딩이 활성화되면, 서브에이전트는 Discord 스레드에 바인딩되어 해당 스레드의 후속 사용자 메시지가 동일한 서브에이전트 세션으로 계속 라우팅될 수 있습니다.

빠른 흐름:

1. `sessions_spawn`에서 `thread: true`를 사용하여 생성합니다 (선택적으로 `mode: "session"`).
2. OpenClaw는 Discord 스레드를 생성하거나 해당 세션 대상에 바인딩합니다.
3. 해당 스레드의 답장 및 후속 메시지가 바인딩된 세션으로 라우팅됩니다.
4. `/session ttl`로 자동 해제 TTL을 확인/업데이트합니다.
5. `/unfocus`로 수동으로 분리합니다.

수동 제어:

- `/focus <target>`은 현재 스레드 (또는 새 스레드)를 서브에이전트/세션 대상에 바인딩합니다.
- `/unfocus`는 현재 Discord 스레드의 바인딩을 제거합니다.
- `/agents`는 활성 실행 및 바인딩 상태를 나열합니다 (`thread:<id>` 또는 `unbound`).
- `/session ttl`은 집중된 Discord 스레드에서만 작동합니다.

설정 스위치:

- 글로벌 기본값: `session.threadBindings.enabled`, `session.threadBindings.ttlHours`
- Discord 오버라이드: `channels.discord.threadBindings.enabled`, `channels.discord.threadBindings.ttlHours`
- 생성 자동 바인딩 활성화: `channels.discord.threadBindings.spawnSubagentSessions`

[Discord](/ko-KR/channels/discord), [설정 레퍼런스](/ko-KR/gateway/configuration-reference), [슬래시 명령](/ko-KR/tools/slash-commands)를 참조하세요.

허용 목록:

- `agents.list[].subagents.allowAgents`: `agentId`를 통해 타겟팅할 수 있는 에이전트 ID 목록입니다 (`["*"]`로 모든 것 허용). 기본값: 요청자 에이전트만.

디스커버리:

- `agents_list`를 사용하여 현재 `sessions_spawn`에 허용된 에이전트 ID를 확인하세요.

자동 보관:

- 하위 에이전트 세션은 `agents.defaults.subagents.archiveAfterMinutes` (기본값: 60) 후 자동으로 보관됩니다.
- 보관은 `sessions.delete`를 사용하고 전사를 `*.deleted.<timestamp>`으로 이름을 변경합니다 (동일 폴더).
- `cleanup: "delete"`는 알림 후 즉시 보관하며 (이름 변경을 통해 여전히 전사를 유지함).
- 자동 보관은 최선을 다해 실행됩니다; 게이트웨이가 다시 시작되면 보류 중인 타이머는 사라집니다.
- `runTimeoutSeconds`는 자동 보관하지 않습니다; 실행만 멈춥니다. 세션은 자동 보관될 때까지 남아 있습니다.
- 자동 보관은 1단계 및 2단계 세션에 동일하게 적용됩니다.

## 중첩 하위 에이전트

기본적으로 하위 에이전트는 자신의 하위 에이전트를 생성할 수 없습니다 (`maxSpawnDepth: 1`). `maxSpawnDepth: 2`를 설정하면 중첩 수준 하나를 허용하며, 이는 **오케스트레이터 패턴**을 가능하게 합니다: 메인 → 오케스트레이터 하위 에이전트 → 작업자 하위 하위 에이전트

### 활성화 방법

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2, // 자식 생성을 허용 (기본값: 1)
        maxChildrenPerAgent: 5, // 에이전트 세션당 최대 활성 자식 (기본값: 5)
        maxConcurrent: 8, // 글로벌 동시성 레인 제한 (기본값: 8)
      },
    },
  },
}
```

### 깊이 수준

| Depth | 세션 키 형식                                 | 역할                                          | 생성 가능 여부                   |
| ----- | -------------------------------------------- | --------------------------------------------- | -------------------------------- |
| 0     | `agent:<id>:main`                            | 메인 에이전트                                 | 항상                             |
| 1     | `agent:<id>:subagent:<uuid>`                 | 하위 에이전트 (깊이 2 허용 시 오케스트레이터) | `maxSpawnDepth >= 2`일 때만 가능 |
| 2     | `agent:<id>:subagent:<uuid>:subagent:<uuid>` | 하위 하위 에이전트 (리프 작업자)              | 불가능                           |

### 알림 체인

결과는 체인을 따라 위로 흘러갑니다:

1. 깊이 2 작업자가 완료됩니다 → 상위 (깊이 1 오케스트레이터)에게 알림
2. 깊이 1 오케스트레이터가 알림을 받고, 결과를 합성하고 완료됩니다 → 메인에 알림
3. 메인 에이전트가 알림을 받고 사용자에게 전달합니다

각 수준은 직접적인 자식으로부터의 알림만 봅니다.

### 깊이별 도구 정책

- **깊이 1 (오케스트레이터, `maxSpawnDepth >= 2`일 때)**: `sessions_spawn`, `subagents`, `sessions_list`, `sessions_history`를 받아 자식을 관리할 수 있습니다. 다른 세션/시스템 도구는 계속 금지됩니다.
- **깊이 1 (리프, `maxSpawnDepth == 1`일 때)**: 세션 도구 없음 (현재 기본 동작).
- **깊이 2 (리프 작업자)**: 세션 도구 없음 — `sessions_spawn`은 깊이 2에서 항상 거부됩니다. 추가 자식을 생성할 수 없습니다.

### 에이전트별 생성 제한

각 에이전트 세션(깊이에 관계없이)은 한 번에 최대 `maxChildrenPerAgent` (기본값: 5) 활성 자식을 가질 수 있습니다. 이는 단일 오케스트레이터에서의 무분별한 확산을 방지합니다.

### 연계 중지

깊이 1 오케스트레이터를 중지하면 깊이 2 자식이 자동으로 중지됩니다:

- 메인 채팅에서 `/stop`을 보내면 모든 깊이 1 에이전트가 중지되고 그들의 깊이 2 자식으로 연계됩니다.
- `/subagents kill <id>`는 특정 하위 에이전트를 중지하고 그 자식으로 연계됩니다.
- `/subagents kill all`은 요청자의 모든 하위 에이전트를 중지하고 연계됩니다.

## 인증

하위 에이전트 인증은 세션 유형이 아닌 **에이전트 ID**로 해결됩니다:

- 하위 에이전트 세션 키는 `agent:<agentId>:subagent:<uuid>`입니다.
- 인증 저장소는 해당 에이전트의 `agentDir`에서 로드됩니다.
- 메인 에이전트의 인증 프로필은 **백업**으로 합류됩니다; 에이전트 프로필은 충돌 시 메인 프로필을 덮어씁니다.

참고: 합병은 추가적이기 때문에 메인 프로필은 항상 백업으로 사용 가능합니다. 에이전트별 완전한 격리된 인증은 아직 지원되지 않습니다.

## 알림

하위 에이전트는 알림 단계를 통해 결과를 보고합니다:

- 알림 단계는 하위 에이전트 세션 내에서 실행됩니다 (요청자 세션이 아님).
- 하위 에이전트가 정확히 `ANNOUNCE_SKIP`이라고 응답하면 아무것도 게시되지 않습니다.
- 그렇지 않으면 알림 응답은 후속 `agent` 호출을 통해 요청자 채팅 채널에 게시됩니다 (`deliver=true`).
- 알림 응답은 사용 가능한 경우 스레드/주제 라우팅을 유지합니다 (Slack 스레드, Telegram 주제, Matrix 스레드).
- 알림 메시지는 안정적인 템플릿으로 정규화됩니다:
  - `Status:` 실행 결과에서 파생됨 (`success`, `error`, `timeout`, 또는 `unknown`).
  - `Result:` 알림 단계의 요약 내용 (또는 누락된 경우 `(not available)`).
  - `Notes:` 오류 세부 사항 및 다른 유용한 컨텍스트.
- `Status`는 모델 출력에서 유추되지 않습니다; 런타임 결과 신호로부터 옴.

알림 페이로드는 끝에 통계 줄을 포함합니다 (감싸진 경우에도):

- 실행 시간 (예: `runtime 5m12s`)
- 토큰 사용량 (입력/출력/전체)
- 모델 가격이 구성된 경우의 추정 비용 (`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId`, 및 전사 경로 (메인 에이전트가 `sessions_history`를 통해 기록을 가져오거나 디스크에서 파일을 확인할 수 있도록)

## 도구 정책 (하위 에이전트 도구)

기본적으로 하위 에이전트는 **세션 도구와 시스템 도구를 제외한 모든 도구**를 받습니다:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

`maxSpawnDepth >= 2`일 때, 깊이 1 오케스트레이터 하위 에이전트는 추가적으로 `sessions_spawn`, `subagents`, `sessions_list`, `sessions_history`를 받아 자신들의 자식을 관리할 수 있습니다.

구성을 통해 재정의하세요:

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // 금지가 우선
        deny: ["gateway", "cron"],
        // 허용이 설정되면, 허용만으로 바뀜 (금지는 여전히 우선)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## 동시성

하위 에이전트는 전용 인프로세스 큐 레인을 사용합니다:

- 레인 이름: `subagent`
- 동시성: `agents.defaults.subagents.maxConcurrent` (기본값 `8`)

## 중지

- 요청자 채팅에서 `/stop`을 보내면 요청자 세션이 멈추고, 생성된 모든 활성 하위 에이전트 실행이 중지되며 중첩된 자식으로 연계됩니다.
- `/subagents kill <id>`는 특정 하위 에이전트를 중지하고 자식으로 연계됩니다.

## 제한 사항

- 하위 에이전트 알림은 **최선을 다해** 실행됩니다. 게이트웨이가 다시 시작되면 보류 중인 "알림 복귀" 작업은 손실됩니다.
- 하위 에이전트는 여전히 동일한 게이트웨이 프로세스 리소스를 공유합니다; `maxConcurrent`를 안전 밸브로 처리하세요.
- `sessions_spawn`은 항상 비차단적입니다: `{ status: "accepted", runId, childSessionKey }`를 즉시 반환합니다.
- 하위 에이전트 컨텍스트는 `AGENTS.md` + `TOOLS.md`만 주입합니다 (`SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, 또는 `BOOTSTRAP.md` 없음).
- 최대 중첩 깊이는 5입니다 (`maxSpawnDepth` 범위: 1-5). 대부분의 사용 사례에 대해 깊이 2가 권장됩니다.
- `maxChildrenPerAgent`는 세션당 활성 자식을 제한합니다 (기본값: 5, 범위: 1-20).
