---
read_when:
    - 에이전트를 통해 백그라운드/병렬 작업을 원합니다.
    - session_spawn 또는 하위 에이전트 도구 정책을 변경 중입니다.
summary: '하위 에이전트: 요청자 채팅에 결과를 다시 알리는 격리된 에이전트 실행 생성'
title: 하위 에이전트
x-i18n:
    generated_at: "2026-02-08T16:07:08Z"
    model: gtx
    provider: google-translate
    source_hash: 3c83eeed69a65dbbb6b21a386f3ac363d3ef8f077f0e03b834c3f0a9911dca7c
    source_path: tools/subagents.md
    workflow: 15
---

# 하위 에이전트

하위 에이전트는 기존 에이전트 실행에서 생성된 백그라운드 에이전트 실행입니다. 그들은 자신의 세션에서 실행됩니다(`agent:<agentId>:subagent:<uuid>`) 그리고 완료되면, **발표하다** 그 결과는 요청자 채팅 채널로 다시 전송됩니다.

## 슬래시 명령

사용 `/subagents` 하위 에이전트 실행을 검사하거나 제어하려면 **현재 세션**:

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` 실행 메타데이터(상태, 타임스탬프, 세션 ID, 기록 경로, 정리)를 표시합니다.

주요 목표:

- 메인 실행을 방해하지 않고 "연구/장시간 작업/느린 도구" 작업을 병렬화합니다.
- 기본적으로 하위 에이전트를 격리된 상태로 유지합니다(세션 분리 + 선택적 샌드박싱).
- 도구 표면을 오용하기 어렵게 유지: 하위 에이전트가 수행합니다. **~ 아니다** 기본적으로 세션 도구를 가져옵니다.
- 중첩된 팬아웃 방지: 하위 에이전트는 하위 에이전트를 생성할 수 없습니다.

비용 참고 사항: 각 하위 에이전트에는 **소유하다** 컨텍스트 및 토큰 사용. 무겁거나 반복적인 작업의 경우
작업을 수행하려면 하위 에이전트에 대해 더 저렴한 모델을 설정하고 주 에이전트를 더 높은 품질의 모델로 유지하세요.
다음을 통해 이를 구성할 수 있습니다. `agents.defaults.subagents.model` 또는 에이전트별 재정의.

## 도구

사용 `sessions_spawn`:

- 하위 에이전트 실행을 시작합니다(`deliver: false`, 글로벌 레인: `subagent`)
- 그런 다음 공지 단계를 실행하고 공지 응답을 요청자 채팅 채널에 게시합니다.
- 기본 모델: 설정하지 않는 한 호출자를 상속합니다. `agents.defaults.subagents.model` (또는 에이전트당 `agents.list[].subagents.model`); 명시적인 `sessions_spawn.model` 여전히 승리합니다.
- 기본 생각: 설정하지 않는 한 호출자를 상속합니다. `agents.defaults.subagents.thinking` (또는 에이전트당 `agents.list[].subagents.thinking`); 명시적인 `sessions_spawn.thinking` 여전히 승리합니다.

도구 매개변수:

- `task` (필수의)
- `label?` (선택 과목)
- `agentId?` (선택 사항, 허용되는 경우 다른 에이전트 ID로 생성)
- `model?` (선택 사항, 하위 에이전트 모델을 재정의합니다. 잘못된 값은 건너뛰고 하위 에이전트는 도구 결과에 경고가 표시되는 기본 모델에서 실행됩니다.)
- `thinking?` (선택 사항, 하위 에이전트 실행에 대한 사고 수준을 재정의함)
- `runTimeoutSeconds?` (기본 `0`; 설정하면 N초 후에 하위 에이전트 실행이 중단됩니다.
- `cleanup?` (`delete|keep`, 기본 `keep`)

허용 목록:

- `agents.list[].subagents.allowAgents`: 다음을 통해 타겟팅할 수 있는 에이전트 ID 목록 `agentId` (`["*"]` 허용하려면). 기본값: 요청자 에이전트만.

발견:

- 사용 `agents_list` 현재 어떤 에이전트 ID가 허용되는지 확인하려면 `sessions_spawn`.

자동 보관:

- 하위 에이전트 세션은 다음 이후에 자동으로 보관됩니다. `agents.defaults.subagents.archiveAfterMinutes` (기본값: 60).
- 아카이브 용도 `sessions.delete` 성적표의 이름을 다음으로 바꿉니다. `*.deleted.<timestamp>` (같은 폴더).
- `cleanup: "delete"` 발표 직후 보관합니다(이름 변경을 통해 기록을 계속 유지합니다).
- 자동 보관은 최선의 노력입니다. 게이트웨이가 다시 시작되면 보류 중인 타이머가 손실됩니다.
- `runTimeoutSeconds` 하다 **~ 아니다** 자동 보관; 실행만 중지됩니다. 세션은 자동 보관될 때까지 유지됩니다.

## 입증

하위 에이전트 인증은 다음에 의해 해결됩니다. **에이전트 ID**, 세션 유형이 아닌:

- 하위 에이전트 세션 키는 다음과 같습니다. `agent:<agentId>:subagent:<uuid>`.
- 인증 저장소는 해당 에이전트의 저장소에서 로드됩니다. `agentDir`.
- 주 에이전트의 인증 프로필은 다음과 같이 병합됩니다. **대체**; 에이전트 프로필은 충돌 시 기본 프로필보다 우선 적용됩니다.

참고: 병합은 추가되므로 기본 프로필은 항상 대체 항목으로 사용할 수 있습니다. 에이전트별로 완전히 격리된 인증은 아직 지원되지 않습니다.

## 발표하다

하위 에이전트는 공지 단계를 통해 다시 보고합니다.

- 알림 단계는 하위 에이전트 세션(요청자 세션 아님) 내에서 실행됩니다.
- 하위 에이전트가 정확하게 응답하는 경우 `ANNOUNCE_SKIP`, 아무것도 게시되지 않았습니다.
- 그렇지 않으면 공지 답변이 후속 조치를 통해 요청자 채팅 채널에 게시됩니다. `agent` 부르다 (`deliver=true`).
- 응답 발표는 사용 가능한 경우 스레드/주제 라우팅을 유지합니다(Slack 스레드, Telegram 주제, Matrix 스레드).
- 공지 메시지는 안정적인 템플릿으로 정규화됩니다.
  - `Status:` 실행 결과에서 파생됨(`success`, `error`, `timeout`, 또는 `unknown`).
  - `Result:` 발표 단계의 요약 내용(또는 `(not available)` 누락된 경우).
  - `Notes:` 오류 세부 정보 및 기타 유용한 컨텍스트.
- `Status` 모델 출력에서 ​​추론되지 않습니다. 이는 런타임 결과 신호에서 비롯됩니다.

Announce 페이로드에는 끝에 통계 줄이 포함됩니다(래핑된 경우에도).

- 런타임(예: `runtime 5m12s`)
- 토큰 사용량(입력/출력/전체)
- 모델 가격 책정 구성 시 예상 비용(`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId`및 성적표 경로(주 에이전트가 다음을 통해 기록을 가져올 수 있도록) `sessions_history` 또는 디스크의 파일을 검사합니다)

## 도구 정책(하위 에이전트 도구)

기본적으로 하위 에이전트는 **세션 도구를 제외한 모든 도구**:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

구성을 통해 재정의:

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
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## 동시성

하위 에이전트는 전용 처리 중인 대기열 레인을 사용합니다.

- 차선 이름: `subagent`
- 동시성: `agents.defaults.subagents.maxConcurrent` (기본 `8`)

## 멎는

- 배상 `/stop` 요청자 채팅에서 요청자 세션을 중단하고 해당 세션에서 생성된 활성 하위 에이전트 실행을 중지합니다.

## 제한사항

- 하위 에이전트 발표는 다음과 같습니다. **최선의 노력**. 게이트웨이가 다시 시작되면 보류 중인 "다시 공지" 작업이 손실됩니다.
- 하위 에이전트는 여전히 동일한 게이트웨이 프로세스 리소스를 공유합니다. 대하다 `maxConcurrent` 안전 밸브로.
- `sessions_spawn` 항상 비차단입니다: 반환합니다. `{ status: "accepted", runId, childSessionKey }` 즉시.
- 하위 에이전트 컨텍스트는 삽입만 합니다. `AGENTS.md` + `TOOLS.md` (아니요 `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, 또는 `BOOTSTRAP.md`).
