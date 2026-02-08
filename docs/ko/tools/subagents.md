---
summary: "서브 에이전트: 요청자 채널로 결과를 알리는 격리된 에이전트 실행을 스폰합니다"
read_when:
  - 에이전트를 통한 백그라운드/병렬 작업이 필요할 때
  - sessions_spawn 또는 서브 에이전트 도구 정책을 변경할 때
title: "서브 에이전트"
x-i18n:
  source_path: tools/subagents.md
  source_hash: 3c83eeed69a65dbb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:26:44Z
---

# 서브 에이전트

서브 에이전트는 기존 에이전트 실행에서 스폰되는 백그라운드 에이전트 실행입니다. 이들은 자체 세션(`agent:<agentId>:subagent:<uuid>`)에서 실행되며, 완료되면 요청자 채널로 결과를 **알림**합니다.

## 슬래시 명령

**현재 세션**에 대한 서브 에이전트 실행을 검사하거나 제어하려면 `/subagents` 를 사용합니다:

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` 는 실행 메타데이터(상태, 타임스탬프, 세션 id, 트랜스크립트 경로, 정리)를 표시합니다.

주요 목표:

- 메인 실행을 차단하지 않고 “리서치 / 장시간 작업 / 느린 도구” 작업을 병렬화합니다.
- 기본적으로 서브 에이전트를 격리합니다(세션 분리 + 선택적 샌드박스화).
- 도구 표면을 오용하기 어렵게 유지합니다: 서브 에이전트는 기본적으로 세션 도구를 **받지 않습니다**.
- 중첩된 팬아웃을 방지합니다: 서브 에이전트는 서브 에이전트를 스폰할 수 없습니다.

비용 참고: 각 서브 에이전트는 **자체** 컨텍스트와 토큰 사용량을 가집니다. 무겁거나 반복적인 작업의 경우, 서브 에이전트에는 더 저렴한 모델을 설정하고 메인 에이전트는 더 높은 품질의 모델을 유지하십시오. 이는 `agents.defaults.subagents.model` 또는 에이전트별 오버라이드로 구성할 수 있습니다.

## 도구

`sessions_spawn` 를 사용합니다:

- 서브 에이전트 실행을 시작합니다(`deliver: false`, 글로벌 레인: `subagent`).
- 이후 알림 단계를 실행하고 알림 응답을 요청자 채널로 게시합니다.
- 기본 모델: `agents.defaults.subagents.model` (또는 에이전트별 `agents.list[].subagents.model`)를 설정하지 않는 한 호출자를 상속합니다. 명시적인 `sessions_spawn.model` 가 있으면 그것이 우선합니다.
- 기본 사고 수준: `agents.defaults.subagents.thinking` (또는 에이전트별 `agents.list[].subagents.thinking`)를 설정하지 않는 한 호출자를 상속합니다. 명시적인 `sessions_spawn.thinking` 가 있으면 그것이 우선합니다.

도구 파라미터:

- `task` (필수)
- `label?` (선택)
- `agentId?` (선택; 허용된 경우 다른 에이전트 id 하위로 스폰)
- `model?` (선택; 서브 에이전트 모델을 오버라이드합니다. 유효하지 않은 값은 건너뛰며, 도구 결과에 경고와 함께 기본 모델로 실행됩니다)
- `thinking?` (선택; 서브 에이전트 실행의 사고 수준을 오버라이드)
- `runTimeoutSeconds?` (기본값 `0`; 설정 시 N초 후 서브 에이전트 실행이 중단됩니다)
- `cleanup?` (`delete|keep`, 기본값 `keep`)

허용 목록:

- `agents.list[].subagents.allowAgents`: `agentId` 를 통해 타깃팅할 수 있는 에이전트 id 목록(`["*"]` 로 모두 허용). 기본값: 요청자 에이전트만 허용.

디스커버리:

- `agents_list` 를 사용하여 현재 `sessions_spawn` 에 허용된 에이전트 id 를 확인합니다.

자동 아카이브:

- 서브 에이전트 세션은 `agents.defaults.subagents.archiveAfterMinutes` 이후 자동으로 아카이브됩니다(기본값: 60).
- 아카이브는 `sessions.delete` 를 사용하며 트랜스크립트를 `*.deleted.<timestamp>` 로 이름 변경합니다(동일 폴더).
- `cleanup: "delete"` 는 알림 직후 즉시 아카이브합니다(이름 변경을 통해 트랜스크립트는 유지).
- 자동 아카이브는 최선 노력 방식입니다. 게이트웨이가 재시작되면 대기 중인 타이머는 손실됩니다.
- `runTimeoutSeconds` 는 자동 아카이브하지 않습니다. 실행만 중지하며, 세션은 자동 아카이브 시점까지 유지됩니다.

## 인증

서브 에이전트 인증은 세션 유형이 아니라 **에이전트 id** 로 해결됩니다:

- 서브 에이전트 세션 키는 `agent:<agentId>:subagent:<uuid>` 입니다.
- 인증 스토어는 해당 에이전트의 `agentDir` 에서 로드됩니다.
- 메인 에이전트의 인증 프로필은 **폴백**으로 병합됩니다. 충돌 시 에이전트 프로필이 메인 프로필을 덮어씁니다.

참고: 병합은 가산적이므로 메인 프로필은 항상 폴백으로 사용 가능합니다. 에이전트별 완전한 격리 인증은 아직 지원되지 않습니다.

## 알림

서브 에이전트는 알림 단계를 통해 결과를 보고합니다:

- 알림 단계는 요청자 세션이 아닌 서브 에이전트 세션 내부에서 실행됩니다.
- 서브 에이전트가 정확히 `ANNOUNCE_SKIP` 로 응답하면 아무 것도 게시되지 않습니다.
- 그렇지 않으면 알림 응답이 후속 `agent` 호출(`deliver=true`)을 통해 요청자 채널로 게시됩니다.
- 알림 응답은 가능한 경우 스레드/토픽 라우팅을 유지합니다(Slack 스레드, Telegram 토픽, Matrix 스레드).
- 알림 메시지는 안정적인 템플릿으로 정규화됩니다:
  - 실행 결과(`success`, `error`, `timeout`, 또는 `unknown`)에서 파생된 `Status:`.
  - 알림 단계의 요약 내용인 `Result:`(없으면 `(not available)`).
  - 오류 세부 정보 및 기타 유용한 컨텍스트인 `Notes:`.
- `Status` 는 모델 출력에서 추론되지 않으며, 런타임 결과 신호에서 가져옵니다.

알림 페이로드에는 끝에 통계 줄이 포함됩니다(래핑되었을 때도 포함):

- 실행 시간(예: `runtime 5m12s`)
- 토큰 사용량(입력/출력/총합)
- 모델 가격이 구성된 경우의 예상 비용(`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId`, 및 트랜스크립트 경로(메인 에이전트가 `sessions_history` 를 통해 기록을 가져오거나 디스크의 파일을 검사할 수 있도록)

## 도구 정책(서브 에이전트 도구)

기본적으로 서브 에이전트는 **세션 도구를 제외한 모든 도구**를 받습니다:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

구성을 통해 오버라이드:

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

서브 에이전트는 전용 인프로세스 큐 레인을 사용합니다:

- 레인 이름: `subagent`
- 동시성: `agents.defaults.subagents.maxConcurrent` (기본값 `8`)

## 중지

- 요청자 채널에서 `/stop` 를 전송하면 요청자 세션이 중단되고, 그로부터 스폰된 활성 서브 에이전트 실행이 모두 중지됩니다.

## 제한 사항

- 서브 에이전트 알림은 **최선 노력**입니다. 게이트웨이가 재시작되면 대기 중인 “알림 반환” 작업은 손실됩니다.
- 서브 에이전트는 동일한 게이트웨이 프로세스 리소스를 공유합니다. `maxConcurrent` 를 안전 밸브로 취급하십시오.
- `sessions_spawn` 는 항상 비차단입니다. 즉시 `{ status: "accepted", runId, childSessionKey }` 를 반환합니다.
- 서브 에이전트 컨텍스트는 `AGENTS.md` + `TOOLS.md` 만 주입합니다(`SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, 또는 `BOOTSTRAP.md` 는 없음).
