---
summary: "Sub-agents: 요청자 채팅에 결과를 알려주는 격리된 에이전트 실행 생성"
read_when:
  - 에이전트를 통한 백그라운드/병렬 작업을 원할 때
  - sessions_spawn 또는 sub-agent 도구 정책을 변경할 때
  - 스레드 바운드 subagent 세션을 구현하거나 문제 해결할 때
title: "Sub-agents"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: tools/subagents.md
workflow: 15
---

# Sub-agents

Sub-agents는 기존 에이전트 실행에서 생성된 백그라운드 에이전트 실행입니다. 자신의 세션(`agent:<agentId>:subagent:<uuid>`)에서 실행되며 완료되면 **요청자 채팅 채널로 결과를 알립니다**.

## Slash 커맨드

`/subagents`를 사용하여 **현재 세션**에 대한 sub-agent 실행을 검사하거나 제어합니다:

- `/subagents list`
- `/subagents kill <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`
- `/subagents steer <id|#> <message>`
- `/subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]`

스레드 바인딩 제어:

이들 커맨드는 지속적인 스레드 바인딩을 지원하는 채널에서 작동합니다. 아래의 **스레드 지원 채널**을 참고합니다.

- `/focus <subagent-label|session-key|session-id|session-label>`
- `/unfocus`
- `/agents`
- `/session idle <duration|off>`
- `/session max-age <duration|off>`

`/subagents info`는 메타데이터 실행(상태, 타임스탐프, 세션 ID, 트랜스크립트 경로, 정리)을 표시합니다.

### Spawn 동작

`/subagents spawn`은 내부 리레이가 아닌 사용자 커맨드로 백그라운드 sub-agent를 시작하고 실행이 완료되면 요청자 채팅에 하나의 최종 완료 업데이트를 보냅니다.

- spawn 커맨드는 비 블로킹; 즉시 실행 ID를 반환합니다.
- 완료 시 sub-agent는 요청자 채팅 채널로 요약/결과 메시지를 알립니다.
- 수동 spawn의 경우 전달은 복원력 있음:
  - OpenClaw는 먼저 안정적인 멱등성 키로 직접 `agent` 전달을 시도합니다.
  - 직접 전달이 실패하면 큐 라우팅으로 폴백합니다.
  - 큐 라우팅도 여전히 사용 불가능하면 짧은 지수 백오프 후 재시도를 시도한 후 최종 포기합니다.
- 완료 핸드오프를 요청자 세션으로는 런타임 생성 내부 컨텍스트(사용자 작성 텍스트 아님)이며 다음을 포함:
  - `Result`(어시스턴트 회신 텍스트 또는 어시스턴트 회신이 비어있으면 최신 `toolResult`)
  - `Status`(`completed successfully` / `failed` / `timed out` / `unknown`)
  - 컴팩트 런타임/토큰 통계
  - 요청자 에이전트에 일반 어시스턴트 음성으로 다시 쓰도록 지시하는 전달 지시문(원시 내부 메타데이터 정방향 아님)
- `--model` 및 `--thinking`은 해당 특정 실행의 기본값을 오버라이드합니다.
- 완료 후 `info`/`log`를 사용하여 세부 정보 및 출력을 검사합니다.
- `/subagents spawn`은 일회성 모드(`mode: "run"`). 지속적인 스레드 바운드 세션의 경우 `sessions_spawn`과 함께 `thread: true` 및 `mode: "session"`을 사용합니다.
- ACP harness 세션(Codex, Claude Code, Gemini CLI)의 경우 `sessions_spawn`과 함께 `runtime: "acp"`를 사용하고 [ACP Agents](/tools/acp-agents)를 참고합니다.

기본 목표:

- 주 실행을 차단하지 않고 "research / long task / slow tool" 작업을 병렬화합니다.
- Sub-agents를 기본적으로 격리된 상태로 유지합니다(세션 분리 + 선택적 샌드박싱).
- 도구 표면을 오용하기 어렵게 유지: sub-agents는 기본적으로 세션 도구를 **받지 않습니다**.
- 구성 가능한 중첩 깊이를 지원합니다.

비용 참고: 각 sub-agent는 자신의 **고유** 컨텍스트 및 토큰 사용입니다. 무겁거나 반복적인
작업의 경우 sub-agents용 더 저렴한 모델을 설정하고 주 에이전트를 더 높은 품질 모델에 유지합니다.
`agents.defaults.subagents.model` 또는 에이전트별 오버라이드를 통해 이를 구성할 수 있습니다.

## 도구

`sessions_spawn` 사용:

- Sub-agent 실행을 시작합니다(`deliver: false`, 전역 lane: `subagent`)
- 그런 다음 알림 단계를 실행하고 요청자 채팅 채널에 알림 회신을 게시합니다
- 기본 모델: 호출자를 상속받습니다(`agents.defaults.subagents.model` 또는 에이전트별 `agents.list[].subagents.model` 설정하지 않으면); 명시적 `sessions_spawn.model`이 여전히 이깁니다.
- 기본 사고: 호출자를 상속받습니다(`agents.defaults.subagents.thinking` 또는 에이전트별 `agents.list[].subagents.thinking` 설정하지 않으면); 명시적 `sessions_spawn.thinking`이 여전히 이깁니다.
- 기본 실행 타임아웃: `sessions_spawn.runTimeoutSeconds`가 생략되면 OpenClaw는 `agents.defaults.subagents.runTimeoutSeconds`를 사용합니다(설정된 경우); 그렇지 않으면 `0`(타임아웃 없음)으로 폴백합니다.

도구 파라미터:

- `task`(필수)
- `label?`(선택 사항)
- `agentId?`(선택 사항; 허용된 경우 다른 에이전트 ID에서 spawn)
- `model?`(선택 사항; sub-agent 모델을 오버라이드; 유효하지 않은 값은 건너뜀 및 sub-agent는 기본 모델에서 경고와 함께 실행)
- `thinking?`(선택 사항; sub-agent 실행의 사고 레벨 오버라이드)
- `runTimeoutSeconds?`(기본값 `agents.defaults.subagents.runTimeoutSeconds`(설정된 경우), 그렇지 않으면 `0`; 설정될 때 sub-agent 실행은 N 초 후 중단)
- `thread?`(기본값 `false`; `true`일 때 이 sub-agent 세션에 대한 채널 스레드 바인딩을 요청)
- `mode?`(`run|session`)
  - 기본값은 `run`
  - `thread: true` 및 `mode` 생략하면 기본값은 `session`
  - `mode: "session"`은 `thread: true`를 필요로 함
- `cleanup?`(`delete|keep`, 기본값 `keep`)
- `sandbox?`(`inherit|require`, 기본값 `inherit`; `require`는 대상 자식 런타임이 샌드박스되지 않으면 spawn 거부)

더 많은 정보는 공식 문서를 참고합니다.
